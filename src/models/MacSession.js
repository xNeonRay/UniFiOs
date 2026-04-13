'use strict';

const db = require('../config/database');

/**
 * MacSession model — thin wrapper around the active_mac_sessions table.
 *
 * Column naming:
 *  - site_ref   → internalReference slug (e.g. "default", "9kjh0hv4")
 *                 used in command API path: /proxy/network/api/s/{site_ref}/cmd/stamgr
 *  - site_uuid  → UUID from integration/v1 API (optional but stored when available)
 *
 * This is the "source of truth" for authorization state.
 * When an AP reboots and loses its iptables cache, this table lets us silently
 * re-authorize the client without showing the portal again.
 */
const MacSession = {
  /**
   * Find the most recent *active* session for a MAC address.
   * A session is active when status = 'active' AND end_time > now().
   *
   * @param {string} mac          Upper-case colon-separated MAC
   * @param {string} [siteRef]    internalReference slug filter (optional)
   * @returns {object|undefined}
   */
  findActive(mac, siteRef) {
    const normalized = mac.toUpperCase();
    if (siteRef) {
      return db.prepare(`
        SELECT * FROM active_mac_sessions
        WHERE mac_address = ?
          AND site_ref    = ?
          AND status      = 'active'
          AND end_time    > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY end_time DESC
        LIMIT 1
      `).get(normalized, siteRef);
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
   * @param {string}  params.site_ref      internalReference slug
   * @param {string}  params.end_time      ISO-8601 string
   * @param {string}  [params.site_uuid]   UUID from integration/v1 (optional)
   * @param {string}  [params.voucher_code]
   * @param {string}  [params.ap_mac]
   * @returns {object}  The newly created row
   */
  create({ mac_address, site_ref, end_time, site_uuid = null, voucher_code = null, ap_mac = null }) {
    const normalized = mac_address.toUpperCase();
    const stmt = db.prepare(`
      INSERT INTO active_mac_sessions
        (mac_address, site_ref, end_time, site_uuid, voucher_code, ap_mac)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(normalized, site_ref, end_time, site_uuid, voucher_code, ap_mac);
    return db.prepare('SELECT * FROM active_mac_sessions WHERE id = ?').get(result.lastInsertRowid);
  },

  /**
   * Increment reauth_count for a session (called on every AP-cache silent re-auth).
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
   * @param {string} [siteRef]  internalReference slug filter (optional)
   */
  expireByMac(mac, siteRef) {
    const normalized = mac.toUpperCase();
    if (siteRef) {
      db.prepare(`
        UPDATE active_mac_sessions
        SET status     = 'expired',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE mac_address = ? AND site_ref = ? AND status = 'active'
      `).run(normalized, siteRef);
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
