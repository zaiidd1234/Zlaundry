/**
 * src/models/stok-mutasi.model.js
 * =============================================================================
 * Akses tabel `stok_mutasi`.
 * Kolom: id, barang_id, cabang_id, jenis('masuk'|'keluar'), qty,
 *   ref_tipe('pembelian'|'penjualan'|'penyesuaian'), ref_id,
 *   stok_sebelum, stok_sesudah, karyawan_id, waktu, keterangan.
 * =============================================================================
 */

const db = require('../config/database');

/** Insert mutasi. conn opsional. @returns insertId */
async function create(data, conn = null) {
  const sql = `INSERT INTO stok_mutasi
    (barang_id, cabang_id, jenis, qty, ref_tipe, ref_id, stok_sebelum, stok_sesudah, karyawan_id, waktu, keterangan)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    data.barang_id, data.cabang_id, data.jenis, data.qty, data.ref_tipe,
    data.ref_id ?? null, data.stok_sebelum, data.stok_sesudah,
    data.karyawan_id, data.waktu, data.keterangan ?? null,
  ];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

async function findByBarang(barangId, limit = 50) {
  return db.query(
    `SELECT * FROM stok_mutasi WHERE barang_id=? ORDER BY waktu DESC, id DESC LIMIT ?`,
    [barangId, limit]
  );
}

module.exports = { create, findByBarang };
