/**
 * src/models/keranjang.model.js
 * =============================================================================
 * Akses tabel `keranjang`.
 * Kolom: id, cabang_id, urutan, kode, status('kosong'|'terpakai'),
 *   transaksi_aktif_id, updated_at.
 *
 * Alokasi memakai lock baris (FOR UPDATE) -> WAJIB dipanggil dengan koneksi
 * transaksi (conn) supaya tidak ada dua transaksi merebut keranjang yang sama.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `id, cabang_id, urutan, kode, status, transaksi_aktif_id, updated_at`;

/** Semua keranjang per cabang (untuk monitor papan keranjang). */
async function findByCabang(cabangId) {
  return db.query(
    `SELECT ${FIELDS} FROM keranjang WHERE cabang_id = ? ORDER BY urutan ASC`,
    [cabangId]
  );
}

/** Hitung keranjang kosong (untuk cek ketersediaan sebelum alih). */
async function countKosong(cabangId) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS n FROM keranjang WHERE cabang_id = ? AND status = 'kosong'`,
    [cabangId]
  );
  return row ? Number(row.n) : 0;
}

/**
 * Ambil 1 keranjang kosong urutan terkecil DENGAN LOCK (FOR UPDATE).
 * conn WAJIB (di dalam transaksi). Return baris keranjang atau null kalau penuh.
 */
async function lockKosongTerkecil(conn, cabangId) {
  const [rows] = await conn.execute(
    `SELECT ${FIELDS} FROM keranjang
     WHERE cabang_id = ? AND status = 'kosong'
     ORDER BY urutan ASC LIMIT 1
     FOR UPDATE`,
    [cabangId]
  );
  return rows.length ? rows[0] : null;
}

/** Tandai keranjang terpakai oleh sebuah transaksi (dalam transaksi DB). */
async function tandaiTerpakai(conn, keranjangId, transaksiId) {
  await conn.execute(
    `UPDATE keranjang SET status = 'terpakai', transaksi_aktif_id = ? WHERE id = ?`,
    [transaksiId, keranjangId]
  );
}

/** Bebaskan keranjang (saat proses_antar / sudah_diambil). Bisa pakai conn atau pool. */
async function bebaskan(keranjangId, conn = null, transaksiId = null) {
  const runner = conn || db.pool;
  // Perubahan #19: kalau transaksiId diberikan, keranjang HANYA dibebaskan
  // bila memang tercatat dipakai transaksi itu (atau tanpa pemilik). Mencegah
  // order lama membebaskan keranjang yang sudah dipakai order lain. Keranjang
  // yang benar-benar dipegang transaksi ini tetap dibebaskan walau keranjang_id
  // di order-nya sempat salah.
  if (transaksiId) {
    const [r] = await runner.execute(
      `UPDATE keranjang SET status = 'kosong', transaksi_aktif_id = NULL
        WHERE transaksi_aktif_id = ? OR (id = ? AND transaksi_aktif_id IS NULL)`,
      [transaksiId, keranjangId]
    );
    return r.affectedRows;
  }
  const [r] = await runner.execute(
    `UPDATE keranjang SET status = 'kosong', transaksi_aktif_id = NULL WHERE id = ?`,
    [keranjangId]
  );
  return r.affectedRows;
}

async function findById(id, conn = null) {
  const runner = conn || db.pool;
  const [rows] = await runner.execute(`SELECT ${FIELDS} FROM keranjang WHERE id = ? LIMIT 1`, [id]);
  return rows.length ? rows[0] : null;
}

module.exports = { findByCabang, countKosong, lockKosongTerkecil, tandaiTerpakai, bebaskan, findById };
