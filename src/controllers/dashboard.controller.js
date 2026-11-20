/**
 * src/controllers/dashboard.controller.js
 * =============================================================================
 * Dashboard per role. Endpoint tunggal GET /api/dashboard memilih data sesuai
 * role pemanggil: kasir/operator -> dashboardKasir; manager/owner -> dashboardOwner.
 * Owner boleh override cabang via ?cabang_id=.
 * =============================================================================
 */

const dashboardService = require('../services/dashboard.service');
const { ok } = require('../helpers/response');

function cabangCtx(req) {
  if (req.user.role === 'owner' && req.query.cabang_id) return Number(req.query.cabang_id);
  return req.user.cabang_id;
}

/** GET /api/dashboard -> data sesuai role. */
async function index(req, res, next) {
  try {
    const cabangId = cabangCtx(req);
    const role = req.user.role;
    if (role === 'manager' || role === 'owner') {
      return ok(res, await dashboardService.dashboardOwner({ cabangId }), 'Dashboard manajemen');
    }
    // kasir / operator / kurir -> dashboard operasional
    return ok(res, await dashboardService.dashboardKasir(cabangId), 'Dashboard kasir');
  } catch (e) { next(e); }
}

/** GET /api/dashboard/kasir -> paksa dashboard kasir (untuk owner yang mau lihat ops). */
async function kasir(req, res, next) {
  try {
    return ok(res, await dashboardService.dashboardKasir(cabangCtx(req), { pembanding: req.query.pembanding !== '0' }), 'Dashboard kasir');
  } catch (e) { next(e); }
}

/** GET /api/dashboard/manager -> dashboard operasional+finansial manager (1 cabang). */
async function manager(req, res, next) {
  try {
    return ok(res, await dashboardService.dashboardManager(cabangCtx(req)), 'Dashboard manager');
  } catch (e) { next(e); }
}

/** Perubahan #66: GET /api/dashboard/transaksi-per-jam?dari=&sampai= (manager/owner) */
async function transaksiPerJam(req, res, next) {
  try {
    const { today } = require('../helpers/date');
    const ok_ = /^\d{4}-\d{2}-\d{2}$/;
    let dari = ok_.test(req.query.dari || '') ? req.query.dari : today();
    let sampai = ok_.test(req.query.sampai || '') ? req.query.sampai : dari;
    if (sampai < dari) [dari, sampai] = [sampai, dari];
    if ((Date.parse(sampai) - Date.parse(dari)) / 86400000 > 366) {
      throw require('../helpers/errors').badRequest('Rentang maksimal 1 tahun');
    }
    let cab = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_ids) {
      const ids = String(req.query.cabang_ids).split(',').map(Number).filter((n) => n > 0);
      if (ids.length) cab = ids;
    }
    const data = await require('../services/dashboard.service').transaksiPerJam(cab, dari, sampai, { pembanding: req.query.pembanding !== '0' });
    return ok(res, data, 'Transaksi per jam');
  } catch (e) { next(e); }
}

module.exports = { index, kasir, manager, transaksiPerJam };
