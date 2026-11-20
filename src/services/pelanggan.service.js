/**
 * src/services/pelanggan.service.js
 * =============================================================================
 * Identitas pelanggan = nomor HP (tidak ada login formal).
 * - identifikasi(cabangId, telepon, nama, alamat):
 *     normalisasi HP, cari by (cabang, telepon). Ketemu -> pakai. Tidak -> buat baru.
 *     Inilah "login implicit" pelanggan saat submit pesanan.
 *     Bisa jalan di dalam transaksi DB (parameter conn) supaya atomik dgn pembuatan transaksi.
 * - getById / cari : util untuk kasir.
 *
 * Return objek { pelanggan, baru } -> baru=true kalau pelanggan baru dibuat.
 * =============================================================================
 */

const pelangganModel = require('../models/pelanggan.model');
const { normalizeHp } = require('../helpers/phone');
const { badRequest, notFound } = require('../helpers/errors');

/**
 * Lookup-or-create pelanggan berdasarkan HP.
 * @param {object} p { cabangId, telepon, nama, alamat? }
 * @param {object} conn koneksi transaksi (opsional)
 */
async function identifikasi({ cabangId, telepon, nama, alamat = null }, conn = null) {
  const hp = normalizeHp(telepon);
  if (!hp || hp.length < 9) throw badRequest('Nomor HP tidak valid');

  const existing = await pelangganModel.findByTelepon(cabangId, hp, conn);
  if (existing) {
    return { pelanggan: existing, baru: false };
  }

  if (!nama || !nama.trim()) throw badRequest('Nama wajib diisi untuk pelanggan baru');

  // ANTI RACE-CONDITION: dua request nyaris bersamaan (double-tap submit, retry
  // jaringan lambat) bisa sama-sama lolos cek "belum ada" di atas, lalu sama-sama
  // coba INSERT. UNIQUE KEY (cabang_id, telepon) bikin salah satunya kena
  // ER_DUP_ENTRY. Tangkap di sini dan pakai baris yang baru dibuat request lain,
  // JANGAN biarkan errornya nyembur jadi 409 ke pelanggan baru yang sah.
  try {
    const id = await pelangganModel.create({ cabangId, nama: nama.trim(), telepon: hp, alamat }, conn);
    const pelanggan = await pelangganModel.findById(id, conn);
    return { pelanggan, baru: true };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const raced = await pelangganModel.findByTelepon(cabangId, hp, conn);
      if (raced) return { pelanggan: raced, baru: false };
    }
    throw err;
  }
}

async function getById(id) {
  const p = await pelangganModel.findById(id);
  if (!p) throw notFound('Pelanggan tidak ditemukan');
  return p;
}

const cari = (cabangId, keyword) => pelangganModel.search(cabangId, keyword || '');

module.exports = { identifikasi, getById, cari };
