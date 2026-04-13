'use strict';

const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const macReconnect = require('../middleware/MacReconnectMiddleware');
const CaptivePortalController = require('../controllers/CaptivePortalController');

// Rate limiter: portal entry-point (60 requests / 5 min per IP)
const portalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Rate limiter: voucher redemption (10 attempts / 5 min per IP — prevents brute-force)
const redeemLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many redemption attempts, please try again later.' },
});

// GET /portal — show portal page (or silently re-auth if MAC is known)
router.get(
  '/',
  portalLimiter,
  macReconnect,
  CaptivePortalController.show,
);

// POST /portal/redeem — validate voucher and authorize MAC
router.post(
  '/redeem',
  redeemLimiter,
  [
    body('voucher_code').isString().trim().notEmpty().withMessage('voucher_code is required'),
    body('mac').isString().trim().notEmpty().withMessage('mac is required'),
  ],
  CaptivePortalController.redeem,
);

// GET /portal/status — lightweight connectivity ping (must be in Walled Garden)
router.get('/status', CaptivePortalController.status);

module.exports = router;
