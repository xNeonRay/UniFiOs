'use strict';

const express = require('express');
const { body } = require('express-validator');
const router = express.Router();

const adminAuth = require('../middleware/adminAuth');
const VoucherController = require('../controllers/VoucherController');
const AdminController = require('../controllers/AdminController');

// All admin routes require Bearer token
router.use(adminAuth);

// ─── Voucher CRUD ────────────────────────────────────────────────────────────

// GET  /admin/vouchers          — list all vouchers (optionally ?status=)
router.get('/vouchers', VoucherController.list);

// GET  /admin/vouchers/history  — full history (optionally ?mac= or ?code=)
router.get('/vouchers/history', VoucherController.history);

// GET  /admin/vouchers/:code    — single voucher + history
router.get('/vouchers/:code', VoucherController.get);

// POST /admin/vouchers          — create a voucher
router.post(
  '/vouchers',
  [
    body('max_uses').optional().isInt({ min: 1 }).withMessage('max_uses must be a positive integer'),
    body('duration_minutes').optional({ nullable: true }).isInt({ min: 1 }).withMessage('duration_minutes must be a positive integer'),
    body('restricted_mac').optional({ nullable: true }).isString(),
    body('up_kbps').optional({ nullable: true }).isInt({ min: 0 }),
    body('down_kbps').optional({ nullable: true }).isInt({ min: 0 }),
    body('quota_mb').optional({ nullable: true }).isInt({ min: 0 }),
  ],
  VoucherController.create,
);

// DELETE /admin/vouchers/:code  — revoke a voucher
router.delete('/vouchers/:code', VoucherController.revoke);

// ─── Session management ───────────────────────────────────────────────────────

// GET    /admin/sessions           — list active sessions (?mac= or ?site=)
router.get('/sessions', AdminController.listSessions);

// DELETE /admin/sessions/:mac      — revoke all sessions for a MAC
router.delete('/sessions/:mac', AdminController.revokeSession);

// POST   /admin/sessions/cleanup   — expire stale DB sessions
router.post('/sessions/cleanup', AdminController.cleanup);

// ─── UniFi passthrough ────────────────────────────────────────────────────────

// GET  /admin/unifi/sites                   — list sites on controller
router.get('/unifi/sites', AdminController.listSites);

// GET  /admin/unifi/clients[?site=default]  — list connected clients
router.get('/unifi/clients', AdminController.listClients);

// GET  /admin/unifi/clients/:mac            — get stats for specific client
router.get('/unifi/clients/:mac', AdminController.getClient);

// POST /admin/unifi/authorize               — manually authorize a MAC
router.post(
  '/unifi/authorize',
  [
    body('mac').isString().trim().notEmpty().withMessage('mac is required'),
    body('site').optional().isString(),
    body('minutes').optional({ nullable: true }).isInt({ min: 1 }),
  ],
  AdminController.authorize,
);

// POST /admin/unifi/unauthorize             — manually unauthorize a MAC
router.post(
  '/unifi/unauthorize',
  [body('mac').isString().trim().notEmpty().withMessage('mac is required')],
  AdminController.unauthorize,
);

// POST /admin/unifi/kick                    — kick (force re-association) a MAC
router.post(
  '/unifi/kick',
  [body('mac').isString().trim().notEmpty().withMessage('mac is required')],
  AdminController.kick,
);

module.exports = router;
