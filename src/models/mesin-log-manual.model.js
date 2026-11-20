/**
 * src/models/mesin-log-manual.model.js
 * =============================================================================
 * Audit trail bersama untuk 2 aksi manual yang berpotensi disalahgunakan kalau
 * tidak tercatat:
 *   - restart_proses (kasir): restart mesin yang gagal trigger fisik, transaksi_id wajib
 *   - trigger_manual (manager): kirim command IoT mentah, transaksi_id boleh NULL (testing)
 * Kolom: id, mesin_id, jenis_aksi, transaksi_id, command, alasan, karyawan_id,
 *   cabang_id, created_at.
 * =============================================================================
 */

const db = require('../config/database');

async function create({ mesinId, jenisAksi, transaksiId = null, command = null, alasan, karyawanId, cabangId }, conn = null) {
  const runner = conn || db.pool;
  const [r] = await runner.execute(
    `INSERT INTO mesin_log_manual (mesin_id, jenis_aksi, transaksi_id, command, alasan, karyawan_id, cabang_id)
     VALUES (?,?,?,?,?,?,?)`,
    [mesinId, jenisAksi, transaksiId, command, alasan, karyawanId, cabangId]
  );
  return r.insertId;
}

/** Log trigger_manual TERAKHIR untuk 1 mesin -- dipakai buat self-heal status
 * mesin yang "nyangkut" jalan gara-gara timer auto-idle di memori hilang
 * (mis. server restart di tengah proses). Lihat mesinService.rilisManualMacet(). */
async function lastTriggerManual(mesinId) {
  return db.queryOne(
    `SELECT command, created_at FROM mesin_log_manual
     WHERE mesin_id = ? AND jenis_aksi = 'trigger_manual'
     ORDER BY created_at DESC LIMIT 1`,
    [mesinId]
  );
}

/** Histori per mesin (buat ditelusuri kalau ada kejadian aneh). */
async function findByMesin(mesinId, limit = 50) {
  return db.query(
    `SELECT l.*, k.nama AS nama_karyawan
     FROM mesin_log_manual l
     LEFT JOIN karyawan k ON k.id = l.karyawan_id
     WHERE l.mesin_id = ? ORDER BY l.created_at DESC LIMIT ?`,
    [mesinId, Number(limit)]
  );
}

/** Histori per cabang (buat manager tinjau rekap). */
async function findByCabang(cabangId, { dari = null, sampai = null, limit = 100 } = {}) {
  let sql = `SELECT l.*, k.nama AS nama_karyawan, m.kode_mesin
     FROM mesin_log_manual l
     LEFT JOIN karyawan k ON k.id = l.karyawan_id
     LEFT JOIN mesin m ON m.id = l.mesin_id
     WHERE l.cabang_id = ?`;
  const params = [cabangId];
  if (dari) { sql += ` AND DATE(l.created_at) >= ?`; params.push(dari); }
  if (sampai) { sql += ` AND DATE(l.created_at) <= ?`; params.push(sampai); }
  sql += ` ORDER BY l.created_at DESC LIMIT ?`;
  params.push(Number(limit));
  return db.query(sql, params);
}

module.exports = { create, findByMesin, findByCabang, lastTriggerManual };
