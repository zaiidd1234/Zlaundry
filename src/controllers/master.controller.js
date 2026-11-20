/**
 * src/controllers/master.controller.js
 * =============================================================================
 * Controller master (read). cabangId default = req.user.cabang_id,
 * tapi owner boleh override lewat query ?cabang_id=.
 * =============================================================================
 */

const masterService = require('../services/master.service');
const { ok } = require('../helpers/response');

/** Tentukan cabang yang dilihat: query override hanya untuk owner. */
function resolveCabangId(req) {
  if (req.user.role === 'owner' && req.query.cabang_id) {
    return Number(req.query.cabang_id);
  }
  return req.user.cabang_id;
}

async function listCabang(req, res, next) {
  try { return ok(res, await masterService.listCabang(), 'Daftar cabang'); }
  catch (e) { next(e); }
}

async function listLayanan(req, res, next) {
  try {
    const data = await masterService.listLayanan(resolveCabangId(req), { kategori: req.query.kategori || null });
    return ok(res, data, 'Daftar layanan');
  } catch (e) { next(e); }
}

async function listBarang(req, res, next) {
  try { return ok(res, await masterService.listBarang(resolveCabangId(req)), 'Daftar barang'); }
  catch (e) { next(e); }
}

async function listMesin(req, res, next) {
  try {
    const data = await masterService.listMesin(resolveCabangId(req), { tipe: req.query.tipe || null });
    return ok(res, data, 'Daftar mesin');
  } catch (e) { next(e); }
}

async function listStatus(req, res, next) {
  try { return ok(res, await masterService.listStatus(), 'Daftar status'); }
  catch (e) { next(e); }
}

async function katalog(req, res, next) {
  try { return ok(res, await masterService.katalog(resolveCabangId(req)), 'Katalog'); }
  catch (e) { next(e); }
}

module.exports = { listCabang, listLayanan, listBarang, listMesin, listStatus, katalog };
