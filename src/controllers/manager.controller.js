/**
 * src/controllers/manager.controller.js
 * =============================================================================
 * Controller laporan (manager/owner). cabang dari req.user; owner boleh override
 * ?cabang_id=. Rentang via ?dari=&sampai= (laba rugi) / ?bulan= (performa).
 * =============================================================================
 */

const laporanService = require('../services/laporan.service');
const { ok } = require('../helpers/response');

function cabangCtx(req) {
  if (req.user.role === 'owner' && req.query.cabang_id) return Number(req.query.cabang_id);
  return req.user.cabang_id;
}

/** GET /api/laporan/laba-rugi?dari=&sampai=&cabang_id= */
async function labaRugi(req, res, next) {
  try {
    const data = await laporanService.labaRugi(cabangCtx(req), { dari: req.query.dari, sampai: req.query.sampai });
    return ok(res, data, 'Laba rugi');
  } catch (e) { next(e); }
}

/** GET /api/laporan/performa?bulan=YYYY-MM&cabang_id= */
async function performa(req, res, next) {
  try {
    const data = await laporanService.performaCabang(cabangCtx(req), { bulan: req.query.bulan || null });
    return ok(res, data, 'Performa cabang');
  } catch (e) { next(e); }
}

module.exports = { labaRugi, performa };
