'use strict';

const config = require('../config');

/**
 * Middleware: verify the Bearer token for admin-only endpoints.
 *
 * Clients must send:
 *   Authorization: Bearer <ADMIN_SECRET>
 */
function adminAuth(req, res, next) {
  if (!config.admin.secret) {
    return res.status(500).json({ error: 'Admin secret not configured on server' });
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== config.admin.secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = adminAuth;
