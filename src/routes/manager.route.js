/**
 * src/routes/manager.route.js
 * =============================================================================
 * Rute laporan (perlu login, role manager/owner).
 *   GET /api/laporan/laba-rugi
 *   GET /api/laporan/performa
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/manager.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth, requireRole('manager', 'owner'));

router.get('/laba-rugi', ctrl.labaRugi);
router.get('/performa', ctrl.performa);

module.exports = router;
