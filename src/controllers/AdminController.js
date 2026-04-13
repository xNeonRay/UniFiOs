'use strict';

const { validationResult } = require('express-validator');
const MacSession = require('../models/MacSession');
const Voucher = require('../models/Voucher');
const UnifiNetworkService = require('../services/UnifiNetworkService');
const config = require('../config');

/**
 * AdminController
 *
 * Low-level network and session management endpoints for administrators.
 * All routes require the adminAuth middleware.
 */
const AdminController = {
  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * GET /admin/sessions?mac=&site=
   * List active sessions (optionally filtered).
   */
  listSessions(req, res) {
    const { mac, site } = req.query;
    let rows;
    if (mac) {
      rows = MacSession.findAllActive(mac);
    } else if (site) {
      const db = require('../config/database');
      rows = db.prepare(`
        SELECT * FROM active_mac_sessions
        WHERE site_name = ?
          AND status    = 'active'
          AND end_time  > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY end_time DESC
      `).all(site);
    } else {
      const db = require('../config/database');
      rows = db.prepare(`
        SELECT * FROM active_mac_sessions
        WHERE status   = 'active'
          AND end_time > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY end_time DESC
      `).all();
    }
    return res.json({ count: rows.length, sessions: rows });
  },

  /**
   * DELETE /admin/sessions/:mac
   * Revoke all active sessions for a MAC and unauthorize on all sites.
   */
  async revokeSession(req, res) {
    const { mac } = req.params;
    const sites = config.unifi.sites;
    const results = [];

    for (const site of sites) {
      const unifi = new UnifiNetworkService(site);
      try {
        await unifi.unauthorizeGuest(mac);
        results.push({ site, success: true });
      } catch (err) {
        results.push({ site, success: false, error: err.message });
      }
    }

    MacSession.expireByMac(mac);

    return res.json({ status: 'revoked', mac: mac.toUpperCase(), sites: results });
  },

  /**
   * POST /admin/sessions/cleanup
   * Mark all stale (expired) sessions as expired in the DB.
   */
  cleanup(req, res) {
    const count = MacSession.expireStale();
    return res.json({ status: 'ok', expired: count });
  },

  // ─── UniFi passthrough ─────────────────────────────────────────────────────

  /**
   * GET /admin/unifi/clients?site=default
   * Proxy: list currently connected clients on a site.
   */
  async listClients(req, res) {
    const site = req.query.site || config.unifi.defaultSite;
    try {
      const unifi = new UnifiNetworkService(site);
      const clients = await unifi.listClients();
      return res.json({ site, count: clients.length, clients });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * GET /admin/unifi/clients/:mac?site=default
   * Proxy: get stats for a specific client.
   */
  async getClient(req, res) {
    const site = req.query.site || config.unifi.defaultSite;
    try {
      const unifi = new UnifiNetworkService(site);
      const client = await unifi.getClientStat(req.params.mac);
      if (!client) return res.status(404).json({ error: 'Client not found on site' });
      return res.json({ site, client });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * GET /admin/unifi/sites
   * Proxy: list all UniFi sites on the controller.
   */
  async listSites(req, res) {
    try {
      const unifi = new UnifiNetworkService();
      const sites = await unifi.listSites();
      return res.json({ count: sites.length, sites });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * POST /admin/unifi/authorize
   * Body: { mac, site, minutes, up_kbps, down_kbps, quota_mb }
   * Manually authorize a MAC without a voucher (admin use).
   */
  async authorize(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'Validation failed', details: errors.array() });
    }

    const { mac, site, minutes, up_kbps, down_kbps, quota_mb } = req.body;
    const targetSite = site || config.unifi.defaultSite;

    try {
      const unifi = new UnifiNetworkService(targetSite);
      const result = await unifi.authorizeGuest(mac, { minutes, upKbps: up_kbps, downKbps: down_kbps, quotaMb: quota_mb });

      // Persist session
      const endTime = minutes
        ? new Date(Date.now() + minutes * 60_000).toISOString()
        : new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();

      MacSession.expireByMac(mac, targetSite);
      const session = MacSession.create({
        mac_address: mac,
        site_name:   targetSite,
        end_time:    endTime,
      });

      return res.json({ status: 'authorized', session, unifi_response: result });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * POST /admin/unifi/unauthorize
   * Body: { mac, site }
   */
  async unauthorize(req, res) {
    const { mac, site } = req.body;
    const targetSite = site || config.unifi.defaultSite;
    try {
      const unifi = new UnifiNetworkService(targetSite);
      await unifi.unauthorizeGuest(mac);
      MacSession.expireByMac(mac, targetSite);
      return res.json({ status: 'unauthorized', mac });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * POST /admin/unifi/kick
   * Body: { mac, site }
   * Kick a client to force it to re-associate (refreshes AP iptables).
   */
  async kick(req, res) {
    const { mac, site } = req.body;
    const targetSite = site || config.unifi.defaultSite;
    try {
      const unifi = new UnifiNetworkService(targetSite);
      await unifi.kickClient(mac);
      return res.json({ status: 'kicked', mac });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },
};

module.exports = AdminController;
