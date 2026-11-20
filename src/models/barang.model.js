/**
 * src/models/barang.model.js
 * =============================================================================
 * Akses tabel `barang` (produk berstok) — read Fase 3.
 * Kolom: id, cabang_id, coa_id, nama, satuan, harga_beli, harga_jual,
 *   stok_terkini, stok_minimum, status, urutan, created_at, updated_at.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, coa_id, nama, kategori, satuan, harga_beli, harga_jual,
  stok_terkini, stok_minimum, status, urutan, created_at, updated_at
`;

async function findByCabang(cabangId, { includeNonaktif = false } = {}) {
  let sql = `SELECT ${FIELDS} FROM barang WHERE cabang_id = ?`;
  if (!includeNonaktif) sql += ` AND status = 'aktif'`;
  sql += ` ORDER BY urutan ASC, nama ASC`;
  return db.query(sql, [cabangId]);
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM barang WHERE id = ? LIMIT 1`, [id]);
}

/** Barang dengan stok di bawah/sama minimum (untuk alert). */
async function findLowStock(cabangId) {
  const sql = `SELECT ${FIELDS} FROM barang
               WHERE cabang_id = ? AND status='aktif' AND stok_terkini <= stok_minimum
               ORDER BY stok_terkini ASC`;
  return db.query(sql, [cabangId]);
}

module.exports = { findByCabang, findById, findLowStock, getStokLocked, setStok };

/** Ambil stok_terkini dengan lock (FOR UPDATE) di dalam transaksi. */
async function getStokLocked(conn, id) {
  const [rows] = await conn.execute(`SELECT stok_terkini FROM barang WHERE id=? FOR UPDATE`, [id]);
  return rows.length ? Number(rows[0].stok_terkini) : null;
}

/** Set stok_terkini (dalam transaksi). */
async function setStok(conn, id, nilai) {
  await conn.execute(`UPDATE barang SET stok_terkini=? WHERE id=?`, [nilai, id]);
}
