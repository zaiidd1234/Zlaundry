/**
 * src/config/database.js
 * =============================================================================
 * Koneksi MySQL/MariaDB pakai mysql2/promise (connection pool).
 * Dipakai semua model lewat helper di file ini.
 *
 * Export:
 *   pool                 -> pool mentah (kalau perlu akses langsung)
 *   query(sql, params)   -> jalankan 1 query, balikin rows
 *   queryOne(sql, params)-> balikin 1 baris pertama (atau null)
 *   transaction(fn)      -> jalankan beberapa query dalam 1 transaksi DB.
 *                           fn(conn) menerima koneksi; auto commit/rollback.
 *   testConnection()     -> cek koneksi (dipakai saat server start / health-check)
 *   close()              -> tutup pool (graceful shutdown)
 * =============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// --- Pool konfigurasi dari .env ---
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT) || 10,
  queueLimit: 0,

  // Penting untuk konsistensi data laundry:
  dateStrings: true,        // DATETIME dibalikin sebagai string apa adanya (hindari geser timezone)
  decimalNumbers: true,     // DECIMAL dibalikin sebagai number, bukan string
  timezone: process.env.DB_TIMEZONE || '+07:00', // Asia/Jakarta
  charset: 'utf8mb4',
  // multipleStatements sengaja TIDAK diaktifkan (default false) demi keamanan dari SQL injection.
});

/**
 * Jalankan satu query. Selalu pakai parameter (?) untuk mencegah SQL injection.
 * @returns {Promise<Array>} rows
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Ambil satu baris pertama (atau null kalau kosong).
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Bungkus beberapa operasi dalam satu transaksi DB.
 * Pemakaian:
 *   const result = await transaction(async (conn) => {
 *     await conn.execute('INSERT ...', [...]);
 *     await conn.execute('UPDATE ...', [...]);
 *     return something;
 *   });
 * Otomatis COMMIT kalau sukses, ROLLBACK kalau ada error.
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* abaikan error rollback */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Cek koneksi DB. Lempar error kalau gagal (dipakai saat startup & health-check).
 */
async function testConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}

/**
 * Tutup pool (dipanggil saat graceful shutdown di server.js).
 */
async function close() {
  await pool.end();
}

module.exports = { pool, query, queryOne, transaction, testConnection, close };
