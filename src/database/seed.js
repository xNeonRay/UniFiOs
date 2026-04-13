'use strict';

require('dotenv').config();
const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Seeds demo data: sites and sample vouchers.
 * Only inserts rows that don't already exist.
 */
function seed() {
  const insertSite = db.prepare(`
    INSERT OR IGNORE INTO sites (internal_reference, name) VALUES (?, ?)
  `);

  const insertVoucher = db.prepare(`
    INSERT OR IGNORE INTO vouchers
      (code, description, max_uses, duration_minutes, restricted_mac, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    // Default sites — update internal_reference to match your actual UniFi site slugs
    insertSite.run('default', 'Default');
    insertSite.run('9kjh0hv4', 'Uniprint');
    insertSite.run('snay2t2o', 'AntiguaDY');

    // Sample single-use voucher — 1 day (1440 min), any MAC
    insertVoucher.run('DEMO-0001', 'Demo 1-day pass',     1, 1440,   null,           'seeder');
    // Sample 3-use voucher — 7 days (10080 min), any MAC
    insertVoucher.run('DEMO-0002', 'Demo 7-day 3-use',    3, 10080,  null,           'seeder');
    // Sample single-use voucher — 30 days, restricted to a specific MAC
    insertVoucher.run('DEMO-0003', 'MAC-locked 30-day',   1, 43200, 'AA:BB:CC:DD:EE:FF', 'seeder');
    // Admin voucher — unlimited duration, no MAC restriction
    insertVoucher.run('ADMIN-UNLIMITED', 'Unlimited admin pass', 1, null, null, 'admin');
  })();

  console.log('[seed] Demo data inserted / verified.');
}

seed();
