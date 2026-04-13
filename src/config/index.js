'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  unifi: {
    ip: process.env.UNIFI_IP || '192.168.1.1',
    apiKey: process.env.UNIFI_API_KEY || '',
    defaultSite: process.env.UNIFI_DEFAULT_SITE || 'default',
    ignoreSSL: process.env.UNIFI_IGNORE_SSL !== 'false',
    /**
     * Parsed list of site names managed by this portal.
     * A voucher redemption will authorize the MAC on every site in this list.
     * @type {string[]}
     */
    sites: (process.env.UNIFI_SITES || 'default')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  db: {
    path: process.env.DB_PATH || './data/unifi_portal.sqlite',
  },

  admin: {
    secret: process.env.ADMIN_SECRET || '',
  },

  portal: {
    redirectUrl: process.env.PORTAL_REDIRECT_URL || 'https://www.google.com',
    pollIntervalMs: parseInt(process.env.PORTAL_POLL_INTERVAL_MS || '2000', 10),
    pollMaxRetries: parseInt(process.env.PORTAL_POLL_MAX_RETRIES || '15', 10),
  },
};
