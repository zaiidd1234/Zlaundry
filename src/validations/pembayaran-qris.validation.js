/**
 * src/validations/pembayaran-qris.validation.js
 * =============================================================================
 * Schema buat endpoint kasir generate QRIS dinamis (Winpay).
 * =============================================================================
 */

const Joi = require('joi');

const generateQrisSchema = Joi.object({
  pelanggan_id: Joi.number().integer().positive().required()
    .messages({ 'any.required': 'pelanggan_id wajib diisi' }),
  transaksi_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required()
    .messages({ 'array.min': 'Pilih minimal 1 transaksi yang mau dibayar', 'any.required': 'transaksi_ids wajib diisi' }),
});

module.exports = { generateQrisSchema };
