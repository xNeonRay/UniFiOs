'use strict';

require('dotenv').config();
const db = require('../config/database');

/**
 * Runs all DDL migrations in a single transaction.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
function migrate() {
  db.exec(`
    -- -------------------------------------------------------
    -- Sites table  (multi-site support)
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sites (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      -- UUID from integration/v1 API  (e.g. "001df191-5339-306a-a370-2875d376b630")
      site_uuid         TEXT    UNIQUE,
      -- Slug used in command API path  (e.g. "default", "9kjh0hv4")
      internal_reference TEXT   NOT NULL UNIQUE,
      name              TEXT,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- -------------------------------------------------------
    -- Active MAC sessions (source of truth for the AP cache fix)
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS active_mac_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      mac_address       TEXT    NOT NULL,          -- client MAC (upper-case, colon-sep)
      -- Site reference columns (at least one must be present)
      site_ref          TEXT    NOT NULL,           -- internalReference slug
      site_uuid         TEXT,                       -- UUID from integration/v1 (optional)
      voucher_code      TEXT    REFERENCES vouchers(code) ON DELETE SET NULL,
      start_time        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      end_time          TEXT    NOT NULL,           -- ISO-8601, when authorization expires
      status            TEXT    NOT NULL DEFAULT 'active'
                                  CHECK(status IN ('active','expired','revoked')),
      ap_mac            TEXT,                       -- optional: MAC of the AP client joined
      reauth_count      INTEGER NOT NULL DEFAULT 0, -- AP-cache bug reauth counter
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_mac_sessions_mac
      ON active_mac_sessions(mac_address);

    CREATE INDEX IF NOT EXISTS idx_mac_sessions_status_end
      ON active_mac_sessions(status, end_time);

    -- -------------------------------------------------------
    -- Vouchers
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS vouchers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT    NOT NULL UNIQUE,  -- human-readable code, e.g. "ABCD-1234"
      description     TEXT,
      max_uses        INTEGER NOT NULL DEFAULT 1,  -- 1 = single-use; can be 3, 4, etc.
      used_count      INTEGER NOT NULL DEFAULT 0,
      -- Authorization duration in minutes (e.g. 525600 = 365 days).
      -- NULL = unlimited.
      duration_minutes INTEGER,
      -- If set, this voucher can ONLY be redeemed by this MAC address.
      -- NULL = redeemable by any MAC (admin-created vouchers).
      restricted_mac  TEXT,
      -- Bandwidth limits (NULL = unlimited, as defined by the UniFi user group)
      up_kbps         INTEGER,
      down_kbps       INTEGER,
      -- Quota in MB (NULL = unlimited)
      quota_mb        INTEGER,
      -- Voucher never expires for redemption (created_at has no bearing on validity).
      -- 'active' = available, 'depleted' = max_uses reached, 'revoked' = admin cancelled.
      status          TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active','depleted','revoked')),
      created_by      TEXT    NOT NULL DEFAULT 'system',  -- admin identifier
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vouchers_code   ON vouchers(code);
    CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);

    -- -------------------------------------------------------
    -- Voucher redemption history
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS voucher_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_code    TEXT    NOT NULL REFERENCES vouchers(code) ON DELETE RESTRICT,
      mac_address     TEXT    NOT NULL,
      site_name       TEXT    NOT NULL,
      redeemed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- Computed end_time stored for auditing
      session_end     TEXT,
      ip_address      TEXT,
      user_agent      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vh_voucher ON voucher_history(voucher_code);
    CREATE INDEX IF NOT EXISTS idx_vh_mac     ON voucher_history(mac_address);
  `);

  console.log('[migrate] All tables created / verified.');
}

migrate();
