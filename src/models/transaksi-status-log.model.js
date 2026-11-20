/**
 * src/models/transaksi-status-log.model.js
 * =============================================================================
 * Akses tabel `transaksi_status_log` (riwayat perpindahan status).
 * Kolom: id, transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan.
 * =============================================================================
 */

const db = require('../config/database');

/** Catat 1 perpindahan status. conn opsional. */
async function create(data, conn = null) {
  const sql = `INSERT INTO transaksi_status_log
    (transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan)
    VALUES (?,?,?,?,?,?)`;
  const params = [
    data.transaksi_id, data.status_id, data.karyawan_id,
    data.mesin_id ?? null, data.waktu, data.keterangan ?? null,
  ];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

/** Riwayat status sebuah transaksi (urut waktu) + label status. */
async function findByTransaksi(transaksiId) {
  const rows = await db.query(
    `SELECT l.id, l.status_id, s.kode, s.nama, l.karyawan_id, l.mesin_id, l.waktu, l.keterangan,
            m.kode_mesin, m.nama_mesin, m.tipe AS mesin_tipe
     FROM transaksi_status_log l
     JOIN status_master s ON s.id = l.status_id
     LEFT JOIN mesin m ON m.id = l.mesin_id
     WHERE l.transaksi_id = ?
     ORDER BY l.waktu ASC, l.id ASC`,
    [transaksiId]
  );
  // Perubahan #23: buang baris kembar (status, mesin & keterangan sama, < 60
  // detik dari baris sebelumnya) -- sisa bug status dobel di data lama.
  const ms = (w) => (w instanceof Date ? w.getTime() : new Date(String(w).replace(' ', 'T')).getTime());
  return rows.filter((r, i) => {
    const p = rows[i - 1];
    if (!p) return true;
    return !(Number(p.status_id) === Number(r.status_id)
      && Number(p.mesin_id || 0) === Number(r.mesin_id || 0)
      && (p.keterangan || '') === (r.keterangan || '')
      && Math.abs(ms(r.waktu) - ms(p.waktu)) < 60000);
  });
}

module.exports = { create, findByTransaksi };
