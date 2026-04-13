'use strict';

const { validationResult } = require('express-validator');
const MacSession = require('../models/MacSession');
const Voucher = require('../models/Voucher');
const UnifiNetworkService = require('../services/UnifiNetworkService');
const config = require('../config');

/**
 * CaptivePortalController
 *
 * Handles the full captive-portal flow:
 *  1. GET  /portal        — Render the portal HTML (or auto-reconnect if MAC is known)
 *  2. POST /portal/redeem — Validate a voucher and authorize the guest on all sites
 *  3. GET  /portal/status — Connectivity ping endpoint (used by the JS polling loop)
 */
const CaptivePortalController = {
  /**
   * GET /portal
   *
   * Entry point when the AP redirects a client to the captive portal.
   * The MacReconnectMiddleware runs before this handler; if it detects an
   * active session it short-circuits and responds directly, so by the time
   * this handler is reached we know the client needs to authenticate.
   *
   * UniFi query params: id (client MAC), ap, url, ssid, site, t
   */
  show(req, res) {
    const clientMac = req.query.id || req.query.mac || '';
    const redirectUrl = req.query.url || config.portal.redirectUrl;
    const apMac = req.query.ap || '';
    const ssid = req.query.ssid || '';

    return res.sendFile('portal.html', { root: 'public' });
  },

  /**
   * POST /portal/redeem
   *
   * Body (JSON):
   *  {
   *    "voucher_code": "ABCD-1234",
   *    "mac":          "aa:bb:cc:dd:ee:ff",
   *    "ap_mac":       "...",            // optional
   *    "redirect_url": "https://..."     // optional, overrides default
   *  }
   *
   * Validates the voucher, authorizes the MAC on ALL configured UniFi sites,
   * stores the session in active_mac_sessions, and returns the redirect URL
   * so the frontend JS can navigate the user there once it detects internet.
   */
  async redeem(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'Validation failed', details: errors.array() });
    }

    const { voucher_code, mac, ap_mac, redirect_url } = req.body;
    const upperMac = mac.toUpperCase();
    const finalRedirect = redirect_url || config.portal.redirectUrl;

    // 1. Validate voucher
    const { valid, reason, voucher } = Voucher.validate(voucher_code, upperMac);
    if (!valid) {
      return res.status(400).json({ error: reason });
    }

    // 2. Authorize on all configured UniFi sites
    const sites = config.unifi.sites;
    const authResults = [];

    for (const site of sites) {
      const unifi = new UnifiNetworkService(site);
      try {
        await unifi.authorizeGuest(upperMac, {
          minutes: voucher.duration_minutes ?? undefined,
          upKbps:   voucher.up_kbps   ?? undefined,
          downKbps: voucher.down_kbps ?? undefined,
          quotaMb:  voucher.quota_mb  ?? undefined,
          apMac:    ap_mac            ?? undefined,
        });
        authResults.push({ site, success: true });
      } catch (err) {
        console.error(`[CaptivePortal] authorizeGuest failed for site "${site}":`, err.message);
        authResults.push({ site, success: false, error: err.message });
      }
    }

    // Require at least one successful authorization
    const anySuccess = authResults.some((r) => r.success);
    if (!anySuccess) {
      return res.status(502).json({
        error: 'Could not authorize device on any UniFi site',
        details: authResults,
      });
    }

    // 3. Redeem voucher (increments use count, records history)
    const { sessionEndTime } = Voucher.redeem(voucher_code, upperMac, sites[0], {
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null,
    });

    // 4. Create session records for each successful site
    for (const result of authResults.filter((r) => r.success)) {
      // Expire any previous active sessions for this MAC+site
      MacSession.expireByMac(upperMac, result.site);

      // Determine end_time: use sessionEndTime or far future for unlimited
      const endTime = sessionEndTime
        ?? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(); // ~100 years

      MacSession.create({
        mac_address:  upperMac,
        site_name:    result.site,
        end_time:     endTime,
        voucher_code: voucher_code.toUpperCase(),
        ap_mac:       ap_mac || null,
      });
    }

    return res.json({
      status: 'authorized',
      mac: upperMac,
      sites: authResults,
      session_end: sessionEndTime,
      redirect: finalRedirect,
      poll_interval_ms: config.portal.pollIntervalMs,
      poll_max_retries: config.portal.pollMaxRetries,
    });
  },

  /**
   * GET /portal/status
   *
   * Lightweight endpoint used by the frontend JS polling loop to detect
   * when the client actually has internet access after authorization.
   * The endpoint itself just returns 200 OK; the JS layer also probes
   * external URLs to confirm unrestricted connectivity.
   *
   * No authentication required — must be in the UniFi Walled Garden
   * so devices can reach it before authorization.
   */
  status(req, res) {
    return res.json({ ok: true, ts: Date.now() });
  },
};

module.exports = CaptivePortalController;
