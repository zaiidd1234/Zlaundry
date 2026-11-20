/**
 * src/routes/promo.route.js
 * =============================================================================
 * Pengaturan promo (on/off per cabang). Perlu login, role manager/owner.
 *   GET   /api/promo/pengaturan
 *   PATCH /api/promo/pengaturan
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/promo.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth, requireRole('manager', 'owner'));

router.get('/pengaturan', ctrl.getPengaturan);
router.patch('/pengaturan', ctrl.updatePengaturan);

module.exports = router;
