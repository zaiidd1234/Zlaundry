/**
 * src/routes/master.route.js
 * =============================================================================
 * Rute master (read-only Fase 3). Semua perlu login (token staff).
 *   GET /api/master/cabang
 *   GET /api/master/layanan   ?kategori=&cabang_id=(owner)
 *   GET /api/master/barang    ?cabang_id=(owner)
 *   GET /api/master/mesin     ?tipe=washer|dryer&cabang_id=(owner)
 *   GET /api/master/status
 *   GET /api/master/katalog   -> layanan+barang+mesin (untuk layar pesan)
 *   Perubahan #40 (manager/owner) -- /api/master/kelola-barang:
 *     GET  /                 -> semua barang cabang + versi foto + akun penjualan
 *     POST /                 -> tambah { nama, kategori, satuan, harga_jual, harga_beli, stok_minimum, urutan, stok_awal, coa_id? }
 *     PUT  /:id              -> ubah data (harga, minimum, urutan, status, ...)
 *     POST /:id/stok-masuk   -> { qty, keterangan }
 *     POST /:id/opname       -> { stok_fisik, alasan }
 *     GET  /:id/mutasi       -> riwayat stok
 *   Perubahan #58 -- /api/master/kelola-layanan:
 *     GET  /                 -> semua layanan cabang (manager & owner)
 *     PATCH /:id/status      -> { status: aktif|nonaktif } (OWNER saja; min 1 Cuci reguler & 1 Kering aktif)
 *     POST /                 -> tambah (OWNER) { kategori, nama_paket, harga, durasi_menit, berat_maks, deskripsi, status }
 *     PUT  /:id              -> edit (OWNER) nama, harga, berat maks, deskripsi (durasi Cuci/Kering dikunci)
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/master.controller');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth); // semua endpoint master perlu login

router.get('/cabang', ctrl.listCabang);
router.get('/layanan', ctrl.listLayanan);
router.get('/barang', ctrl.listBarang);
router.get('/mesin', ctrl.listMesin);
router.get('/status', ctrl.listStatus);
router.get('/katalog', ctrl.katalog);
// Perubahan #35: kasir/manager/owner ganti foto barang
const fotoSvc = require('../services/barang-foto.service');
const requireRole = require('../middleware/role');
const bolehFoto = requireRole('kasir', 'operator', 'manager', 'owner');
router.put('/barang/:id/foto', bolehFoto, async (req, res, next) => {
  try { res.json({ success: true, message: 'Foto barang disimpan', data: await fotoSvc.simpan(req.user, Number(req.params.id), req.body || {}) }); } catch (e) { next(e); }
});
router.delete('/barang/:id/foto', bolehFoto, async (req, res, next) => {
  try { res.json({ success: true, message: 'Foto barang dihapus', data: await fotoSvc.hapus(req.user, Number(req.params.id)) }); } catch (e) { next(e); }
});

// Perubahan #40: Manager › Barang
const kelola = require('../services/barang-kelola.service');
const mo = requireRole('manager', 'owner');
const cab = (req) => (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id)) ? Number(req.query.cabang_id || req.body.cabang_id) : req.user.cabang_id);
const jawab = (fn, msg = 'OK') => async (req, res, next) => { try { res.json({ success: true, message: msg, data: await fn(req) }); } catch (e) { next(e); } };
router.get('/kelola-barang', mo, jawab((req) => kelola.daftar(cab(req))));
router.post('/kelola-barang', mo, jawab((req) => kelola.tambah(cab(req), req.body || {}, req.user.id), 'Barang ditambahkan'));
router.put('/kelola-barang/:id', mo, jawab((req) => kelola.ubah(Number(req.params.id), req.user.role === 'owner' ? null : req.user.cabang_id, req.body || {}), 'Barang disimpan'));
router.post('/kelola-barang/:id/stok-masuk', mo, jawab((req) => kelola.stokMasuk(Number(req.params.id), req.user.role === 'owner' ? null : req.user.cabang_id, req.body || {}, req.user.id), 'Stok masuk dicatat'));
router.post('/kelola-barang/:id/opname', mo, jawab((req) => kelola.opname(Number(req.params.id), req.user.role === 'owner' ? null : req.user.cabang_id, req.body || {}, req.user.id), 'Stok opname disimpan'));
// Perubahan #58: tab Layanan -- manager lihat, OWNER on/off (lewat web manager + pilihan cabang)
const kelolaLayanan = require('../services/layanan-kelola.service');
router.get('/kelola-layanan', mo, jawab((req) => kelolaLayanan.daftar(cab(req))));
router.patch('/kelola-layanan/:id/status', requireRole('owner'),
  jawab((req) => kelolaLayanan.ubahStatus(Number(req.params.id), cab(req), (req.body || {}).status), 'Status layanan disimpan'));
// Perubahan #59: tambah & edit layanan (OWNER saja)
router.post('/kelola-layanan', requireRole('owner'), jawab((req) => kelolaLayanan.tambah(cab(req), req.body || {}), 'Layanan ditambahkan'));
router.put('/kelola-layanan/:id', requireRole('owner'), jawab((req) => kelolaLayanan.ubah(Number(req.params.id), cab(req), req.body || {}), 'Layanan disimpan'));
router.get('/kelola-barang/:id/mutasi', mo, jawab((req) => kelola.mutasi(Number(req.params.id), req.user.role === 'owner' ? null : req.user.cabang_id, req.query.limit)));

module.exports = router;
