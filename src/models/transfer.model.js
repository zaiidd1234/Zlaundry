/**
 * src/models/transfer.model.js
 * =============================================================================
 * Akses tabel `transfer` (header setoran kasir -> management).
 * Kolom: id, cabang_id, tanggal, id_transfer, arah, nominal_transfer,
 *   total_pendapatan, total_reimburse, saldo_gopay_snapshot, jumlah_transaksi,
 *   bukti_url, karyawan_id, created_at.
 *
 * arah: 'kasir_ke_management' (setor) | 'management_ke_kasir' (reimburse balik, jika perlu)
 * net (nominal_transfer) = total_pendapatan - total_reimburse.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, tanggal, id_transfer, arah, nominal_transfer,
  total_pendapatan, total_reimburse, saldo_gopay_snapshot, jumlah_transaksi,
  bukti_url, karyawan_id, created_at
`;

/** Insert header transfer. conn WAJIB. @returns insertId */
async function create(conn, data) {
  const sql = `INSERT INTO transfer
    (cabang_id, tanggal, id_transfer, arah, nominal_transfer,
     total_pendapatan, total_reimburse, saldo_gopay_snapshot, jumlah_transaksi, bukti_url, karyawan_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    data.cabang_id, data.tanggal, data.id_transfer, data.arah ?? 'kasir_ke_management',
    data.nominal_transfer, data.total_pendapatan, data.total_reimburse ?? 0,
    data.saldo_gopay_snapshot ?? null, data.jumlah_transaksi ?? 0,
    data.bukti_url ?? null, data.karyawan_id,
  ];
  const [r] = await conn.execute(sql, params);
  return r.insertId;
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM transfer WHERE id = ? LIMIT 1`, [id]);
}

/** Daftar transfer per cabang (opsional rentang tanggal). */
async function findByCabang(cabangId, { dari = null, sampai = null } = {}) {
  let sql = `SELECT ${FIELDS} FROM transfer WHERE cabang_id = ?`;
  const params = [cabangId];
  if (dari) { sql += ` AND DATE(tanggal) >= ?`; params.push(dari); }
  if (sampai) { sql += ` AND DATE(tanggal) <= ?`; params.push(sampai); }
  sql += ` ORDER BY tanggal DESC, id DESC`;
  return db.query(sql, params);
}

/** Set bukti_url (upload bukti transfer menyusul). */
async function setBukti(id, url) {
  await db.pool.execute(`UPDATE transfer SET bukti_url = ? WHERE id = ?`, [url, id]);
}

module.exports = { create, findById, findByCabang, setBukti };
