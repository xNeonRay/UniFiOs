'use strict';

const db = require('../config/database');

/**
 * Voucher model — manages the vouchers and their redemption history.
 *
 * Business rules:
 *  - A voucher never expires for redemption (no redeem-by date).
 *  - Once redeemed, the authorization lasts `duration_minutes` from redemption.
 *  - `max_uses` controls how many times the same code can be used (usually 1).
 *  - `restricted_mac` — if set, ONLY that MAC can redeem the voucher.
 *  - Admin-created vouchers may have `restricted_mac = null` (any MAC).
 */
const Voucher = {
  /**
   * Find a voucher by its code.
   * @param {string} code
   * @returns {object|undefined}
   */
  findByCode(code) {
    return db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code.toUpperCase());
  },

  /**
   * List all vouchers, optionally filtered by status.
   * @param {string} [status]  'active' | 'depleted' | 'revoked'
   * @returns {object[]}
   */
  list(status) {
    if (status) {
      return db.prepare('SELECT * FROM vouchers WHERE status = ? ORDER BY created_at DESC').all(status);
    }
    return db.prepare('SELECT * FROM vouchers ORDER BY created_at DESC').all();
  },

  /**
   * Create a new voucher.
   *
   * @param {object} params
   * @param {string}  params.code
   * @param {string}  [params.description]
   * @param {number}  [params.max_uses=1]
   * @param {number}  [params.duration_minutes]   null = unlimited
   * @param {string}  [params.restricted_mac]     null = any MAC
   * @param {number}  [params.up_kbps]
   * @param {number}  [params.down_kbps]
   * @param {number}  [params.quota_mb]
   * @param {string}  [params.created_by='admin']
   * @returns {object}
   */
  create({
    code,
    description = null,
    max_uses = 1,
    duration_minutes = null,
    restricted_mac = null,
    up_kbps = null,
    down_kbps = null,
    quota_mb = null,
    created_by = 'admin',
  }) {
    const upper = code.toUpperCase();
    const restrictedUpper = restricted_mac ? restricted_mac.toUpperCase() : null;

    db.prepare(`
      INSERT INTO vouchers
        (code, description, max_uses, duration_minutes, restricted_mac,
         up_kbps, down_kbps, quota_mb, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(upper, description, max_uses, duration_minutes, restrictedUpper,
           up_kbps, down_kbps, quota_mb, created_by);

    return this.findByCode(upper);
  },

  /**
   * Validate that a voucher can be redeemed by the given MAC address.
   *
   * Returns an object: { valid: boolean, reason?: string, voucher?: object }
   *
   * @param {string} code
   * @param {string} mac   Upper-case colon-separated MAC
   * @returns {{ valid: boolean, reason?: string, voucher?: object }}
   */
  validate(code, mac) {
    const voucher = this.findByCode(code);

    if (!voucher) {
      return { valid: false, reason: 'Voucher not found' };
    }

    if (voucher.status === 'revoked') {
      return { valid: false, reason: 'Voucher has been revoked', voucher };
    }

    if (voucher.status === 'depleted') {
      return { valid: false, reason: 'Voucher has reached its maximum uses', voucher };
    }

    if (voucher.used_count >= voucher.max_uses) {
      return { valid: false, reason: 'Voucher has reached its maximum uses', voucher };
    }

    if (voucher.restricted_mac && voucher.restricted_mac !== mac.toUpperCase()) {
      return { valid: false, reason: 'Voucher is restricted to a different device', voucher };
    }

    return { valid: true, voucher };
  },

  /**
   * Consume one use of the voucher and record redemption history.
   *
   * Wrapped in a transaction. Returns the created history row.
   *
   * @param {string} code
   * @param {string} mac
   * @param {string} site
   * @param {object} [meta]   Additional metadata (ip_address, user_agent)
   * @returns {{ voucher: object, history: object, sessionEndTime: string|null }}
   */
  redeem(code, mac, site, { ip_address = null, user_agent = null } = {}) {
    const upper = code.toUpperCase();

    return db.transaction(() => {
      const voucher = this.findByCode(upper);

      // Compute session end time
      let sessionEnd = null;
      if (voucher.duration_minutes != null) {
        const end = new Date(Date.now() + voucher.duration_minutes * 60 * 1000);
        sessionEnd = end.toISOString();
      }

      // Increment used_count; mark depleted if exhausted
      const newUsed = voucher.used_count + 1;
      const newStatus = newUsed >= voucher.max_uses ? 'depleted' : 'active';

      db.prepare(`
        UPDATE vouchers
        SET used_count = ?,
            status     = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE code = ?
      `).run(newUsed, newStatus, upper);

      // Record history
      const histResult = db.prepare(`
        INSERT INTO voucher_history
          (voucher_code, mac_address, site_name, session_end, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(upper, mac.toUpperCase(), site, sessionEnd, ip_address, user_agent);

      const history = db.prepare('SELECT * FROM voucher_history WHERE id = ?')
        .get(histResult.lastInsertRowid);

      return {
        voucher: this.findByCode(upper),
        history,
        sessionEndTime: sessionEnd,
      };
    })();
  },

  /**
   * Revoke a voucher (admin action).
   * @param {string} code
   * @returns {boolean}  true if the voucher was found and updated
   */
  revoke(code) {
    const result = db.prepare(`
      UPDATE vouchers
      SET status     = 'revoked',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE code = ?
    `).run(code.toUpperCase());
    return result.changes > 0;
  },

  /**
   * Get all redemption history entries.
   * @param {string} [code]  Filter by voucher code
   * @param {string} [mac]   Filter by MAC address
   * @returns {object[]}
   */
  getHistory({ code, mac } = {}) {
    if (code && mac) {
      return db.prepare(`
        SELECT * FROM voucher_history
        WHERE voucher_code = ? AND mac_address = ?
        ORDER BY redeemed_at DESC
      `).all(code.toUpperCase(), mac.toUpperCase());
    }
    if (code) {
      return db.prepare(`
        SELECT * FROM voucher_history WHERE voucher_code = ? ORDER BY redeemed_at DESC
      `).all(code.toUpperCase());
    }
    if (mac) {
      return db.prepare(`
        SELECT * FROM voucher_history WHERE mac_address = ? ORDER BY redeemed_at DESC
      `).all(mac.toUpperCase());
    }
    return db.prepare('SELECT * FROM voucher_history ORDER BY redeemed_at DESC').all();
  },
};

module.exports = Voucher;
