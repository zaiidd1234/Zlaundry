/**
 * src/services/master.service.js
 * =============================================================================
 * Service master data (read-only Fase 3): katalog yang dibutuhkan kasir/UI.
 * CRUD penuh menyusul. Fokus sekarang: ambil layanan/barang/mesin/status/cabang.
 *
 * Default cabang diambil dari konteks user (req.user.cabang_id) di controller.
 * =============================================================================
 */

const cabangModel = require('../models/cabang.model');
const layananModel = require('../models/layanan.model');
const barangModel = require('../models/barang.model');
const mesinModel = require('../models/mesin.model');
const statusModel = require('../models/status-master.model');
const { notFound } = require('../helpers/errors');

const listCabang = () => cabangModel.findAll();

async function getCabang(id) {
  const c = await cabangModel.findById(id);
  if (!c) throw notFound('Cabang tidak ditemukan');
  return c;
}

const listLayanan = (cabangId, opts) => layananModel.findByCabang(cabangId, opts);
const listBarang = (cabangId, opts) => barangModel.findByCabang(cabangId, opts);
const listMesin = (cabangId, opts) => mesinModel.findByCabang(cabangId, opts);
const listStatus = () => statusModel.findAll();

/**
 * Katalog gabungan untuk layar pesan kasir/customer: layanan + barang + mesin
 * sekaligus. Barang yang stok_terkini-nya habis (<=0) SENGAJA disaring dari
 * sini -- tidak boleh muncul di pilihan kasir/customer saat bikin pesanan.
 * Perubahan #41: berlaku untuk SEMUA kategori (laundry & cafe); stok dikelola
 * manager di menu Barang.
 */
async function katalog(cabangId) {
  const [layanan, barangSemua, mesin] = await Promise.all([
    layananModel.findByCabang(cabangId),
    barangModel.findByCabang(cabangId),
    mesinModel.findByCabang(cabangId),
  ]);
  // Perubahan #35: versi foto barang (null = pakai ikon 3D)
  const versiFoto = await require('./barang-foto.service').versiPerCabang(cabangId);
  const barang = barangSemua.filter((b) => Number(b.stok_terkini) > 0)
    .map((b) => ({ ...b, foto_v: versiFoto.get(Number(b.id)) || null }));
  // Perubahan #83: metode bayar yang aktif di cabang (customer & kasir pesan)
  const metode_bayar = await require('./metode-bayar.service').aktif(cabangId).catch(() => null);
  return { layanan, barang, mesin, metode_bayar };
}

module.exports = {
  listCabang, getCabang,
  listLayanan, listBarang, listMesin, listStatus,
  katalog,
};
