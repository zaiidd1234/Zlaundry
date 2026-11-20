/**
 * src/controllers/pembayaran-qris.controller.js
 * =============================================================================
 * Endpoint kasir (login) buat generate QRIS dinamis (Winpay) -- dipakai di
 * menu Pesankan, buat pelanggan yang bayar di outlet. cabangId dari req.user;
 * owner boleh override via ?cabang_id= (sama kayak pelanggan.controller.js).
 * =============================================================================
 */

const pembayaranQrisService = require('../services/pembayaran-qris.service');
const { ok, created } = require('../helpers/response');
const { badRequest } = require('../helpers/errors');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
  return cabangId;
}

/** GET /api/pembayaran-qris/tagihan?pelanggan_id= -> daftar transaksi belum lunas milik pelanggan itu. */
async function tagihan(req, res, next) {
  try {
    const pelangganId = Number(req.query.pelanggan_id);
    if (!pelangganId) throw badRequest('pelanggan_id wajib diisi');
    const data = await pembayaranQrisService.daftarTagihan(pelangganId, cabangFrom(req));
    return ok(res, data, 'Daftar tagihan belum lunas');
  } catch (e) { next(e); }
}

/** POST /api/pembayaran-qris  body: { pelanggan_id, transaksi_ids:[] } -> generate QR dinamis. */
async function generate(req, res, next) {
  try {
    const data = await pembayaranQrisService.buatSesiPembayaran({
      cabangId: cabangFrom(req),
      pelangganId: Number(req.body.pelanggan_id),
      transaksiIds: req.body.transaksi_ids,
      dibuatOlehKaryawanId: req.user.id,
    });
    return created(res, data, 'QR pembayaran dibuat, silakan scan');
  } catch (e) { next(e); }
}

/** GET /api/pembayaran-qris/:id -> polling status bayar. */
async function status(req, res, next) {
  try {
    const data = await pembayaranQrisService.statusSesi(Number(req.params.id));
    return ok(res, data, 'Status pembayaran');
  } catch (e) { next(e); }
}

module.exports = { tagihan, generate, status };
