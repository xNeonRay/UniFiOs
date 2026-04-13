'use strict';

const db = require('../config/database');

/**
 * MacSession model — thin wrapper around the active_mac_sessions table.
 *
 * This is the "source of truth" for client authorization state.
 * When an AP reboots and loses its iptables cache, we use this table to
 * silently re-authorize the client without showing the portal again.
 */
const MacSession = {
  /**
   * Find the most recent *active* session for a MAC address.
   * A session is active when status = 'active' AND end_time > now().
   *
   * @param {string} mac   Upper-case colon-separated MAC
   * @param {string} [site] Optional site filter
   * @returns {object|undefined}
   */
  findActive(mac, site) {
    const normalized = mac.toUpperCase();
    if (site) {
      return db.prepare(`
        SELECT * FROM active_mac_sessions
        WHERE mac_address = ?
          AND site_name   = ?
          AND status      = 'active'
          AND end_time    > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY end_time DESC
        LIMIT 1
      `).get(normalized, site);
    }
    return db.prepare(`
      SELECT * FROM active_mac_sessions
      WHERE mac_address = ?
        AND status      = 'active'
        AND end_time    > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ORDER BY end_time DESC
      LIMIT 1
    `).get(normalized);
  },

  /**
   * Find all active sessions for a MAC (across all sites).
   * @param {string} mac
   * @returns {object[]}
   */
  findAllActive(mac) {
    return db.prepare(`
      SELECT * FROM active_mac_sessions
      WHERE mac_address = ?
        AND status      = 'active'
        AND end_time    > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ORDER BY end_time DESC
    `).all(mac.toUpperCase());
  },

  /**
   * Create a new session record.
   *
   * @param {object} params
   * @param {string}  params.mac_address
   * @param {string}  params.site_name
   * @param {string}  params.end_time      ISO-8601 string
   * @param {string}  [params.voucher_code]
   * @param {string}  [params.ap_mac]
   * @returns {object}  The newly created row
   */
  create({ mac_address, site_name, end_time, voucher_code = null, ap_mac = null }) {
    const normalized = mac_address.toUpperCase();
    const stmt = db.prepare(`
      INSERT INTO active_mac_sessions
        (mac_address, site_name, end_time, voucher_code, ap_mac)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(normalized, site_name, end_time, voucher_code, ap_mac);
    return db.prepare('SELECT * FROM active_mac_sessions WHERE id = ?').get(result.lastInsertRowid);
  },

  /**
   * Increment the reauth_count and update updated_at for a session.
   * Called every time an AP-cache bug triggers a silent re-auth.
   * @param {number} id
   */
  recordReauth(id) {
    db.prepare(`
      UPDATE active_mac_sessions
      SET reauth_count = reauth_count + 1,
          updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
  },

  /**
   * Mark a session as 'expired' or 'revoked'.
   * @param {number} id
   * @param {'expired'|'revoked'} status
   */
  updateStatus(id, status) {
    db.prepare(`
      UPDATE active_mac_sessions
      SET status     = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(status, id);
  },

  /**
   * Mark ALL active sessions for a MAC as expired.
   * @param {string} mac
   * @param {string} [site]
   */
  expireByMac(mac, site) {
    const normalized = mac.toUpperCase();
    if (site) {
      db.prepare(`
        UPDATE active_mac_sessions
        SET status     = 'expired',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE mac_address = ? AND site_name = ? AND status = 'active'
      `).run(normalized, site);
    } else {
      db.prepare(`
        UPDATE active_mac_sessions
        SET status     = 'expired',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE mac_address = ? AND status = 'active'
      `).run(normalized);
    }
  },

  /**
   * Expire sessions whose end_time has passed (maintenance task).
   * @returns {number} Number of rows updated
   */
  expireStale() {
    const result = db.prepare(`
      UPDATE active_mac_sessions
      SET status     = 'expired',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'active'
        AND end_time <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run();
    return result.changes;
  },
};

module.exports = MacSession;
