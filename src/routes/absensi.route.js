/**
 * src/routes/absensi.route.js
 * =============================================================================
 * Perubahan #27 -- Absensi kasir (perlu login; TIDAK kena gerbang absen).
 *   GET  /api/absensi/status           -> sesi aktif + lupa pulang
 *   POST /api/absensi/masuk            -> { lat, lng, akurasi, lembur_ganti_shift }
 *   POST /api/absensi/pulang           -> { lat, lng, akurasi, pulang_lembur }
 *   GET  /api/absensi/riwayat          -> ?dari&sampai  (sesi + benefit sendiri)
 *   POST /api/absensi/koreksi          -> { absensi_id, jam_pulang, alasan, pulang_lembur }
 *   GET  /api/absensi/koreksi          -> manager/owner: ?status=menunggu|semua
 *   POST /api/absensi/koreksi/:id/putuskan -> manager/owner: { keputusan: setuju|tolak, catatan }
 *   GET  /api/absensi/benefit          -> manager/owner: ?dari&sampai[&karyawan_id][&cabang_id]
 *   GET  /api/absensi/shift            -> part shift cabang (semua role)
 *   POST/PUT/DELETE /api/absensi/shift[/:id] -> manager/owner: atur part
 *   GET  /api/absensi/jadwal           -> jadwal mingguan efektif (?tanggal)
 *   PUT  /api/absensi/jadwal           -> manager/owner: { hari, shift_part_id, karyawan_id|null }
 *   GET  /api/absensi/rekap            -> manager/owner: ?dari&sampai[&karyawan_id] rekap per shift/part
 *   GET  /api/absensi/jatah            -> Perubahan #39: jatah cuci minggu ini (akun sendiri)
 *   PUT  /api/absensi/jatah/telepon    -> { telepon } nomor HP sendiri (dipakai order jatah)
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/absensi.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);
router.get('/status', ctrl.status);
router.post('/masuk', ctrl.masuk);
router.post('/pulang', ctrl.pulang);
router.post('/lokasi', ctrl.lokasi);                 // Perubahan #30: laporan lokasi berkala (pulang otomatis)
router.get('/riwayat', ctrl.riwayat);
router.post('/koreksi', ctrl.ajukanKoreksi);
router.get('/koreksi', requireRole('manager', 'owner'), ctrl.daftarKoreksi);
router.post('/koreksi/:id/putuskan', requireRole('manager', 'owner'), ctrl.putuskanKoreksi);
router.get('/benefit', requireRole('manager', 'owner'), ctrl.benefit);
// Perubahan #29: shift & jadwal mingguan + rekap absensi per shift
const mo = requireRole('manager', 'owner');
router.get('/shift', ctrl.part);
router.post('/shift', mo, ctrl.simpanPart);
router.put('/shift/:id', mo, ctrl.simpanPart);
router.delete('/shift/:id', mo, ctrl.hapusPart);
router.get('/jadwal', ctrl.jadwal);
router.put('/jadwal', mo, ctrl.aturJadwal);
router.get('/rekap', mo, ctrl.rekap);
router.put('/pengaturan', mo, ctrl.pengaturan);      // Perubahan #29b: saklar absensi cabang

// Perubahan #39: jatah cuci kasir
const jatahService = require('../services/jatah.service');
const ok = (res, data, message = 'OK') => res.json({ success: true, message, data });
router.get('/jatah', async (req, res, next) => { try { ok(res, await jatahService.status(req.user.id)); } catch (e) { next(e); } });
router.put('/jatah/telepon', async (req, res, next) => {
  try { ok(res, await jatahService.setTelepon(req.user.id, req.body && req.body.telepon), 'Nomor HP disimpan'); } catch (e) { next(e); }
});

module.exports = router;
