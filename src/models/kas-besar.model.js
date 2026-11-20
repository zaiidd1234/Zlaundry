/**
 * src/models/kas-besar.model.js
 * =============================================================================
 * Akses tabel `kas_besar` (kas terpusat management).
 * Kolom: id, transfer_id, tanggal, jenis('masuk'|'keluar'), coa_id, nominal,
 *   sumber('setor_penjualan'|'reimburse'|'opex'|'akrual'|'biaya_loyalty'|
 *   'distribusi'|'winpay_mdr'), ref_cabang_id, bukti_url, karyawan_id,
 *   keterangan, created_at.
 *
 * Ingat: kategori P&L (pendapatan/cogs/cos/opex) ditentukan oleh COA, bukan oleh
 * kolom 'sumber'. 'sumber' hanya menandai asal aliran uang.
 *
 * 'winpay_mdr' (keluar) = biaya MDR yang dipotong Winpay saat pembayaran QRIS
 * dinamis langsung settle ke kas besar (bypass kas_kecil) -- lihat
 * transaksi.service.js:bayar() dan sql/2026-09-23_winpay_prioritas_cabang.sql.
 * Pendapatannya sendiri TETAP pakai sumber 'setor_penjualan' yang sudah ada
 * (supaya kompatibel dgn query laporan/omzet manager yang sudah ada, tanpa
 * perlu tambahan filter sumber baru untuk sisi pendapatan).
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, transfer_id, tanggal, jenis, coa_id, nominal, sumber,
  ref_cabang_id, bukti_url, karyawan_id, keterangan, created_at
`;

/** Insert 1 baris kas besar. conn opsional. @returns insertId */
async function insert(data, conn = null) {
  const sql = `INSERT INTO kas_besar
    (transfer_id, tanggal, jenis, coa_id, nominal, sumber, ref_cabang_id, bukti_url, karyawan_id, keterangan)
    VALUES (?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    data.transfer_id ?? null, data.tanggal ?? null, data.jenis ?? null,
    data.coa_id ?? null, data.nominal ?? null, data.sumber ?? null,
    data.ref_cabang_id ?? null, data.bukti_url ?? null,
    data.karyawan_id ?? null, data.keterangan ?? null,
  ];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

/**
 * Posting pendapatan per COA dari kas_kecil yang sudah ditandai transfer ini.
 * Meringkas SUM(nominal) per coa_id (jenis_mutasi='pendapatan') -> kas_besar 'masuk'.
 * Dijalankan dalam transaksi setor (conn WAJIB).
 */
async function postingPendapatanDariTransfer(conn, { transferId, tanggal, cabangId, kasirId, idTransfer }) {
  await conn.execute(
    `INSERT INTO kas_besar (transfer_id, tanggal, jenis, coa_id, nominal, sumber, ref_cabang_id, karyawan_id, keterangan)
     SELECT ?, ?, 'masuk', coa_id, SUM(IF(jenis = 'masuk', nominal, -nominal)), 'setor_penjualan', ?, ?, CONCAT('Setoran penjualan ', ?)
     FROM kas_kecil
     WHERE transfer_id = ? AND jenis_mutasi = 'pendapatan'
     GROUP BY coa_id
     -- pengembalian (jenis keluar, fitur ubah pesanan) mengurangi pendapatan per COA
     HAVING SUM(IF(jenis = 'masuk', nominal, -nominal)) <> 0`,
    [transferId, tanggal, cabangId, kasirId, idTransfer, transferId]
  );
}

/** Saldo kas besar (masuk - keluar), opsional filter tanggal. */
async function saldo({ sampai = null } = {}) {
  let sql = `SELECT SUM(IF(jenis='masuk', nominal, -nominal)) AS saldo FROM kas_besar`;
  const params = [];
  if (sampai) { sql += ` WHERE DATE(tanggal) <= ?`; params.push(sampai); }
  const row = await db.queryOne(sql, params);
  return row && row.saldo !== null ? Number(row.saldo) : 0;
}

async function findByTransfer(transferId) {
  return db.query(`SELECT ${FIELDS} FROM kas_besar WHERE transfer_id = ? ORDER BY id ASC`, [transferId]);
}

/** Posting BEBAN (reimburse belanja) ke kas_besar, ringkas per COA. Keluar. */
async function postingBebanDariTransfer(conn, { transferId, tanggal, cabangId, kasirId, idTransfer }) {
  await conn.execute(
    `INSERT INTO kas_besar (transfer_id, tanggal, jenis, coa_id, nominal, sumber, ref_cabang_id, karyawan_id, keterangan)
     SELECT ?, ?, 'keluar', coa_id, SUM(nominal), 'reimburse', ?, ?, CONCAT('Reimburse belanja ', ?)
     FROM kas_kecil
     WHERE transfer_id = ? AND jenis_mutasi = 'belanja_ops'
     GROUP BY coa_id`,
    [transferId, tanggal, cabangId, kasirId, idTransfer, transferId]
  );
}

/** Posting BEBAN LOYALTY (redeem poin) ke kas_besar saat setor. Keluar per COA. */
async function postingLoyaltyDariTransfer(conn, { transferId, tanggal, cabangId, kasirId, idTransfer }) {
  // Cari kas_kecil biaya_loyalty yang transaksinya termasuk dalam batch setor ini
  // transaksi.transfer_id di-set saat stempelSetor, jadi kita join ke sana
  await conn.execute(
    `INSERT INTO kas_besar (transfer_id, tanggal, jenis, coa_id, nominal, sumber, ref_cabang_id, karyawan_id, keterangan)
     SELECT ?, ?, 'keluar', kk.coa_id, SUM(kk.nominal), 'biaya_loyalty', ?, ?, CONCAT('Biaya Loyalty ', ?)
     FROM kas_kecil kk
     WHERE kk.ref_transaksi_id IN (
       SELECT id FROM transaksi WHERE transfer_id = ? AND cabang_id = ?
     )
     AND kk.jenis_mutasi = 'biaya_loyalty'
     AND kk.cabang_id = ?
     GROUP BY kk.coa_id
     HAVING SUM(kk.nominal) > 0`,
    [transferId, tanggal, cabangId, kasirId, idTransfer, transferId, cabangId, cabangId]
  );
}

/** Saldo kas besar FISIK 1 cabang (arus kas riil). Akrual TIDAK dihitung (bukan arus kas). */
async function saldoCabang(cabangId, { sampai = null } = {}) {
  let sql = `SELECT SUM(IF(jenis='masuk', nominal, -nominal)) AS saldo FROM kas_besar
             WHERE ref_cabang_id = ? AND sumber <> 'akrual'`;
  const params = [cabangId];
  if (sampai) { sql += ` AND DATE(tanggal) <= ?`; params.push(sampai); }
  const row = await db.queryOne(sql, params);
  return row && row.saldo !== null ? Number(row.saldo) : 0;
}

/** Bulan-bulan (YYYY-MM) yang punya riwayat setoran (transfer masuk) di cabang ini. */
async function bulanSetoranTersedia(cabangId) {
  const rows = await db.query(
    `SELECT DISTINCT DATE_FORMAT(tanggal, '%Y-%m') AS bulan
     FROM transfer WHERE cabang_id = ? AND arah = 'kasir_ke_management'
     ORDER BY bulan DESC`,
    [cabangId]
  );
  return rows.map((r) => r.bulan);
}

/**
 * Riwayat setoran masuk (sumber setor_penjualan) per cabang, digabung per transfer.
 * `tanggal` yang dikembalikan diambil dari `kas_besar.created_at` (timestamp
 * ASLI saat posting terjadi), bukan `transfer.tanggal` -- soalnya kolom itu
 * untuk setoran normal (bukan backdate) sekarang juga sudah pakai jam asli
 * (lihat transfer.service.js waktuSetor()), TAPI histori lama & entri backdate
 * masih/tetap 23:59:59 di situ. `kas_besar.created_at` selalu jam asli
 * (default MySQL CURRENT_TIMESTAMP), jadi lebih bisa diandalkan buat tampilan.
 * Filter dari/sampai TETAP pakai tf.tanggal (tanggal bisnis transfer, penting
 * buat kasus backdate -- jangan pakai created_at buat filter tanggal).
 */
async function setoranMasuk(cabangId, { dari = null, sampai = null, limit = 50 } = {}) {
  let sql = `
    SELECT tf.id AS transfer_id, tf.id_transfer,
           COALESCE(kbw.waktu_real, tf.tanggal) AS tanggal,
           tf.nominal_transfer, tf.total_pendapatan,
           tf.total_reimburse, tf.jumlah_transaksi, tf.bukti_url
    FROM transfer tf
    LEFT JOIN (
      SELECT transfer_id, MIN(created_at) AS waktu_real
      FROM kas_besar
      WHERE sumber = 'setor_penjualan'
      GROUP BY transfer_id
    ) kbw ON kbw.transfer_id = tf.id
    WHERE tf.cabang_id = ? AND tf.arah = 'kasir_ke_management'`;
  const params = [cabangId];
  if (dari) { sql += ` AND DATE(tf.tanggal) >= ?`; params.push(dari); }
  if (sampai) { sql += ` AND DATE(tf.tanggal) <= ?`; params.push(sampai); }
  sql += ` ORDER BY tf.tanggal DESC, tf.id DESC LIMIT ?`;
  params.push(Number(limit));
  return db.query(sql, params);
}

/** Riwayat beban OPEX (sumber 'opex') per cabang dalam rentang. */
async function bebanOpex(cabangId, { dari = null, sampai = null, limit = 50 } = {}) {
  let sql = `
    SELECT kb.id, kb.tanggal, kb.coa_id, kb.nominal, kb.keterangan, kb.bukti_url,
           c.kode AS coa_kode, c.nama AS coa_nama
    FROM kas_besar kb
    LEFT JOIN coa c ON c.id = kb.coa_id
    WHERE kb.ref_cabang_id = ? AND kb.jenis = 'keluar' AND kb.sumber = 'opex'`;
  const params = [cabangId];
  if (dari) { sql += ` AND DATE(kb.tanggal) >= ?`; params.push(dari); }
  if (sampai) { sql += ` AND DATE(kb.tanggal) <= ?`; params.push(sampai); }
  sql += ` ORDER BY kb.tanggal DESC, kb.id DESC LIMIT ?`;
  params.push(Number(limit));
  return db.query(sql, params);
}

/** Daftar bulan (YYYY-MM) yang punya transaksi, untuk pilihan periode laba-rugi. */
async function bulanTersedia(cabangId) {
  const rows = await db.query(
    `SELECT DISTINCT DATE_FORMAT(tanggal, '%Y-%m') AS bulan
     FROM transaksi WHERE cabang_id = ?
     ORDER BY bulan DESC`,
    [cabangId]
  );
  return rows.map((r) => r.bulan);
}

/** Saldo teralokasi (akrual) cabang: total dana yang sudah dialokasikan via beban akrual. */
async function saldoTeralokasi(cabangId, { sampai = null } = {}) {
  let sql = `SELECT COALESCE(SUM(nominal),0) AS total FROM kas_besar
             WHERE ref_cabang_id = ? AND sumber = 'akrual' AND jenis = 'keluar'`;
  const params = [cabangId];
  if (sampai) { sql += ` AND DATE(tanggal) <= ?`; params.push(sampai); }
  const row = await db.queryOne(sql, params);
  return row ? Number(row.total) : 0;
}

/**
 * Detail record laba-rugi dari kas_besar dalam rentang, untuk expand di UI / export.
 * sisi: 'pendapatan' (masuk setor_penjualan) | 'beban' (keluar reimburse/opex/akrual).
 * opsional filter coaId tertentu.
 */
async function recordLabaRugi(cabangId, { dari, sampai, sisi, coaId = null } = {}) {
  const params = [cabangId, dari, sampai];
  let cond;
  if (sisi === 'pendapatan') cond = `kb.jenis='masuk' AND kb.sumber='setor_penjualan'`;
  else cond = `kb.jenis='keluar' AND kb.sumber IN ('reimburse','opex','akrual','biaya_loyalty','winpay_mdr')`;
  let sql = `
    SELECT kb.id, kb.tanggal, kb.coa_id, c.kode AS coa_kode, c.nama AS coa_nama,
           kb.nominal, kb.sumber, kb.keterangan, kb.bukti_url
    FROM kas_besar kb LEFT JOIN coa c ON c.id = kb.coa_id
    WHERE kb.ref_cabang_id = ? AND DATE(kb.tanggal) BETWEEN ? AND ? AND ${cond}`;
  if (coaId) { sql += ` AND kb.coa_id = ?`; params.push(coaId); }
  sql += ` ORDER BY kb.tanggal ASC, kb.id ASC`;
  return db.query(sql, params);
}

/** Ringkas distribusi laba per COA (sumber 'distribusi') dalam rentang. */
async function distribusiLaba(cabangId, { dari, sampai } = {}) {
  return db.query(
    `SELECT kb.coa_id, c.kode AS coa_kode, c.nama AS coa_nama, COALESCE(SUM(kb.nominal),0) AS nominal
     FROM kas_besar kb LEFT JOIN coa c ON c.id = kb.coa_id
     WHERE kb.ref_cabang_id = ? AND kb.sumber = 'distribusi' AND kb.jenis = 'keluar'
       AND DATE(kb.tanggal) BETWEEN ? AND ?
     GROUP BY kb.coa_id, c.kode, c.nama ORDER BY c.kode ASC`,
    [cabangId, dari, sampai]
  );
}

module.exports = {
  insert, postingPendapatanDariTransfer, postingBebanDariTransfer, postingLoyaltyDariTransfer,
  saldo, findByTransfer, saldoCabang, setoranMasuk, bebanOpex, bulanTersedia, bulanSetoranTersedia,
  saldoTeralokasi, recordLabaRugi, distribusiLaba,
};
