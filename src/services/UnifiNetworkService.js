'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../config');

/**
 * UnifiNetworkService
 *
 * Communicates with a modern UniFi OS controller (v3.x / 4.x / 10.x) using
 * the new API-Key authentication model routed through the OS proxy.
 *
 * Base URL: https://<UNIFI_IP>/proxy/network/api/s/<SITE>/
 *
 * IMPORTANT:
 *  - Does NOT use port 8443.
 *  - Does NOT use /api/login, cookies, or CSRF tokens.
 *  - Authenticates exclusively via the "x-api-key" HTTP header.
 *  - SSL verification is disabled because local controllers use self-signed
 *    certificates. Never disable SSL in a public-internet deployment.
 */
class UnifiNetworkService {
  /**
   * @param {string} [site]  UniFi site slug (defaults to UNIFI_DEFAULT_SITE)
   */
  constructor(site) {
    this.site = site || config.unifi.defaultSite;
    this._client = this._buildClient();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Builds an axios instance pre-configured with:
   *  - base URL pointing at the OS proxy for the configured site
   *  - API-Key header
   *  - SSL verification disabled (self-signed cert support)
   */
  _buildClient() {
    const baseURL = `https://${config.unifi.ip}/proxy/network/api/s/${this.site}/`;

    const httpsAgent = config.unifi.ignoreSSL
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

    return axios.create({
      baseURL,
      httpsAgent,
      headers: {
        'x-api-key': config.unifi.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10_000,
    });
  }

  /**
   * Returns a new service instance targeting a different site.
   * @param {string} site
   * @returns {UnifiNetworkService}
   */
  forSite(site) {
    return new UnifiNetworkService(site);
  }

  // ─── Guest authorization ───────────────────────────────────────────────────

  /**
   * Authorize a guest device to access the network.
   *
   * POST cmd/stamgr  { cmd: "authorize-guest", mac, minutes, ... }
   *
   * @param {string} mac               Client MAC address (any separator format)
   * @param {number} [minutes]         Authorization duration in minutes. Omit for unlimited.
   * @param {number} [upKbps]          Upload bandwidth limit in kbps (optional)
   * @param {number} [downKbps]        Download bandwidth limit in kbps (optional)
   * @param {number} [quotaMb]         Data quota in MB (optional)
   * @param {string} [apMac]           MAC of the AP to limit scope (optional)
   * @returns {Promise<object>}        UniFi API response data
   */
  async authorizeGuest(mac, { minutes, upKbps, downKbps, quotaMb, apMac } = {}) {
    const payload = {
      cmd: 'authorize-guest',
      mac: this._normalizeMac(mac),
    };

    if (minutes != null)  payload.minutes = minutes;
    if (upKbps != null)   payload.up = upKbps;
    if (downKbps != null) payload.down = downKbps;
    if (quotaMb != null)  payload.bytes = quotaMb * 1024 * 1024;
    if (apMac != null)    payload.ap_mac = this._normalizeMac(apMac);

    const response = await this._client.post('cmd/stamgr', payload);
    return response.data;
  }

  /**
   * Revoke/unauthorize a previously authorized guest device.
   *
   * POST cmd/stamgr  { cmd: "unauthorize-guest", mac }
   *
   * @param {string} mac  Client MAC address
   * @returns {Promise<object>}
   */
  async unauthorizeGuest(mac) {
    const response = await this._client.post('cmd/stamgr', {
      cmd: 'unauthorize-guest',
      mac: this._normalizeMac(mac),
    });
    return response.data;
  }

  /**
   * Kick (momentarily disconnect) a client, forcing it to re-associate and
   * refresh the AP iptables entry. Useful to break the "stuck behind portal"
   * state after silent re-authorization.
   *
   * POST cmd/stamgr  { cmd: "kick-sta", mac }
   *
   * @param {string} mac  Client MAC address
   * @returns {Promise<object>}
   */
  async kickClient(mac) {
    const response = await this._client.post('cmd/stamgr', {
      cmd: 'kick-sta',
      mac: this._normalizeMac(mac),
    });
    return response.data;
  }

  // ─── Client statistics ─────────────────────────────────────────────────────

  /**
   * Retrieve real-time stats for a connected client by MAC address.
   *
   * GET stat/sta/<mac>
   *
   * @param {string} mac  Client MAC address
   * @returns {Promise<object|null>}  Client stat object, or null if not found
   */
  async getClientStat(mac) {
    const normalized = this._normalizeMac(mac);
    const response = await this._client.get(`stat/sta/${normalized}`);
    const data = response.data?.data;
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  }

  /**
   * List all currently connected clients on the site.
   *
   * GET stat/sta
   *
   * @returns {Promise<object[]>}
   */
  async listClients() {
    const response = await this._client.get('stat/sta');
    return response.data?.data ?? [];
  }

  /**
   * List all known (ever-connected) clients on the site.
   *
   * GET rest/user
   *
   * @returns {Promise<object[]>}
   */
  async listAllClients() {
    const response = await this._client.get('rest/user');
    return response.data?.data ?? [];
  }

  // ─── Sites ─────────────────────────────────────────────────────────────────

  /**
   * List all sites on this controller (uses the global API endpoint).
   *
   * GET /proxy/network/api/self/sites
   *
   * @returns {Promise<object[]>}
   */
  async listSites() {
    const client = axios.create({
      baseURL: `https://${config.unifi.ip}/proxy/network/api/`,
      httpsAgent: config.unifi.ignoreSSL
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      headers: {
        'x-api-key': config.unifi.apiKey,
        Accept: 'application/json',
      },
      timeout: 10_000,
    });

    const response = await client.get('self/sites');
    return response.data?.data ?? [];
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  /**
   * Normalize a MAC address to lower-case colon-separated format.
   * Accepts AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabbccddeeff, etc.
   *
   * @param {string} mac
   * @returns {string}
   */
  _normalizeMac(mac) {
    if (!mac) throw new Error('MAC address is required');
    const clean = mac.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);
    return clean.match(/.{2}/g).join(':').toLowerCase();
  }
}

module.exports = UnifiNetworkService;
