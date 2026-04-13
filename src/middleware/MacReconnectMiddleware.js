'use strict';

const MacSession = require('../models/MacSession');
const UnifiNetworkService = require('../services/UnifiNetworkService');
const config = require('../config');

/**
 * MacReconnectMiddleware
 *
 * Intercepts every request to the captive portal entry-point.
 * When UniFi sends a user to the portal (because the AP lost its iptables
 * cache after a reboot/sync), this middleware:
 *
 *  1. Reads the client MAC from the UniFi portal redirect URL params.
 *  2. Looks up the MAC in our local active_mac_sessions table.
 *  3. If a valid (non-expired) session exists → silently re-authorizes the
 *     client on ALL configured sites and redirects to the target URL.
 *  4. If no session exists → passes through to the portal controller so the
 *     user can enter a voucher.
 *
 * UniFi injects the following query params when redirecting to a captive portal:
 *   ap    – MAC of the AP the client is connected to
 *   id    – client MAC address
 *   t     – UNIX timestamp
 *   url   – the original URL the client was trying to reach
 *   ssid  – SSID name
 *   site  – site name (may or may not be present)
 */
async function macReconnectMiddleware(req, res, next) {
  const clientMac = req.query.id || req.query.mac || req.body?.mac;

  if (!clientMac) {
    return next();
  }

  let activeSessions;
  try {
    activeSessions = MacSession.findAllActive(clientMac);
  } catch (err) {
    console.error('[MacReconnect] DB error:', err.message);
    return next();
  }

  if (!activeSessions || activeSessions.length === 0) {
    return next();
  }

  // We have at least one active session — silently re-authorize on all configured sites
  console.log(`[MacReconnect] Silent re-auth for ${clientMac} (${activeSessions.length} session(s))`);

  const sites = config.unifi.sites;
  const apMac = req.query.ap || null;

  const reAuthPromises = sites.map(async (site) => {
    const session = activeSessions.find((s) => s.site_name === site) || activeSessions[0];

    const unifi = new UnifiNetworkService(site);

    // Calculate remaining minutes
    let remainingMinutes;
    if (session.end_time) {
      const remainingMs = new Date(session.end_time).getTime() - Date.now();
      remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    }

    try {
      await unifi.authorizeGuest(clientMac, {
        minutes: remainingMinutes,
        apMac,
      });
      MacSession.recordReauth(session.id);
      console.log(`[MacReconnect] Re-auth OK: ${clientMac} on site "${site}" (${remainingMinutes ?? '∞'} min left)`);
    } catch (err) {
      console.error(`[MacReconnect] Re-auth FAILED for site "${site}":`, err.message);
    }
  });

  await Promise.allSettled(reAuthPromises);

  // Mark request as silently re-authed so the controller can return the
  // appropriate response (JSON or redirect).
  req.silentReauth = true;
  req.reauthMac = clientMac;

  const redirectTarget = req.query.url || config.portal.redirectUrl;
  return res.json({
    status: 'reauthorized',
    message: 'Session restored. Redirecting...',
    redirect: redirectTarget,
  });
}

module.exports = macReconnectMiddleware;
