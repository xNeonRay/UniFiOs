'use strict';

const express = require('express');
const { body } = require('express-validator');
const router = express.Router();

const macReconnect = require('../middleware/MacReconnectMiddleware');
const CaptivePortalController = require('../controllers/CaptivePortalController');

// GET /portal — show portal page (or silently re-auth if MAC is known)
router.get(
  '/',
  macReconnect,
  CaptivePortalController.show,
);

// POST /portal/redeem — validate voucher and authorize MAC
router.post(
  '/redeem',
  [
    body('voucher_code').isString().trim().notEmpty().withMessage('voucher_code is required'),
    body('mac').isString().trim().notEmpty().withMessage('mac is required'),
  ],
  CaptivePortalController.redeem,
);

// GET /portal/status — lightweight connectivity ping (must be in Walled Garden)
router.get('/status', CaptivePortalController.status);

module.exports = router;
