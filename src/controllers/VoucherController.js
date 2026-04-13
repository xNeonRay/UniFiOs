'use strict';

const { validationResult } = require('express-validator');
const Voucher = require('../models/Voucher');
const MacSession = require('../models/MacSession');
const { v4: uuidv4 } = require('uuid');

/**
 * VoucherController
 *
 * Admin-facing CRUD endpoints for voucher management.
 * All routes require the adminAuth middleware.
 */
const VoucherController = {
  /**
   * GET /admin/vouchers[?status=active|depleted|revoked]
   * List all vouchers.
   */
  list(req, res) {
    const { status } = req.query;
    const vouchers = Voucher.list(status);
    return res.json({ count: vouchers.length, vouchers });
  },

  /**
   * GET /admin/vouchers/:code
   * Get a single voucher with its history.
   */
  get(req, res) {
    const voucher = Voucher.findByCode(req.params.code);
    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    const history = Voucher.getHistory({ code: req.params.code });
    return res.json({ voucher, history });
  },

  /**
   * POST /admin/vouchers
   *
   * Body (JSON):
   * {
   *   "code":             "ABCD-1234",     // optional, auto-generated if omitted
   *   "description":      "...",           // optional
   *   "max_uses":         1,               // default 1
   *   "duration_minutes": 1440,            // null = unlimited
   *   "restricted_mac":   "AA:BB:CC:...",  // null = any MAC
   *   "up_kbps":          0,              // 0 / null = unlimited
   *   "down_kbps":        0,
   *   "quota_mb":         0,
   *   "created_by":       "admin-user"
   * }
   */
  create(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ error: 'Validation failed', details: errors.array() });
    }

    const {
      description,
      max_uses,
      duration_minutes,
      restricted_mac,
      up_kbps,
      down_kbps,
      quota_mb,
      created_by,
    } = req.body;

    // Auto-generate a code if none was provided
    const code = (req.body.code || generateCode()).toUpperCase();

    // Check for duplicate code
    if (Voucher.findByCode(code)) {
      return res.status(409).json({ error: `Voucher code "${code}" already exists` });
    }

    const voucher = Voucher.create({
      code,
      description,
      max_uses: max_uses ?? 1,
      duration_minutes: duration_minutes ?? null,
      restricted_mac: restricted_mac ?? null,
      up_kbps: up_kbps || null,
      down_kbps: down_kbps || null,
      quota_mb: quota_mb || null,
      created_by: created_by || 'admin',
    });

    return res.status(201).json({ voucher });
  },

  /**
   * DELETE /admin/vouchers/:code
   * Revoke a voucher.
   */
  revoke(req, res) {
    const revoked = Voucher.revoke(req.params.code);
    if (!revoked) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    return res.json({ status: 'revoked', code: req.params.code.toUpperCase() });
  },

  /**
   * GET /admin/vouchers/history
   * Full redemption history (optionally filtered by ?mac= or ?code=).
   */
  history(req, res) {
    const { code, mac } = req.query;
    const history = Voucher.getHistory({ code, mac });
    return res.json({ count: history.length, history });
  },
};

/**
 * Generate a human-friendly voucher code: XXXX-XXXX (uppercase alphanumeric).
 */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${rand(4)}-${rand(4)}`;
}

module.exports = VoucherController;
