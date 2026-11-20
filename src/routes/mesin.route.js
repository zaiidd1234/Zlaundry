/**
 * src/routes/mesin.route.js
 * =============================================================================
 * Aksi mesin oleh manager/owner. Semua perlu login + role manager/owner.
 *   POST /api/mesin/switch        (taruh sebelum /:id agar tidak ketangkap param)
 *   POST /api/mesin/:id/trigger
 *   POST /api/mesin/:id/status
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/mesin.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);

// Bisa diakses semua role (kasir, manager, owner)
router.get('/:id/last-order', ctrl.lastOrder);
router.get('/:id/riwayat-hari-ini', ctrl.riwayatHariIni);
// Popup kartu mesin dashboard kasir (sebelumnya / sekarang / antrian / riwayat)
router.get('/pindah-opsi', ctrl.pindahOpsi);
router.get('/:id/ambil-kandidat', ctrl.ambilKandidat);
router.get('/:id/popup', ctrl.popup);
// Geser urutan antrian 1 mesin (wajib alasan) -- kasir saat mesin teralokasi
router.post('/:id/antrian/geser', requireRole('kasir', 'operator', 'manager', 'owner'), ctrl.geserAntrian);
router.post('/:id/antrian/pindah', requireRole('kasir', 'operator', 'manager', 'owner'), ctrl.pindahAntrian);

// Hanya manager/owner
router.use(requireRole('manager', 'owner'));

router.post('/switch', ctrl.pindah);
router.get('/:id/last-order', ctrl.lastOrder);
router.get('/:id/commands', ctrl.commands);
router.post('/:id/trigger', ctrl.trigger);
router.post('/:id/status', ctrl.status);
router.post('/:id/iot-provider', ctrl.setIotProvider);

module.exports = router;
