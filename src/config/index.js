'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  unifi: {
    ip: process.env.UNIFI_IP || '192.168.1.1',
    /** HTTPS port of the UniFi OS web UI (commonly 443 or 11443). */
    controllerPort: parseInt(process.env.UNIFI_PORT || '443', 10),
    apiKey: process.env.UNIFI_API_KEY || '',
    ignoreSSL: process.env.UNIFI_IGNORE_SSL !== 'false',

    /**
     * Site UUIDs from integration/v1 API.
     * GET /proxy/network/integration/v1/sites/{topSiteId}/devices → "id" field.
     * Used for integration/v1 read endpoints.
     * @type {string[]}
     */
    siteIds: (process.env.UNIFI_SITE_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /**
     * Site internalReferences (slugs) matching siteIds order.
     * Used for stamgr command endpoints:
     *   POST /proxy/network/api/s/{internalReference}/cmd/stamgr
     * @type {string[]}
     */
    siteRefs: (process.env.UNIFI_SITE_REFS || 'default')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /**
     * Top-level site ID (from GET /proxy/network/integration/v1/sites).
     * Required to call /integration/v1/sites/{topSiteId}/devices.
     * Leave blank to auto-discover from the first result.
     */
    topSiteId: process.env.UNIFI_TOP_SITE_ID || '',
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
