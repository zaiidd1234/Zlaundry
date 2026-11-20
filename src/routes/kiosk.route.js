/**
 * src/routes/kiosk.route.js
 * =============================================================================
 * Rute PUBLIK (tanpa auth token) buat tablet kiosk dinding (public/kiosk/).
 *   GET /api/kiosk/cabang?kode=      -> resolve & validasi cabang dari kode di URL tablet
 *   GET /api/kiosk/qris?cabang_id=&kode= -> QR dinamis Winpay dari kode bayar 4 digit
 *
 * CATATAN: endpoint ini publik & kode bayar cuma 4 digit (10.000 kombinasi).
 * #78: /qris dibatasi -- maks 15 kode SALAH per 10 menit per IP (kode benar
 * tidak dihitung, jadi tablet toko yang dipakai banyak pelanggan aman),
 * plus batas kasar 60 permintaan/menit per IP.
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/kiosk.controller');
const { batasAkses } = require('../middleware/batas-akses');

const router = express.Router();

router.get('/cabang', ctrl.cabangByKode);
router.get('/qris',
  batasAkses({ nama: 'kiosk-qris', maks: 60, jendelaMs: 60 * 1000 }),
  batasAkses({ nama: 'kiosk-qris-salah', maks: 15, jendelaMs: 10 * 60 * 1000, hanyaGagal: true,
    pesan: 'Terlalu banyak kode salah. Tunggu beberapa menit lalu coba lagi, atau minta bantuan kasir.' }),
  ctrl.qrisByKode);

module.exports = router;
