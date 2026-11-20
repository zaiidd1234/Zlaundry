/**
 * src/controllers/kas.controller.js
 * =============================================================================
 * Layar Kas Kecil kasir: saldo + mutasi, kategori beban, catat belanja.
 * cabangId dari req.user; owner boleh override via ?cabang_id=.
 * =============================================================================
 */

const kasService    = require('../services/kas.service');
const kasKecilModel = require('../models/kas-kecil.model');
const kasBesarModel = require('../models/kas-besar.model');
const { ok, created } = require('../helpers/response');
const { now } = require('../helpers/date');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    cabangId = Number(req.query.cabang_id || req.body.cabang_id);
  }
  return cabangId;
}

/** GET /api/kas -> saldo + mutasi (hari ini / ?tanggal=YYYY-MM-DD) */
async function ringkas(req, res, next) {
  try {
    const data = await kasService.ringkasKas(cabangFrom(req), req.query.tanggal || null);
    return ok(res, data, 'Kas kecil');
  } catch (e) { next(e); }
}

/** GET /api/kas/mutasi?tanggal=YYYY-MM-DD -> detail mutasi 1 tanggal */
async function mutasiTanggal(req, res, next) {
  try {
    const data = await kasService.mutasiTanggal(cabangFrom(req), req.query.tanggal);
    return ok(res, data, 'Mutasi tanggal');
  } catch (e) { next(e); }
}

/** GET /api/kas/kategori -> kategori beban operasional */
async function kategori(req, res, next) {
  try {
    const data = await kasService.kategoriBeban();
    return ok(res, data, 'Kategori belanja');
  } catch (e) { next(e); }
}

/** POST /api/kas/belanja -> catat belanja operasional */
async function belanja(req, res, next) {
  try {
    const data = await kasService.catatBelanja(cabangFrom(req), req.body, { kasirId: req.user.id });
    return created(res, data, 'Belanja dicatat');
  } catch (e) { next(e); }
}

async function topup(req, res, next) {
  try {
    const data = await kasService.topupGopay(cabangFrom(req), req.body, { kasirId: req.user.id });
    return created(res, data, 'Top up Gopay berhasil');
  } catch (e) { next(e); }
}

/**
 * GET /api/kas/setoran?bulan=YYYY-MM -> riwayat setoran REAL yang sudah masuk
 * ke kas besar (nilai & tanggal setor) dalam 1 bulan, buat tab "Rekap Setoran"
 * di kasir. Default ke bulan berjalan kalau `bulan` tidak dikirim.
 * Reuse kasBesarModel.setoranMasuk (sumber data yang sama dgn punya manager),
 * cuma dibungkus di sini biar kasir (bukan cuma manager/owner) bisa akses,
 * dan otomatis ke-scope ke cabang kasir sendiri (tidak bisa lihat cabang lain).
 */
async function setoran(req, res, next) {
  try {
    const cabangId = cabangFrom(req);

    const bulan = /^\d{4}-\d{2}$/.test(req.query.bulan || '') ? req.query.bulan : now().slice(0, 7);
    const [y, m] = bulan.split('-').map(Number);
    const dari = `${bulan}-01`;
    const sampai = `${bulan}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; // tanggal terakhir bulan itu

    const [rows, bulanTersedia] = await Promise.all([
      kasBesarModel.setoranMasuk(cabangId, { dari, sampai, limit: 200 }),
      kasBesarModel.bulanSetoranTersedia(cabangId),
    ]);

    const list = rows.map((s) => ({
      transfer_id: s.transfer_id,
      id_transfer: s.id_transfer,
      tanggal: s.tanggal,
      nominal_transfer: Number(s.nominal_transfer) || 0,
      total_pendapatan: Number(s.total_pendapatan) || 0,
      total_reimburse: Number(s.total_reimburse) || 0,
      jumlah_transaksi: Number(s.jumlah_transaksi) || 0,
      bukti_url: s.bukti_url || null,
    }));

    // pastikan bulan yang lagi dipilih tetap ada di dropdown walau kebetulan
    // belum punya data setoran (mis. bulan berjalan yang baru mulai)
    const bulanList = bulanTersedia.includes(bulan)
      ? bulanTersedia
      : [bulan, ...bulanTersedia].sort().reverse();

    return ok(res, { bulan, bulan_tersedia: bulanList, list }, 'Riwayat setoran');
  } catch (e) { next(e); }
}

module.exports = { ringkas, mutasiTanggal, kategori, belanja, topup, setoran, belanjaReimburse };

async function belanjaReimburse(req, res, next) {
  try {
    const cabangId = cabangFrom(req);
    const transferId = Number(req.params.transferId);
    const data = await kasKecilModel.belanjaByTransfer(cabangId, transferId);
    return ok(res, data, 'Detail belanja yang di-reimburse');
  } catch (e) { next(e); }
}
