/**
 * src/controllers/performa.controller.js
 * =============================================================================
 * Performa manager/owner (scope cabang dari token).
 *   GET /api/performa/ringkasan?periode=8|30
 * =============================================================================
 */

const performaService = require('../services/performa.service');
const { ok } = require('../helpers/response');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
  // Perubahan #47: owner -> gabungan beberapa / semua cabang (?cabang_ids=1,2)
  if (req.user.role === 'owner' && req.query.cabang_ids) {
    const ids = [...new Set(String(req.query.cabang_ids).split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (ids.length === 1) cabangId = ids[0]; else if (ids.length > 1) cabangId = ids;
  }
  return cabangId;
}

async function ringkasan(req, res, next) {
  try {
    const periode = Number(req.query.periode) === 30 ? 30 : 8; // Perubahan #18: 7 -> 8 hari
    const mode = ['mingguan', 'bulanan'].includes(req.query.mode) ? req.query.mode : 'harian';
    return ok(res, await performaService.ringkasan(cabangFrom(req), { periode, mode }), 'Ringkasan performa');
  } catch (e) { next(e); }
}

async function pelanggan(req, res, next) {
  try {
    const periode = Number(req.query.periode) === 30 ? 30 : 8; // Perubahan #18: 7 -> 8 hari
    const mode = ['mingguan', 'bulanan'].includes(req.query.mode) ? req.query.mode : 'harian'; // Perubahan #70
    return ok(res, await performaService.pelanggan(cabangFrom(req), { periode, mode }), 'Performa pelanggan');
  } catch (e) { next(e); }
}

async function produk(req, res, next) {
  try {
    const periode = Number(req.query.periode) === 30 ? 30 : 8; // Perubahan #18: 7 -> 8 hari
    return ok(res, await performaService.produk(cabangFrom(req), periode), 'Performa produk');
  } catch (e) { next(e); }
}

module.exports = { ringkasan, pelanggan, produk };
