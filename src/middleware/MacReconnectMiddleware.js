'use strict';

const MacSession = require('../models/MacSession');
const UnifiNetworkService = require('../services/UnifiNetworkService');
const config = require('../config');

/**
 * MacReconnectMiddleware
 *
 * Intercepts every request to the captive portal entry-point.
 * When an AP reboots and loses its iptables cache the user is redirected to
 * the portal even though a valid session still exists in our DB.
 *
 * This middleware:
 *  1. Reads the client MAC from the UniFi portal redirect URL params.
 *  2. Looks up the MAC in active_mac_sessions (our source of truth).
 *  3. If a valid (non-expired) session exists → silently re-authorizes the
 *     client on ALL configured sites and responds immediately.
 *  4. If no session exists → passes through to the portal controller.
 *
 * UniFi injects these query params when redirecting to a captive portal:
 *   id    – client MAC address
 *   ap    – MAC of the AP the client is connected to
 *   t     – UNIX timestamp
 *   url   – the original URL the client was trying to reach
 *   ssid  – SSID name
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

  // We have at least one active session — silently re-authorize on all sites
  console.log(`[MacReconnect] Silent re-auth for ${clientMac} (${activeSessions.length} session(s))`);

  const siteRefs = config.unifi.siteRefs;
  const apMac = req.query.ap || null;

  const reAuthPromises = siteRefs.map(async (siteRef) => {
    // Find the matching session for this site, fall back to any active session
    const session = activeSessions.find((s) => s.site_ref === siteRef) || activeSessions[0];

    const unifi = new UnifiNetworkService(siteRef);

    // Calculate remaining minutes from end_time
    let remainingMinutes;
    if (session.end_time) {
      const remainingMs = new Date(session.end_time).getTime() - Date.now();
      remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    }

    try {
      await unifi.authorizeGuest(clientMac, { minutes: remainingMinutes, apMac });
      MacSession.recordReauth(session.id);
      console.log(`[MacReconnect] OK: ${clientMac} on site ref "${siteRef}" (${remainingMinutes ?? '∞'} min left)`);
    } catch (err) {
      console.error(`[MacReconnect] FAILED for site ref "${siteRef}":`, err.message);
    }
  });

  await Promise.allSettled(reAuthPromises);

  const redirectTarget = req.query.url || config.portal.redirectUrl;
  return res.json({
    status: 'reauthorized',
    message: 'Session restored. Redirecting...',
    redirect: redirectTarget,
  });
}

module.exports = macReconnectMiddleware;
