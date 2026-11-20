/**
 * src/controllers/kas-besar.controller.js
 * =============================================================================
 * Kas Besar manager/owner (scope cabang dari token).
 *   GET  /api/kas-besar               -> ringkas (saldo + laba-rugi periode)
 *   GET  /api/kas-besar/setoran       -> riwayat setoran masuk
 *   GET  /api/kas-besar/kategori      -> COA beban (belanja_manager)
 *   GET  /api/kas-besar/beban         -> riwayat beban OPEX
 *   POST /api/kas-besar/beban         -> input beban OPEX { coa_id, nominal, keterangan }
 *   GET  /api/kas-besar/winpay        -> saldo Winpay (Kios-K) + riwayat (#83)
 *   POST /api/kas-besar/winpay/tarik  -> tarik dana Winpay ke kas besar { nominal, keterangan } (#83)
 * query opsional: ?dari=YYYY-MM-DD&sampai=YYYY-MM-DD
 * =============================================================================
 */

const kasBesarService = require('../services/kas-besar.service');
const kasWinpayService = require('../services/kas-winpay.service');
const { ok, created } = require('../helpers/response');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    cabangId = Number(req.query.cabang_id || req.body.cabang_id);
  }
  return cabangId;
}

function rangeFrom(req) {
  const r = {};
  // prioritas: ?bulan=YYYY-MM (1 bulan penuh)
  if (req.query.bulan && /^\d{4}-\d{2}$/.test(req.query.bulan)) {
    const [y, m] = req.query.bulan.split('-').map(Number);
    const akhir = new Date(Date.UTC(y, m, 0)).getUTCDate();
    r.dari = `${req.query.bulan}-01`;
    r.sampai = `${req.query.bulan}-${String(akhir).padStart(2, '0')}`;
  } else {
    if (req.query.dari) r.dari = req.query.dari;
    if (req.query.sampai) r.sampai = req.query.sampai;
  }
  return r;
}

async function ringkas(req, res, next) {
  try { return ok(res, await kasBesarService.ringkas(cabangFrom(req), rangeFrom(req)), 'Ringkas kas besar'); }
  catch (e) { next(e); }
}

async function setoran(req, res, next) {
  try { return ok(res, await kasBesarService.setoran(cabangFrom(req), rangeFrom(req)), 'Riwayat setoran'); }
  catch (e) { next(e); }
}

async function kategori(req, res, next) {
  try { return ok(res, await kasBesarService.kategoriBeban(), 'Kategori beban'); }
  catch (e) { next(e); }
}

async function riwayatBeban(req, res, next) {
  try { return ok(res, await kasBesarService.riwayatBeban(cabangFrom(req), rangeFrom(req)), 'Riwayat beban'); }
  catch (e) { next(e); }
}

/** Perubahan #83: saldo Winpay (Kios-K) */
async function saldoWinpay(req, res, next) {
  try { return ok(res, await kasWinpayService.ringkas(cabangFrom(req), { limit: req.query.limit }), 'Saldo Winpay'); }
  catch (e) { next(e); }
}
async function tarikWinpay(req, res, next) {
  try {
    const data = await kasWinpayService.tarik(cabangFrom(req), req.body || {}, { karyawanId: req.user.id });
    return created(res, data, 'Dana Winpay ditarik ke kas besar');
  } catch (e) { next(e); }
}

async function inputBeban(req, res, next) {
  try {
    const data = await kasBesarService.inputBeban(cabangFrom(req), req.body || {}, { kasirId: req.user.id });
    return created(res, data, 'Beban dicatat');
  } catch (e) { next(e); }
}

async function kategoriAkrual(req, res, next) {
  try { return ok(res, await kasBesarService.kategoriAkrual(), 'Kategori akrual'); }
  catch (e) { next(e); }
}

async function inputAkrual(req, res, next) {
  try {
    const data = await kasBesarService.inputAkrual(cabangFrom(req), req.body || {}, { kasirId: req.user.id });
    return created(res, data, 'Beban akrual dicatat');
  } catch (e) { next(e); }
}

async function detail(req, res, next) {
  try {
    const sisi = req.query.sisi === 'pendapatan' ? 'pendapatan' : 'beban';
    const coaId = req.query.coa_id ? Number(req.query.coa_id) : null;
    return ok(res, await kasBesarService.detailRecord(cabangFrom(req), { sisi, coaId, ...rangeFrom(req) }), 'Detail record');
  } catch (e) { next(e); }
}

async function exportData(req, res, next) {
  try { return ok(res, await kasBesarService.dataExport(cabangFrom(req), rangeFrom(req)), 'Data export'); }
  catch (e) { next(e); }
}

async function kategoriDistribusi(req, res, next) {
  try { return ok(res, await kasBesarService.kategoriDistribusi(), 'Kategori distribusi'); }
  catch (e) { next(e); }
}

async function inputDistribusi(req, res, next) {
  try {
    const data = await kasBesarService.inputDistribusi(cabangFrom(req), req.body || {}, { kasirId: req.user.id });
    return created(res, data, 'Distribusi laba dicatat');
  } catch (e) { next(e); }
}

module.exports = {
  saldoWinpay, tarikWinpay, ringkas, setoran, kategori, riwayatBeban, inputBeban, kategoriAkrual, inputAkrual, detail, exportData, kategoriDistribusi, inputDistribusi };
