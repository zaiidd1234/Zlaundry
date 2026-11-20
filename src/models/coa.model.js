/**
 * src/models/coa.model.js
 * =============================================================================
 * Akses tabel `coa` (Chart of Accounts, berjenjang via parent_id).
 * Kolom: id, kode, nama, tipe, parent_id, level, is_kas, created_at, updated_at.
 *
 * Grup induk (root) menentukan kategori P&L:
 *   4 = PENDAPATAN, 5 = COGS/HPP, 6 = COS (biaya jasa), 7 = OPEX.
 * akarDari(id) -> menelusuri parent sampai root (untuk klasifikasi laba rugi).
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `id, kode, nama, tipe, parent_id`;

async function findAll() {
  return db.query(`SELECT ${FIELDS} FROM coa ORDER BY kode ASC`);
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM coa WHERE id = ? LIMIT 1`, [id]);
}

/**
 * Peta id -> { id, parent_id, kode, nama } untuk seluruh COA (sekali query),
 * dipakai helper laba-rugi menelusuri akar tanpa query berulang.
 */
async function peta() {
  const rows = await db.query(`SELECT id, parent_id, kode, nama FROM coa`);
  const map = new Map();
  rows.forEach((r) => map.set(r.id, r));
  return map;
}

/** Telusuri root (induk teratas) dari sebuah coa_id memakai peta. */
function akarDari(coaId, map) {
  let cur = map.get(coaId);
  if (!cur) return null;
  while (cur.parent_id && map.has(cur.parent_id)) cur = map.get(cur.parent_id);
  return cur; // root: { id, parent_id:null, kode, nama }
}

module.exports = { findAll, findById, peta, akarDari };
