/**
 * src/helpers/invoice.js
 * =============================================================================
 * Generate nomor dokumen:
 *   - no_invoice  : ZL01-YYYYMMDD-seq  (seq reset harian per cabang)
 *   - id_transfer : ZL01-TF-YYYYMMDD-seq (seq harian per cabang)
 *
 * ANTI RACE-CONDITION:
 *   Seq dihitung dari MAX(seq) hari itu DI DALAM transaksi DB dengan baris transaksi
 *   dikunci (FOR UPDATE). Karena itu fungsi ini WAJIB dipanggil dengan koneksi
 *   transaksi (conn) yang sama dengan INSERT-nya. Tanpa lock, dua kasir bisa dapat
 *   nomor sama.
 *
 * Catatan: untuk produksi volume tinggi, alternatif lebih aman = tabel counter
 *   khusus (cabang_id, tanggal, last_seq). Pendekatan MAX+lock cukup untuk skala 1 cabang.
 * =============================================================================
 */

const { format: fmtDate } = require('./date'); // helper date (dibuat di Fase 5); fallback di bawah

/** YYYYMMDD dari Date (waktu Jakarta). */
function yyyymmdd(d = new Date()) {
  // pakai date helper kalau ada; fallback manual Asia/Jakarta
  if (fmtDate) {
    try { return fmtDate(d, 'YYYYMMDD'); } catch (_) { /* fallback */ }
  }
  const j = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getFullYear()}${p(j.getMonth() + 1)}${p(j.getDate())}`;
}

/**
 * Generate no_invoice di dalam transaksi (conn WAJIB).
 * @param {object} conn koneksi transaksi mysql2
 * @param {number} cabangId
 * @param {string} cabangKode mis. 'ZL01'
 * @param {Date}   tanggal default now
 * @returns {Promise<string>} ZL01-YYYYMMDD-001
 */
async function generateNoInvoice(conn, cabangId, cabangKode, tanggal = new Date()) {
  const tgl = yyyymmdd(tanggal);
  // Kunci baris transaksi cabang+tanggal itu, ambil seq tertinggi dari no_invoice.
  const [rows] = await conn.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(no_invoice, '-', -1) AS UNSIGNED)), 0) AS maxseq
     FROM transaksi
     WHERE cabang_id = ? AND DATE(tanggal) = ?
     FOR UPDATE`,
    [cabangId, `${tgl.slice(0,4)}-${tgl.slice(4,6)}-${tgl.slice(6,8)}`]
  );
  const seq = (rows[0].maxseq || 0) + 1;
  return `${cabangKode}-${tgl}-${String(seq).padStart(3, '0')}`;
}

/**
 * Generate id_transfer harian per cabang (di dalam transaksi).
 * @returns {Promise<string>} ZL01-TF-YYYYMMDD-01
 */
async function generateIdTransfer(conn, cabangId, cabangKode, tanggal = new Date()) {
  const tgl = yyyymmdd(tanggal);
  const [rows] = await conn.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(id_transfer, '-', -1) AS UNSIGNED)), 0) AS maxseq
     FROM transfer
     WHERE cabang_id = ? AND DATE(tanggal) = ?
     FOR UPDATE`,
    [cabangId, `${tgl.slice(0,4)}-${tgl.slice(4,6)}-${tgl.slice(6,8)}`]
  );
  const seq = (rows[0].maxseq || 0) + 1;
  return `${cabangKode}-TF-${tgl}-${String(seq).padStart(2, '0')}`;
}

module.exports = { generateNoInvoice, generateIdTransfer, yyyymmdd };
