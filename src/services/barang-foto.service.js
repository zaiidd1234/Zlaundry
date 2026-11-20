/**
 * src/services/barang-foto.service.js
 * =============================================================================
 * Perubahan #35 -- foto barang (pengganti ikon 3D di kartu Pesan / Pesankan).
 * Foto sudah dikecilkan di HP (persegi, jpeg/webp) dan dikirim sebagai data
 * URL. Disimpan di tabel barang_foto (BLOB). URL publik:
 *   /api/customer/barang-foto/:id?v=<versi>   (cache browser 1 tahun)
 * =============================================================================
 */
const db = require('../config/database');
const { badRequest, notFound, forbidden } = require('../helpers/errors');

const MAKS_BYTE = 300 * 1024;
const MIME_OK = ['image/jpeg', 'image/webp', 'image/png'];

/** Map barang_id -> versi foto (detik) untuk 1 cabang. Aman bila tabel belum ada. */
async function versiPerCabang(cabangId) {
  try {
    const rows = await db.query(
      `SELECT bf.barang_id, UNIX_TIMESTAMP(bf.updated_at) AS v FROM barang_foto bf
         JOIN barang b ON b.id = bf.barang_id WHERE b.cabang_id = ?`, [cabangId]);
    return new Map(rows.map((r) => [Number(r.barang_id), Number(r.v)]));
  } catch (e) { return new Map(); }
}

async function cekBarang(user, barangId) {
  const b = await db.queryOne('SELECT id, cabang_id, nama FROM barang WHERE id = ?', [barangId]);
  if (!b) throw notFound('Barang tidak ditemukan');
  if (user.role !== 'owner' && Number(b.cabang_id) !== Number(user.cabang_id)) throw forbidden('Barang bukan milik cabang ini');
  return b;
}

async function simpan(user, barangId, input = {}) {
  await cekBarang(user, barangId);
  const m = String(input.data || '').match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw badRequest('Format foto tidak valid');
  if (!MIME_OK.includes(m[1])) throw badRequest('Foto harus JPG / WEBP / PNG');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw badRequest('Foto kosong');
  if (buf.length > MAKS_BYTE) throw badRequest('Ukuran foto terlalu besar (maks 300 KB setelah dikecilkan)');
  await db.pool.execute(
    `INSERT INTO barang_foto (barang_id, mime, data, ukuran, diubah_oleh) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data), ukuran = VALUES(ukuran), diubah_oleh = VALUES(diubah_oleh), updated_at = NOW()`,
    [barangId, m[1], buf, buf.length, user.id]);
  const r = await db.queryOne('SELECT UNIX_TIMESTAMP(updated_at) AS v FROM barang_foto WHERE barang_id = ?', [barangId]);
  return { barang_id: barangId, foto_v: r ? Number(r.v) : null, ukuran: buf.length };
}

async function hapus(user, barangId) {
  await cekBarang(user, barangId);
  await db.pool.execute('DELETE FROM barang_foto WHERE barang_id = ?', [barangId]);
  return { barang_id: barangId, foto_v: null };
}

async function ambil(barangId) {
  const [rows] = await db.pool.query('SELECT mime, data FROM barang_foto WHERE barang_id = ?', [barangId]);
  return rows[0] || null;
}

module.exports = { versiPerCabang, simpan, hapus, ambil };
