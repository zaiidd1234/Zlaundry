/**
 * src/routes/karyawan.route.js
 * =============================================================================
 * Kelola karyawan. Semua perlu login + role manager/owner.
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/karyawan.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);
router.use(requireRole('manager', 'owner'));

router.get('/', ctrl.index);
router.post('/', ctrl.tambah);
router.patch('/:id', ctrl.edit);
router.patch('/:id/status', ctrl.status);
router.post('/:id/reset-password', ctrl.resetPassword);

module.exports = router;
