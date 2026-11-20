/**
 * src/validations/customer.validation.js
 * =============================================================================
 * Schema order dari customer-app. Sama seperti createOrder staff, tapi cabang_id
 * WAJIB di body (customer tidak punya JWT yang membawa cabang).
 * =============================================================================
 */

const Joi = require('joi');

const customerOrderSchema = Joi.object({
  cabang_id: Joi.number().integer().positive().required()
    .messages({ 'any.required': 'cabang_id wajib diisi' }),
  cabang_kode: Joi.string().trim().max(10).allow(null, ''),

  pelanggan: Joi.object({
    telepon: Joi.string().trim().min(8).max(20).required()
      .messages({ 'any.required': 'Nomor HP wajib diisi' }),
    nama: Joi.string().trim().max(100).allow('', null),
    alamat: Joi.string().trim().max(255).allow('', null),
  }).required(),

  berat_kg: Joi.number().min(0).max(1000).allow(null),
  alamat_antar: Joi.string().trim().max(255).allow('', null),
  metode_bayar: Joi.string().valid('cash', 'qris', 'kiosk').default('cash'),

  layanan: Joi.array().items(
    Joi.object({
      layanan_id: Joi.number().integer().positive().required(),
      qty: Joi.number().positive().allow(null),
    })
  ).default([]),

  barang: Joi.array().items(
    Joi.object({
      barang_id: Joi.number().integer().positive().required(),
      qty: Joi.number().integer().positive().required(),
    })
  ).default([]),

  diskon: Joi.number().min(0).default(0),
  promo_pilihan: Joi.string().valid('gratis_cuci_jumat_berkah', 'gratis_cuci_pelanggan_baru').optional(),
}).custom((val, helpers) => {
  if ((val.layanan?.length || 0) === 0 && (val.barang?.length || 0) === 0) {
    return helpers.error('any.custom');
  }
  return val;
}).messages({ 'any.custom': 'Minimal pilih satu layanan atau barang' });

const customerAksiMesinSchema = Joi.object({
  cabang_id: Joi.number().integer().positive(),
  telepon: Joi.string().trim().min(8).max(20).required()
    .messages({ 'any.required': 'Nomor HP wajib diisi' }),
  mesin_id: Joi.number().integer().positive().allow(null),
});

/** Body POST /api/customer/pembayaran-qris -- generate QR dinamis dari transaksi terpilih. */
const customerBayarQrisSchema = Joi.object({
  cabang_id: Joi.number().integer().positive().required()
    .messages({ 'any.required': 'cabang_id wajib diisi' }),
  telepon: Joi.string().trim().min(8).max(20).required()
    .messages({ 'any.required': 'Nomor HP wajib diisi' }),
  transaksi_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required()
    .messages({ 'array.min': 'Pilih minimal 1 transaksi yang mau dibayar', 'any.required': 'transaksi_ids wajib diisi' }),
});

/** Body POST /api/customer/bayar-semua -- tombol "Bayar Semua" di Pesanan Aktif. */
const customerBayarSemuaSchema = Joi.object({
  cabang_id: Joi.number().integer().positive().required()
    .messages({ 'any.required': 'cabang_id wajib diisi' }),
  telepon: Joi.string().trim().min(8).max(20).required()
    .messages({ 'any.required': 'Nomor HP wajib diisi' }),
});

module.exports = { customerOrderSchema, customerAksiMesinSchema, customerBayarQrisSchema, customerBayarSemuaSchema };
