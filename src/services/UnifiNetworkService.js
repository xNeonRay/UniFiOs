'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../config');

  // ─── Shared HTTPS agent (SSL bypass for self-signed certs) ───────────────────
// WARNING: Only disable SSL verification for trusted local network controllers.
// Never set UNIFI_IGNORE_SSL=true when the controller is reachable from the public internet.
const httpsAgent = config.unifi.ignoreSSL
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

/**
 * UnifiNetworkService
 *
 * Communicates with a modern UniFi OS controller (v3.x / 4.x / 10.x).
 *
 * TWO base paths are used:
 *
 * 1. INTEGRATION API  →  /proxy/network/integration/v1/
 *    Paginated REST API for reading sites and devices.
 *    Response envelope: { offset, limit, count, totalCount, data: [...] }
 *
 * 2. COMMAND API  →  /proxy/network/api/s/{internalReference}/
 *    Classic stamgr/management commands (authorize, unauthorize, kick).
 *    Still supported through the OS proxy with API-Key authentication.
 *    Response envelope: { meta: { rc }, data: [...] }
 *
 * RULES:
 *  ✅  Authentication via "x-api-key" header only.
 *  ✅  All requests go through https://[IP]:[PORT]/proxy/...
 *  ❌  NO port 8443, NO /api/login, NO cookies, NO CSRF tokens.
 *
 * Endpoint examples (from real controller at port 11443):
 *   GET  /proxy/network/integration/v1/sites
 *        → lists top-level network devices (APs, switches) with pagination
 *   GET  /proxy/network/integration/v1/sites/{topSiteId}/devices
 *        → lists logical UniFi sites with id (UUID) and internalReference (slug)
 *   POST /proxy/network/api/s/{internalReference}/cmd/stamgr
 *        → guest management commands (authorize-guest, unauthorize-guest, kick-sta)
 */
class UnifiNetworkService {
  /**
   * @param {string} [siteRef]  Site internalReference slug (e.g. "default", "9kjh0hv4")
   */
  constructor(siteRef) {
    this.siteRef = siteRef || (config.unifi.siteRefs[0] ?? 'default');
    this._origin = `https://${config.unifi.ip}:${config.unifi.controllerPort}`;
    this._validateSiteRef(this.siteRef); // Guard against path traversal
    this._integrationClient = this._buildIntegrationClient();
    this._commandClient     = this._buildCommandClient(this.siteRef);
  }

  // ─── Private: axios factory ───────────────────────────────────────────────

  /** Shared Axios options for all requests. */
  _sharedOptions() {
    return {
      httpsAgent,
      headers: {
        'x-api-key': config.unifi.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10_000,
    };
  }

  /**
   * Client for  /proxy/network/integration/v1/*
   * Used for paginated read operations (sites, devices, clients).
   */
  _buildIntegrationClient() {
    return axios.create({
      baseURL: `${this._origin}/proxy/network/integration/v1/`,
      ...this._sharedOptions(),
    });
  }

  /**
   * Client for  /proxy/network/api/s/{siteRef}/*
   * Used for stamgr commands (authorize, unauthorize, kick).
   * @param {string} siteRef
   */
  _buildCommandClient(siteRef) {
    return axios.create({
      baseURL: `${this._origin}/proxy/network/api/s/${siteRef}/`,
      ...this._sharedOptions(),
    });
  }

  /**
   * Return a new service instance targeting a different site slug.
   * @param {string} siteRef
   * @returns {UnifiNetworkService}
   */
  forSiteRef(siteRef) {
    return new UnifiNetworkService(siteRef);
  }

  // ─── Integration API — Sites & Devices ────────────────────────────────────

  /**
   * List top-level network devices (APs, switches) visible to this controller.
   *
   * GET /proxy/network/integration/v1/sites
   *
   * Response shape:
   * {
   *   "offset": 0, "limit": 200, "count": 2, "totalCount": 2,
   *   "data": [
   *     { "id": "...", "macAddress": "...", "name": "APPrueba",
   *       "model": "AC HD", "state": "ONLINE",
   *       "features": ["accessPoint"], "interfaces": ["radios"] },
   *     ...
   *   ]
   * }
   *
   * @param {object} [opts]
   * @param {number} [opts.offset=0]
   * @param {number} [opts.limit=200]
   * @returns {Promise<{ data: object[], totalCount: number }>}
   */
  async listNetworkDevices({ offset = 0, limit = 200 } = {}) {
    const res = await this._integrationClient.get('sites', {
      params: { offset, limit },
    });
    return res.data;
  }

  /**
   * List logical UniFi sites (networks) under a top-level site/controller.
   *
   * GET /proxy/network/integration/v1/sites/{topSiteId}/devices
   *
   * Response shape:
   * {
   *   "offset": 0, "limit": 200, "count": 3, "totalCount": 3,
   *   "data": [
   *     { "id": "88f7af54-...", "internalReference": "default", "name": "Default" },
   *     { "id": "001df191-...", "internalReference": "9kjh0hv4", "name": "Uniprint" },
   *     { "id": "045bc789-...", "internalReference": "snay2t2o", "name": "AntiguaDY" }
   *   ]
   * }
   *
   * @param {string}  topSiteId   Top-level site UUID (from listNetworkDevices or .env)
   * @param {object}  [opts]
   * @param {number}  [opts.offset=0]
   * @param {number}  [opts.limit=200]
   * @returns {Promise<{ data: Array<{id:string, internalReference:string, name:string}>, totalCount: number }>}
   */
  async listLogicalSites(topSiteId, { offset = 0, limit = 200 } = {}) {
    const id = this._validateSiteId(topSiteId || config.unifi.topSiteId);
    const res = await this._integrationClient.get(`sites/${id}/devices`, {
      params: { offset, limit },
    });
    return res.data;
  }

  /**
   * Auto-discover the top-level site ID and return all logical sites in one call.
   * Convenience wrapper that handles the two-step discovery automatically.
   *
   * @returns {Promise<Array<{id:string, internalReference:string, name:string}>>}
   */
  async discoverAllLogicalSites() {
    // Use cached topSiteId from env, or discover from first network device
    let topId = config.unifi.topSiteId;

    if (!topId) {
      const devices = await this.listNetworkDevices({ limit: 1 });
      if (!devices.data || devices.data.length === 0) {
        throw new Error('No network devices found on controller. Cannot auto-discover sites.');
      }
      topId = devices.data[0].id;
    }

    const sites = await this.listLogicalSites(topId);
    return sites.data ?? [];
  }

  // ─── Integration API — Clients ────────────────────────────────────────────

  /**
   * List connected clients on a logical site.
   *
   * GET /proxy/network/integration/v1/sites/{siteId}/clients
   *
   * @param {string}  siteId   Logical site UUID (from listLogicalSites)
   * @param {object}  [opts]
   * @param {number}  [opts.offset=0]
   * @param {number}  [opts.limit=200]
   * @returns {Promise<object[]>}
   */
  async listClients(siteId, { offset = 0, limit = 200 } = {}) {
    const validId = this._validateSiteId(siteId);
    const res = await this._integrationClient.get(`sites/${validId}/clients`, {
      params: { offset, limit },
    });
    return res.data?.data ?? [];
  }

  /**
   * Get stats for a specific client by MAC address on a logical site.
   *
   * GET /proxy/network/integration/v1/sites/{siteId}/clients/{mac}
   *
   * @param {string} siteId  Logical site UUID
   * @param {string} mac     Client MAC address
   * @returns {Promise<object|null>}
   */
  async getClientStat(siteId, mac) {
    const validId = this._validateSiteId(siteId);
    const normalized = this._normalizeMac(mac);
    const res = await this._integrationClient.get(`sites/${validId}/clients/${normalized}`);
    const data = res.data?.data;
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  }

  // ─── Command API — Guest Management ───────────────────────────────────────

  /**
   * Authorize a guest device to access the network.
   *
   * POST /proxy/network/api/s/{internalReference}/cmd/stamgr
   * Body: { cmd: "authorize-guest", mac, minutes?, up?, down?, bytes?, ap_mac? }
   *
   * @param {string} mac               Client MAC address
   * @param {object} [opts]
   * @param {number} [opts.minutes]    Authorization duration in minutes (omit = unlimited)
   * @param {number} [opts.upKbps]     Upload limit in kbps
   * @param {number} [opts.downKbps]   Download limit in kbps
   * @param {number} [opts.quotaMb]    Data quota in MB
   * @param {string} [opts.apMac]      Scope to a specific AP MAC
   * @returns {Promise<object>}        UniFi API response
   */
  async authorizeGuest(mac, { minutes, upKbps, downKbps, quotaMb, apMac } = {}) {
    const payload = {
      cmd: 'authorize-guest',
      mac: this._normalizeMac(mac),
    };

    if (minutes  != null) payload.minutes = minutes;
    if (upKbps   != null) payload.up      = upKbps;
    if (downKbps != null) payload.down    = downKbps;
    if (quotaMb  != null) payload.bytes   = quotaMb * 1024 * 1024;
    if (apMac    != null) payload.ap_mac  = this._normalizeMac(apMac);

    const res = await this._commandClient.post('cmd/stamgr', payload);
    return res.data;
  }

  /**
   * Revoke a previously authorized guest device.
   *
   * POST /proxy/network/api/s/{internalReference}/cmd/stamgr
   * Body: { cmd: "unauthorize-guest", mac }
   *
   * @param {string} mac
   * @returns {Promise<object>}
   */
  async unauthorizeGuest(mac) {
    const res = await this._commandClient.post('cmd/stamgr', {
      cmd: 'unauthorize-guest',
      mac: this._normalizeMac(mac),
    });
    return res.data;
  }

  /**
   * Kick (force re-association of) a client.
   * This resets the device's DNS cache and forces the AP to re-evaluate iptables,
   * which eliminates the "stuck behind portal" symptom after silent re-authorization.
   *
   * POST /proxy/network/api/s/{internalReference}/cmd/stamgr
   * Body: { cmd: "kick-sta", mac }
   *
   * @param {string} mac
   * @returns {Promise<object>}
   */
  async kickClient(mac) {
    const res = await this._commandClient.post('cmd/stamgr', {
      cmd: 'kick-sta',
      mac: this._normalizeMac(mac),
    });
    return res.data;
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  /**
   * Normalize a MAC address to lower-case colon-separated format.
   * Accepts: AA:BB:CC:DD:EE:FF  |  aa-bb-cc  |  aabbccddeeff
   *
   * @param {string} mac
   * @returns {string}  e.g. "aa:bb:cc:dd:ee:ff"
   */
  _normalizeMac(mac) {
    if (!mac) throw new Error('MAC address is required');
    const clean = mac.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) throw new Error(`Invalid MAC address: "${mac}"`);
    return clean.match(/.{2}/g).join(':').toLowerCase();
  }

  /**
   * Validate a UUID-format site ID to prevent path traversal.
   * Accepts full UUIDs (with or without hyphens).
   * @param {string} id
   * @returns {string}
   */
  _validateSiteId(id) {
    if (!id || typeof id !== 'string') throw new Error('siteId is required');
    // Allow standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Invalid site ID format: "${id}". Expected UUID.`);
    }
    return id;
  }

  /**
   * Validate a site internalReference slug to prevent path traversal.
   * Only allows alphanumeric characters and hyphens/underscores.
   * @param {string} ref
   * @returns {string}
   */
  _validateSiteRef(ref) {
    if (!ref || typeof ref !== 'string') throw new Error('siteRef is required');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ref)) {
      throw new Error(`Invalid site reference: "${ref}". Only alphanumeric, hyphens, and underscores allowed.`);
    }
    return ref;
  }
}

module.exports = UnifiNetworkService;
