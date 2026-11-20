/**
 * src/controllers/absensi.controller.js
 * =============================================================================
 * Perubahan #27 -- absensi kasir, koreksi, benefit.
 * =============================================================================
 */

const svc = require('../services/absensi.service');
const shiftSvc = require('../services/shift.service');
const { ok, created } = require('../helpers/response');

const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

module.exports = {
  status: h(async (req, res) => ok(res, await svc.status(req.user), 'Status absensi')),
  masuk: h(async (req, res) => created(res, await svc.masuk(req.user, { ...req.body, perangkat: req.get('user-agent') }), 'Absen masuk tercatat')),
  pulang: h(async (req, res) => ok(res, await svc.pulang(req.user, req.body), 'Absen pulang tercatat')),
  riwayat: h(async (req, res) => ok(res, await svc.riwayat(req.user, { dari: req.query.dari, sampai: req.query.sampai }), 'Riwayat absensi')),
  ajukanKoreksi: h(async (req, res) => created(res, await svc.ajukanKoreksi(req.user, req.body), 'Koreksi diajukan, menunggu persetujuan manager')),
  daftarKoreksi: h(async (req, res) => ok(res, await svc.daftarKoreksi(req.user, req.query), 'Daftar koreksi absen')),
  putuskanKoreksi: h(async (req, res) => ok(res, await svc.putuskanKoreksi(req.user, Number(req.params.id), req.body), 'Koreksi diputuskan')),
  // Perubahan #30: lokasi berkala + saklar absensi cabang
  lokasi: h(async (req, res) => ok(res, await svc.laporLokasi(req.user, req.body || {}), 'Lokasi diterima')),
  pengaturan: h(async (req, res) => ok(res, await svc.aturPengaturan(req.user, req.body || {}), 'Pengaturan absensi disimpan')),
  // Perubahan #29: shift, jadwal, rekap
  part: h(async (req, res) => ok(res, await shiftSvc.daftarPart(shiftSvc.cabangDari(req.user, req.query.cabang_id)), 'Part shift')),
  simpanPart: h(async (req, res) => ok(res, await shiftSvc.simpanPart(req.user, req.query.cabang_id, req.body || {}, req.params.id ? Number(req.params.id) : null), 'Part shift disimpan')),
  hapusPart: h(async (req, res) => ok(res, await shiftSvc.hapusPart(req.user, req.query.cabang_id, Number(req.params.id)), 'Part shift dihapus')),
  jadwal: h(async (req, res) => ok(res, await shiftSvc.jadwal(req.user, req.query), 'Jadwal shift')),
  aturJadwal: h(async (req, res) => ok(res, await shiftSvc.aturJadwal(req.user, req.body || {}), 'Jadwal disimpan')),
  rekap: h(async (req, res) => {
    const per = svc.periode(req.query.dari, req.query.sampai);
    const data = await shiftSvc.rekap({ cabangId: shiftSvc.cabangDari(req.user, req.query.cabang_id), ...per,
      karyawanId: req.query.karyawan_id ? Number(req.query.karyawan_id) : null });
    return ok(res, data, 'Rekap absensi');
  }),
  benefit: h(async (req, res) => {
    const cabangId = svc.cabangScope(req.user, req.query.cabang_id);
    const data = await svc.benefit({
      cabangId, dari: req.query.dari, sampai: req.query.sampai,
      karyawanId: req.query.karyawan_id ? Number(req.query.karyawan_id) : null,
      rinci: !!req.query.karyawan_id || !!req.query.semua_rincian,
    });
    return ok(res, data, 'Benefit karyawan');
  }),
};
