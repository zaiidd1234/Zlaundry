/**
 * src/controllers/kiosk.controller.js
 * =============================================================================
 * Endpoint PUBLIK (tanpa auth) buat tablet kiosk dinding (public/kiosk/).
 * Tablet ini device BERSAMA (bukan device pribadi pelanggan) yang cuma
 * punya 2 fungsi: (1) numpad kode bayar 4 digit, (2) nampilin QR dinamis
 * Winpay dari sesi yang cocok. TIDAK ada identitas pelanggan (nama/telepon)
 * yang dikirim/ditampilin ke sini sama sekali -- lihat
 * pembayaran-qris.service.js:sesiByKode().
 * =============================================================================
 */

const cabangModel = require('../models/cabang.model');
const pembayaranQrisService = require('../services/pembayaran-qris.service');
const { ok } = require('../helpers/response');
const { badRequest, notFound } = require('../helpers/errors');

/** GET /api/kiosk/cabang?kode=ZL01 -> validasi & resolve cabang dari kode di URL tablet. */
async function cabangByKode(req, res, next) {
  try {
    const kode = String(req.query.kode || '').trim();
    if (!kode) throw badRequest('Parameter kode wajib diisi');
    const c = await cabangModel.findByKode(kode);
    if (!c || c.status !== 'aktif') throw notFound('Cabang tidak dikenali');
    return ok(res, { id: c.id, kode: c.kode, nama: c.nama }, 'Cabang ditemukan');
  } catch (e) { next(e); }
}

/** GET /api/kiosk/qris?cabang_id=&kode=1234 -> QR dinamis dari kode bayar yang diketik di tablet. */
async function qrisByKode(req, res, next) {
  try {
    const cabangId = Number(req.query.cabang_id);
    const kode = String(req.query.kode || '').trim();
    if (!cabangId) throw badRequest('cabang_id wajib diisi');
    if (!/^\d{4}$/.test(kode)) throw badRequest('Kode bayar harus 4 digit angka');
    const data = await pembayaranQrisService.sesiByKode(cabangId, kode);
    return ok(res, data, 'QR ditemukan');
  } catch (e) { next(e); }
}

module.exports = { cabangByKode, qrisByKode };
