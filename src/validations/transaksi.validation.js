/**
 * src/validations/transaksi.validation.js
 * =============================================================================
 * Schema Joi untuk endpoint transaksi.
 * =============================================================================
 */

const Joi = require('joi');

const createOrderSchema = Joi.object({
  pelanggan: Joi.object({
    telepon: Joi.string().trim().min(8).max(20).required()
      .messages({ 'any.required': 'Nomor HP pelanggan wajib diisi' }),
    nama: Joi.string().trim().max(100).allow('', null),
    alamat: Joi.string().trim().max(255).allow('', null),
  }).when('jatah_karyawan', { is: true, then: Joi.optional(), otherwise: Joi.required() }),
  // Perubahan #39: "Pesan untuk saya" (jatah cuci kasir) -- pelanggan diambil dari data karyawan
  jatah_karyawan: Joi.boolean().default(false),

  berat_kg: Joi.number().min(0).max(1000).allow(null),
  metode_bayar: Joi.string().valid('cash', 'qris', 'kiosk').default('cash'),
  alamat_antar: Joi.string().trim().max(255).allow('', null),

  layanan: Joi.array().items(
    Joi.object({
      layanan_id: Joi.number().integer().positive().required(),
      qty: Joi.number().positive().allow(null), // dipakai untuk per_km (jarak)
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
  sumber_pesan: Joi.string().valid('kasir', 'customer_app').default('kasir'),
}).custom((val, helpers) => {
  if ((val.layanan?.length || 0) === 0 && (val.barang?.length || 0) === 0) {
    return helpers.error('any.custom', { message: 'Minimal pilih satu layanan atau barang' });
  }
  return val;
}).messages({ 'any.custom': 'Minimal pilih satu layanan atau barang' });

const bayarSchema = Joi.object({
  metode_bayar: Joi.string().valid('cash', 'qris').optional()
    .messages({ 'any.only': 'Metode bayar harus cash atau qris' }),
});

const idParamSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
});

const pindahStatusSchema = Joi.object({
  status: Joi.string().trim().max(40).allow(null, ''),       // target kode; kosong = next otomatis
  mesin_id: Joi.number().integer().positive().allow(null),   // wajib saat alokasi mesin
  keterangan: Joi.string().trim().max(255).allow(null, ''),
});

const gantiMesinSchema = Joi.object({
  tipe: Joi.string().valid('cuci', 'kering').required(),
  mesin_id: Joi.number().integer().positive().required(),
});

module.exports = { createOrderSchema, bayarSchema, idParamSchema, pindahStatusSchema, gantiMesinSchema };
