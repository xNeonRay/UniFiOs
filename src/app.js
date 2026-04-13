'use strict';

require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');

// Run migrations on startup (safe to call multiple times)
require('./database/migrate');

const config = require('./config');
const portalRoutes = require('./routes/portal');
const adminRoutes  = require('./routes/admin');

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (portal HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Routes ────────────────────────────────────────────────────────────────────

// Captive portal entry-point (must be reachable in UniFi Walled Garden)
app.use('/portal', portalRoutes);

// Admin API
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`[UniFi Portal] Server running on port ${config.port} (${config.nodeEnv})`);
  console.log(`[UniFi Portal] Controller: https://${config.unifi.ip}:${config.unifi.controllerPort} | Site refs: ${config.unifi.siteRefs.join(', ')}`);
});

module.exports = app;
