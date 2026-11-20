/**
 * src/routes/winpay.route.js
 * =============================================================================
 * Rute PUBLIK (TANPA token) yang dipanggil server Winpay, bukan browser kita.
 * Path-nya sengaja disamain persis sama endpoint SNAP resmi (qr-mpm-notify)
 * biar gampang pas daftarin URL callback di dashboard Winpay:
 *   POST /api/winpay/v1.0/qr/qr-mpm-notify
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/winpay.controller');

const router = express.Router();

router.post('/v1.0/qr/qr-mpm-notify', ctrl.notify);

module.exports = router;
