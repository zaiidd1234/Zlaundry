/**
 * src/routes/index.js
 * =============================================================================
 * Gabungkan semua route di bawah /api. Mount di app.js: app.use('/api', routes).
 * Modul lain ditambahkan seiring fase berikutnya.
 * =============================================================================
 */

const express = require('express');
const authRoute = require('./auth.route');

const router = express.Router();

router.use('/auth', authRoute);
router.use('/customer', require('./customer.route')); // publik (tanpa token)
router.use('/master', require('./master.route'));   // Fase 3
router.use('/transaksi', require('./transaksi.route')); // Fase 4
router.use('/pelanggan', require('./pelanggan.route')); // kasir: cari pelanggan
router.use('/kas', require('./kas.route'));             // kasir: kas kecil
router.use('/transfer', require('./transfer.route'));   // Fase 6
router.use('/laporan', require('./manager.route'));     // Fase 7
router.use('/dashboard', require('./dashboard.route')); // Fase 7
router.use('/mesin', require('./mesin.route'));         // manager: aksi mesin
router.use('/karyawan', require('./karyawan.route'));   // manager: kelola karyawan
router.use('/kas-besar', require('./kas-besar.route')); // manager: kas besar
router.use('/performa', require('./performa.route'));   // manager: analitik
router.use('/promo', require('./promo.route'));          // manager: pengaturan promo per cabang
router.use('/pembayaran-qris', require('./pembayaran-qris.route')); // kasir: generate QRIS dinamis (Winpay)
router.use('/winpay', require('./winpay.route'));         // publik: webhook callback Winpay (TANPA token)
router.use('/absensi', require('./absensi.route'));     // Perubahan #27: absensi kasir + benefit
router.use('/owner', require('./owner.route'));         // Perubahan #47: app owner
router.use('/kiosk', require('./kiosk.route'));            // publik: tablet kiosk dinding, kode bayar->QR (TANPA token)
// ...

module.exports = router;
