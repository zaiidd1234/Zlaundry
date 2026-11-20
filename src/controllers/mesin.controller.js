/**
 * src/controllers/mesin.controller.js
 * =============================================================================
 * Aksi mesin oleh MANAGER/OWNER (1 cabang):
 *   POST /api/mesin/:id/trigger   { command? }   -> trigger IoT manual (paksa nyala)
 *   POST /api/mesin/:id/status    { status }     -> aktif|maintenance|nonaktif
 *   POST /api/mesin/switch        { dari, ke }   -> pindah transaksi jalan ke mesin sejenis
 * cabangId dari token; owner boleh override via body.cabang_id.
 * =============================================================================
 */

const mesinService = require('../services/mesin.service');
const antrianService = require('../services/antrian-mesin.service');
const mesinModel  = require('../models/mesin.model');
const mesinUsageModel = require('../models/mesin-usage.model');
const { ok } = require('../helpers/response');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    cabangId = Number(req.query.cabang_id || req.body.cabang_id);
  }
  return cabangId;
}

async function commands(req, res, next) {
  try {
    const data = await mesinService.daftarCommand(Number(req.params.id), cabangFrom(req));
    return ok(res, data, 'Daftar command mesin');
  } catch (e) { next(e); }
}

async function trigger(req, res, next) {
  try {
    const data = await mesinService.triggerManual(Number(req.params.id), req.body.command || 'start', cabangFrom(req), {
      alasan: req.body.alasan, karyawanId: req.user.id,
    });
    return ok(res, data, 'Trigger IoT dikirim');
  } catch (e) { next(e); }
}

async function status(req, res, next) {
  try {
    const data = await mesinService.ubahStatus(Number(req.params.id), req.body.status, cabangFrom(req));
    // Mesin baru diaktifkan lagi (mis. selesai maintenance) -> "mesin baru
    // bebas", coba alokasikan otomatis ke antrian terdepan kalau cabang ini
    // mode 'otomatis'. Panggil dari controller (bukan dari mesin.service.js)
    // biar gak circular import (transaksi.service.js sudah require mesin.service.js).
    if (data.status === 'aktif') {
      require('../services/transaksi.service').cobaAlokasikanAntrian(data.cabang_id, data.tipe)
        .catch((e) => require('../config/logger').error('Cascade antrian (ubahStatus) gagal', { err: e.message }));
    }
    return ok(res, data, 'Status mesin diubah');
  } catch (e) { next(e); }
}

async function pindah(req, res, next) {
  try {
    const data = await mesinService.switchMesin(Number(req.body.dari), Number(req.body.ke), cabangFrom(req));
    return ok(res, data, 'Transaksi dipindah ke mesin lain');
  } catch (e) { next(e); }
}

module.exports = { trigger, status, pindah, commands , setIotProvider , lastOrder, riwayatHariIni };

async function setIotProvider(req, res, next) {
  try {
    const { provider } = req.body;
    const data = await mesinService.setIotProvider(Number(req.params.id), provider, cabangFrom(req));
    return ok(res, data, `IoT provider mesin diubah ke ${provider}`);
  } catch (e) { next(e); }
}

async function lastOrder(req, res, next) {
  try {
    const data = await mesinModel.lastOrderByMesin(Number(req.params.id));
    return ok(res, data, 'Order terakhir mesin');
  } catch (e) { next(e); }
}

/** GET /api/mesin/:id/riwayat-hari-ini?tanggal=YYYY-MM-DD -- dipakai kasir klik mesin di papan status (idle/booking/jalan). */
async function riwayatHariIni(req, res, next) {
  try {
    const data = await mesinUsageModel.byMesinHariIni(Number(req.params.id), req.query.tanggal || null);
    return ok(res, data, 'Riwayat pemakaian mesin hari ini');
  } catch (e) { next(e); }
}

/** GET /api/mesin/:id/popup -- data popup kartu mesin di dashboard kasir. */
async function popup(req, res, next) {
  try {
    const data = await antrianService.popupMesin(Number(req.params.id), cabangFrom(req));
    return ok(res, data, 'Popup mesin');
  } catch (e) { next(e); }
}

/** POST /api/mesin/:id/antrian/geser  body: { transaksi_id, arah: 'naik'|'turun', alasan } */
async function geserAntrian(req, res, next) {
  try {
    const b = req.body || {};
    const data = await antrianService.geserAntrian(Number(req.params.id), {
      transaksiId: Number(b.transaksi_id), arah: b.arah, alasan: b.alasan,
      karyawanId: req.user.id, cabangId: cabangFrom(req),
    });
    return ok(res, data, 'Urutan antrian diubah');
  } catch (e) { next(e); }
}

/** Perubahan #20: GET /api/mesin/pindah-opsi?transaksi_id= -- pilihan mesin tujuan. */
async function pindahOpsi(req, res, next) {
  try { return ok(res, await antrianService.opsiPindah(cabangFrom(req), Number(req.query.transaksi_id)), 'Pilihan mesin'); } catch (e) { next(e); }
}
/** GET /api/mesin/:id/ambil-kandidat -- order antre di mesin lain yang bisa diambil mesin ini. */
async function ambilKandidat(req, res, next) {
  try { return ok(res, await antrianService.kandidatAmbil(Number(req.params.id), cabangFrom(req)), 'Kandidat'); } catch (e) { next(e); }
}
/** POST /api/mesin/:id/antrian/pindah {transaksi_id, posisi, alasan} -- :id = mesin TUJUAN. */
async function pindahAntrian(req, res, next) {
  try {
    const b = req.body || {};
    const data = await antrianService.pindahMesin(Number(b.transaksi_id), {
      mesinTujuanId: Number(req.params.id), posisi: b.posisi || 'depan', alasan: b.alasan,
      karyawanId: req.user.id, cabangId: cabangFrom(req),
    });
    return ok(res, data, `Dipindah ke ${data.ke}`);
  } catch (e) { next(e); }
}
module.exports.pindahOpsi = pindahOpsi;
module.exports.ambilKandidat = ambilKandidat;
module.exports.pindahAntrian = pindahAntrian;
module.exports.popup = popup;
module.exports.geserAntrian = geserAntrian;
