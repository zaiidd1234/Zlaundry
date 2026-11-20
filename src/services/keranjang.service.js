/**
 * src/services/keranjang.service.js
 * =============================================================================
 * Logika keranjang (resource terbatas 25 per cabang, dipakai-ulang).
 *
 * - alokasi(conn, cabangId, transaksiId):
 *     ambil keranjang kosong urutan terkecil (locked), tandai terpakai.
 *     conn WAJIB (dijalankan di dalam transaksi pembuatan order).
 *     Kalau penuh -> lempar 409 (kasir disuruh tunggu/keranjang dibebaskan).
 *
 * - bebaskan(keranjangId, conn?): set kosong lagi (dipanggil saat
 *     proses_antar / sudah_diambil).
 *
 * - papan(cabangId): daftar semua keranjang + ringkasan untuk monitor.
 * =============================================================================
 */

const keranjangModel = require('../models/keranjang.model');
const { conflict } = require('../helpers/errors');

/**
 * Alokasikan satu keranjang untuk transaksi. Harus di dalam transaksi DB (conn).
 * @returns {object} keranjang { id, kode, urutan, ... }
 */
async function alokasi(conn, cabangId, transaksiId) {
  const keranjang = await keranjangModel.lockKosongTerkecil(conn, cabangId);
  if (!keranjang) {
    throw conflict('Semua keranjang sedang terpakai. Tunggu sampai ada yang selesai diambil/diantar.');
  }
  await keranjangModel.tandaiTerpakai(conn, keranjang.id, transaksiId);
  return { ...keranjang, status: 'terpakai', transaksi_aktif_id: transaksiId };
}

/** Bebaskan keranjang (saat status proses_antar / sudah_diambil). */
const bebaskan = (keranjangId, conn = null, transaksiId = null) => keranjangModel.bebaskan(keranjangId, conn, transaksiId);

/** Papan keranjang: list + ringkasan jumlah kosong/terpakai. */
async function papan(cabangId) {
  const list = await keranjangModel.findByCabang(cabangId);
  const terpakai = list.filter((k) => k.status === 'terpakai').length;
  return {
    total: list.length,
    terpakai,
    kosong: list.length - terpakai,
    keranjang: list,
  };
}

module.exports = { alokasi, bebaskan, papan };
