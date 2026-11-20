/**
 * src/routes/performa.route.js
 * =============================================================================
 * Performa. Perlu login + role manager/owner.
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/performa.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);
router.use(requireRole('manager', 'owner'));

router.get('/ringkasan', ctrl.ringkasan);
router.get('/pelanggan', ctrl.pelanggan);
router.get('/produk', ctrl.produk);

module.exports = router;
