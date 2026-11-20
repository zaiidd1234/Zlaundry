/**
 * src/routes/dashboard.route.js
 * =============================================================================
 * Rute dashboard (perlu login). GET /api/dashboard menyesuaikan role.
 *   GET /api/dashboard
 *   GET /api/dashboard/kasir   (owner/manager bisa intip operasional)
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/dashboard.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);

router.get('/', ctrl.index);
router.get('/kasir', ctrl.kasir);
router.get('/manager', requireRole('manager', 'owner'), ctrl.manager);
router.get('/transaksi-per-jam', requireRole('manager', 'owner'), ctrl.transaksiPerJam); // Perubahan #66

module.exports = router;
