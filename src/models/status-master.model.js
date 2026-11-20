/**
 * src/models/status-master.model.js
 * =============================================================================
 * Akses tabel `status_master` (18 status workflow) — read.
 * Kolom: id, kode, nama, urutan, dipicu_kategori, is_iot, created_at, updated_at.
 * Dipakai state-machine (Fase 5) & untuk menampilkan label status.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `id, kode, nama, urutan, dipicu_kategori, is_iot, created_at, updated_at`;

/** Semua status, urut sesuai 'urutan'. */
async function findAll() {
  return db.query(`SELECT ${FIELDS} FROM status_master ORDER BY urutan ASC`);
}

async function findByKode(kode) {
  return db.queryOne(`SELECT ${FIELDS} FROM status_master WHERE kode = ? LIMIT 1`, [kode]);
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM status_master WHERE id = ? LIMIT 1`, [id]);
}

module.exports = { findAll, findByKode, findById };
