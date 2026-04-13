'use strict';

const { validationResult } = require('express-validator');
const MacSession = require('../models/MacSession');
const UnifiNetworkService = require('../services/UnifiNetworkService');
const config = require('../config');

/**
 * AdminController
 *
 * Low-level network and session management endpoints for administrators.
 * All routes require the adminAuth middleware.
 *
 * UniFi API paths used:
 *  Integration v1  →  /proxy/network/integration/v1/sites[/{topSiteId}/devices]
 *  Command API     →  /proxy/network/api/s/{internalReference}/cmd/stamgr
 */
const AdminController = {
  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * GET /admin/sessions?mac=&site_ref=
   * List active sessions (optionally filtered).
   */
  listSessions(req, res) {
    const { mac, site_ref } = req.query;
    const db = require('../config/database');
    let rows;

    if (mac) {
      rows = MacSession.findAllActive(mac);
    } else if (site_ref) {
      rows = db.prepare(`
        SELECT * FROM active_mac_sessions
        WHERE site_ref = ?
          AND status   = 'active'
          AND end_time > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY end_time DESC
      `).all(site_ref);
    } else {
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
    const siteRefs = config.unifi.siteRefs;
    const results = [];

    for (const siteRef of siteRefs) {
      const unifi = new UnifiNetworkService(siteRef);
      try {
        await unifi.unauthorizeGuest(mac);
        results.push({ site: siteRef, success: true });
      } catch (err) {
        results.push({ site: siteRef, success: false, error: err.message });
      }
    }

    MacSession.expireByMac(mac);
    return res.json({ status: 'revoked', mac: mac.toUpperCase(), sites: results });
  },

  /**
   * POST /admin/sessions/cleanup
   * Mark all stale (expired) DB sessions as expired.
   */
  cleanup(req, res) {
    const count = MacSession.expireStale();
    return res.json({ status: 'ok', expired: count });
  },

  // ─── UniFi — integration/v1 reads ─────────────────────────────────────────

  /**
   * GET /admin/unifi/network-devices[?offset=0&limit=200]
   *
   * Calls: GET /proxy/network/integration/v1/sites
   * Returns top-level network devices (APs, switches) visible to the controller.
   * The "id" from each item is the topSiteId needed for /admin/unifi/logical-sites.
   *
   * Response shape:
   *   { offset, limit, count, totalCount,
   *     data: [{ id, macAddress, name, model, state, features, ... }] }
   */
  async listNetworkDevices(req, res) {
    const { offset = 0, limit = 200 } = req.query;
    try {
      const unifi = new UnifiNetworkService();
      const result = await unifi.listNetworkDevices({ offset: +offset, limit: +limit });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * GET /admin/unifi/logical-sites[?topSiteId=&offset=0&limit=200]
   *
   * Calls: GET /proxy/network/integration/v1/sites/{topSiteId}/devices
   * Returns logical UniFi sites with their UUIDs and internalReferences.
   *
   * The internalReference is the "slug" needed in UNIFI_SITE_REFS (.env).
   *
   * Response shape:
   *   { offset, limit, count, totalCount,
   *     data: [{ id, internalReference, name }] }
   */
  async listLogicalSites(req, res) {
    const { topSiteId, offset = 0, limit = 200 } = req.query;
    try {
      const unifi = new UnifiNetworkService();
      const result = await unifi.listLogicalSites(topSiteId, { offset: +offset, limit: +limit });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * GET /admin/unifi/clients?siteId={uuid}[&offset=0&limit=200]
   *
   * Calls: GET /proxy/network/integration/v1/sites/{siteId}/clients
   * Lists connected clients on a logical site.
   *
   * @param siteId  UUID of the logical site (from listLogicalSites)
   */
  async listClients(req, res) {
    const { siteId, offset = 0, limit = 200 } = req.query;
    if (!siteId) {
      return res.status(400).json({ error: 'siteId (UUID) query parameter is required' });
    }
    try {
      const unifi = new UnifiNetworkService();
      const clients = await unifi.listClients(siteId, { offset: +offset, limit: +limit });
      return res.json({ siteId, count: clients.length, clients });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * GET /admin/unifi/clients/:mac?siteId={uuid}
   *
   * Calls: GET /proxy/network/integration/v1/sites/{siteId}/clients/{mac}
   */
  async getClient(req, res) {
    const { siteId } = req.query;
    if (!siteId) {
      return res.status(400).json({ error: 'siteId (UUID) query parameter is required' });
    }
    try {
      const unifi = new UnifiNetworkService();
      const client = await unifi.getClientStat(siteId, req.params.mac);
      if (!client) return res.status(404).json({ error: 'Client not found on site' });
      return res.json({ siteId, client });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  // ─── UniFi — command API (stamgr) ─────────────────────────────────────────

  /**
   * POST /admin/unifi/authorize
   *
   * Body: { mac, site_ref, minutes?, up_kbps?, down_kbps?, quota_mb? }
   *
   * Calls: POST /proxy/network/api/s/{site_ref}/cmd/stamgr  { cmd: "authorize-guest" }
   */
  async authorize(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'Validation failed', details: errors.array() });
    }

    const { mac, site_ref, minutes, up_kbps, down_kbps, quota_mb } = req.body;
    const targetRef = site_ref || config.unifi.siteRefs[0] || 'default';

    try {
      const unifi = new UnifiNetworkService(targetRef);
      const result = await unifi.authorizeGuest(mac, {
        minutes,
        upKbps:  up_kbps,
        downKbps: down_kbps,
        quotaMb:  quota_mb,
      });

      const endTime = minutes
        ? new Date(Date.now() + minutes * 60_000).toISOString()
        : new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();

      MacSession.expireByMac(mac, targetRef);
      const session = MacSession.create({ mac_address: mac, site_ref: targetRef, end_time: endTime });

      return res.json({ status: 'authorized', session, unifi_response: result });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * POST /admin/unifi/unauthorize
   *
   * Body: { mac, site_ref? }
   *
   * Calls: POST /proxy/network/api/s/{site_ref}/cmd/stamgr  { cmd: "unauthorize-guest" }
   */
  async unauthorize(req, res) {
    const { mac, site_ref } = req.body;
    const targetRef = site_ref || config.unifi.siteRefs[0] || 'default';
    try {
      const unifi = new UnifiNetworkService(targetRef);
      await unifi.unauthorizeGuest(mac);
      MacSession.expireByMac(mac, targetRef);
      return res.json({ status: 'unauthorized', mac, site_ref: targetRef });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },

  /**
   * POST /admin/unifi/kick
   *
   * Body: { mac, site_ref? }
   *
   * Calls: POST /proxy/network/api/s/{site_ref}/cmd/stamgr  { cmd: "kick-sta" }
   */
  async kick(req, res) {
    const { mac, site_ref } = req.body;
    const targetRef = site_ref || config.unifi.siteRefs[0] || 'default';
    try {
      const unifi = new UnifiNetworkService(targetRef);
      await unifi.kickClient(mac);
      return res.json({ status: 'kicked', mac, site_ref: targetRef });
    } catch (err) {
      return res.status(502).json({ error: 'UniFi API error', message: err.message });
    }
  },
};

module.exports = AdminController;
