/**
 * src/routes/pelanggan.route.js
 * =============================================================================
 * Endpoint pelanggan untuk kasir (perlu login).
 *   GET /api/pelanggan/search?q=
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/pelanggan.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);
router.get('/search', ctrl.search);

// Endpoint kelola pelanggan (manager/owner)
router.get('/frekuensi', requireRole('manager', 'owner'), ctrl.frekuensi);
router.get('/statistik-kunjungan', requireRole('manager', 'owner'), ctrl.statistikKunjungan); // Perubahan #60
router.get('/forecast', requireRole('manager', 'owner'), ctrl.forecast);
router.get('/forecast-tahunan', requireRole('manager', 'owner'), ctrl.forecastTahunan);
router.get('/', requireRole('manager', 'owner'), ctrl.index);
// riwayat & edit data pelanggan: dibuka juga utk kasir (kartu Pesanan -> klik
// badge kunjungan -> lihat semua riwayat transaksi + edit data), controller-nya
// sudah scope cabang sendiri (lihat cabangFrom() di pelanggan.controller.js).
router.get('/:id/riwayat', requireRole('kasir', 'manager', 'owner'), ctrl.riwayat);
router.patch('/:id', requireRole('kasir', 'manager', 'owner'), ctrl.update);

module.exports = router;
