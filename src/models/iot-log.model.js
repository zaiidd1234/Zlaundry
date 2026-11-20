/**
 * src/models/iot-log.model.js
 * =============================================================================
 * Log setiap percobaan trigger IoT (berhasil/gagal) -- supaya bisa didiagnosis
 * lewat query database, tanpa perlu akses file log server.
 * =============================================================================
 */

const db = require('../config/database');

/**
 * @param {object} data { mesinId, commandKey, sukses (bool), pesanError?, transaksiId? }
 */
async function create(data) {
  await db.query(
    `INSERT INTO iot_log (mesin_id, command_key, sukses, pesan_error, transaksi_id, waktu)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      data.mesinId,
      data.commandKey,
      data.sukses ? 1 : 0,
      data.pesanError || null,
      data.transaksiId || null,
    ]
  );
}

/** Riwayat log untuk 1 mesin (buat diagnosa dari kasir/manager kalau perlu). */
async function findByMesin(mesinId, limit = 50) {
  return db.query(
    `SELECT * FROM iot_log WHERE mesin_id = ? ORDER BY waktu DESC LIMIT ?`,
    [mesinId, limit]
  );
}

module.exports = { create, findByMesin };
