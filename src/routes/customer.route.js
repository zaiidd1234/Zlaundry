/**
 * src/routes/customer.route.js
 * =============================================================================
 * Rute publik customer (TANPA token). Identitas via telepon + cabang_id.
 *   GET  /api/customer/cabang
 *   GET  /api/customer/katalog?cabang_id=
 *   GET  /api/customer/lookup?cabang_id=&telepon=
 *   GET  /api/customer/mesin?cabang_id=&tipe=washer|dryer
 *   GET  /api/customer/mesin-status?cabang_id=   -> ringkasan idle/terpakai + eta (utk "Data Saya")
 *   POST /api/customer/transaksi
 *   GET  /api/customer/riwayat?cabang_id=&telepon=&tab=
 *   GET  /api/customer/transaksi/:id?cabang_id=&telepon=
 *   POST /api/customer/transaksi/:id/mesin?cabang_id=  body:{telepon,mesin_id?}
 *        -> wewenang customer: pilih mesin / mulai / selesai (cuci & kering),
 *           HANYA setelah kasir konfirmasi bayar. Tahap lain tetap kasir-only.
 *   GET  /api/customer/tagihan-qris?cabang_id=&telepon=       -> daftar transaksi belum lunas
 *   POST /api/customer/pembayaran-qris   body:{cabang_id,telepon,transaksi_ids[]} -> generate QR Winpay
 *   GET  /api/customer/pembayaran-qris/:id?cabang_id=&telepon= -> polling status bayar
 *   POST /api/customer/bayar-semua       body:{cabang_id,telepon} -> tombol "Bayar Semua" (Pesanan
 *        Aktif), gabung SEMUA tagihan belum lunas + kode_bayar 4 digit (dipakai di tablet kiosk,
 *        lihat GET /api/kiosk/qris di routes/kiosk.route.js)
 *
 * Rate limit dipasang untuk cegah abuse karena publik.
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/customer.controller');
const validate = require('../middleware/validate');
const { customerOrderSchema, customerAksiMesinSchema, customerBayarQrisSchema, customerBayarSemuaSchema } = require('../validations/customer.validation');

const { batasAkses } = require('../middleware/batas-akses');

const router = express.Router();

router.get('/cabang', ctrl.listCabang);
router.get('/katalog', ctrl.katalog);
// Perubahan #35: foto barang (publik, di-cache browser; URL memuat ?v=versi)
router.get('/barang-foto/:id', async (req, res, next) => {
  try {
    const f = await require('../services/barang-foto.service').ambil(Number(req.params.id));
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(f.mime).send(f.data);
  } catch (e) { next(e); }
});
router.get('/lookup', ctrl.lookup);
router.get('/mesin', ctrl.mesinList);
router.get('/mesin-status', ctrl.mesinStatus);
router.get('/promo-tersedia', ctrl.promoTersedia);
router.post('/transaksi', validate(customerOrderSchema), ctrl.buatOrder);
router.post('/transaksi/:id/tukar-poin', ctrl.tukarPoin);
router.post('/transaksi/:id/reserve-poin', ctrl.reservePoin);
router.post('/transaksi/:id/mesin', validate(customerAksiMesinSchema), ctrl.aksiMesin);
router.get('/riwayat', ctrl.riwayat);
router.get('/transaksi/:id', ctrl.detail);

// Bayar via QRIS dinamis (Winpay)
// #78: batasi endpoint publik yang menyentuh Winpay / data tagihan
router.get('/tagihan-qris', batasAkses({ nama: 'cust-tagihan-qris', maks: 30, jendelaMs: 60 * 1000 }), ctrl.tagihanQris);
router.post('/pembayaran-qris', batasAkses({ nama: 'cust-buat-qris', maks: 10, jendelaMs: 60 * 1000,
  pesan: 'Terlalu sering membuat QR. Tunggu sebentar lalu coba lagi.' }), validate(customerBayarQrisSchema), ctrl.buatPembayaranQris);
router.get('/pembayaran-qris/:id', ctrl.statusPembayaranQris);
// Tombol "Bayar Semua" (Pesanan Aktif) -> gabung SEMUA tagihan belum lunas + kode_bayar 4 digit buat tablet kiosk (lihat routes/kiosk.route.js)
router.post('/bayar-semua', validate(customerBayarSemuaSchema), ctrl.bayarSemuaQris);

module.exports = router;
