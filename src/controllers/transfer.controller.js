/**
 * src/controllers/transfer.controller.js
 * =============================================================================
 * Controller setoran. cabang & kasir dari req.user (owner boleh override cabang).
 * =============================================================================
 */

const transferService = require('../services/transfer.service');
const cloudinaryService = require('../services/cloudinary.service');
const transferModel = require('../models/transfer.model');
const { ok, created } = require('../helpers/response');

function ctxFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
  return { cabangId, kasirId: req.user.id, cabangKode: req.user.cabang_kode || 'ZL01' };
}

/** GET /api/transfer/preview -> rencana setor (tanpa tulis). */
async function preview(req, res, next) {
  try {
    const ctx = ctxFrom(req);
    return ok(res, await transferService.preview(ctx.cabangId), 'Rencana setor');
  } catch (e) { next(e); }
}

/** POST /api/transfer -> eksekusi setor. body opsional { bukti_url }. */
async function setor(req, res, next) {
  try {
    const data = await transferService.setor(ctxFrom(req), { bukti_url: req.body && req.body.bukti_url });
    return created(res, data, 'Setoran berhasil dibuat');
  } catch (e) { next(e); }
}

/** GET /api/transfer -> riwayat setor (?dari=&sampai=). */
async function riwayat(req, res, next) {
  try {
    const ctx = ctxFrom(req);
    const data = await transferService.riwayat(ctx.cabangId, { dari: req.query.dari, sampai: req.query.sampai });
    return ok(res, data, 'Riwayat setor');
  } catch (e) { next(e); }
}

/** POST /api/transfer/:id/bukti -> upload bukti transfer (multipart 'bukti'). */
async function uploadBukti(req, res, next) {
  try {
    if (!req.file) return next(require('../helpers/errors').badRequest('File bukti wajib diunggah'));
    const { url } = await cloudinaryService.uploadBukti(req.file.buffer, {
      folder: 'zlaundry/transfer', publicId: `transfer_${req.params.id}`,
    });
    await transferModel.setBukti(Number(req.params.id), url);
    return ok(res, { bukti_url: url }, 'Bukti tersimpan');
  } catch (e) { next(e); }
}

module.exports = { preview, setor, riwayat, uploadBukti };
