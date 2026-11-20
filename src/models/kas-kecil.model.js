/**
 * src/models/kas-kecil.model.js
 * =============================================================================
 * Akses tabel `kas_kecil` (ledger 2 akun: cash & gopay).
 * Kolom: id, cabang_id, tanggal, akun('cash'|'gopay'), jenis('masuk'|'keluar'),
 *   jenis_mutasi('modal'|'pendapatan'|'konversi'|'belanja_ops'|'setor'|'reimburse'),
 *   coa_id, ref_transaksi_id, ref_detail_transaksi_id, transfer_id,
 *   qty, harga_satuan, nominal, metode_asal, bukti_url, karyawan_id, keterangan, created_at.
 * =============================================================================
 */

const db = require('../config/database');

/** Insert satu baris kas_kecil. conn opsional (pakai pool kalau null). @returns insertId */
async function insert(data, conn = null) {
  const sql = `INSERT INTO kas_kecil
    (cabang_id, tanggal, akun, jenis, jenis_mutasi, coa_id,
     ref_transaksi_id, ref_detail_transaksi_id, transfer_id,
     qty, harga_satuan, nominal, metode_asal, bukti_url, karyawan_id, keterangan)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    data.cabang_id, data.tanggal, data.akun, data.jenis, data.jenis_mutasi, data.coa_id,
    data.ref_transaksi_id ?? null, data.ref_detail_transaksi_id ?? null, data.transfer_id ?? null,
    data.qty ?? null, data.harga_satuan ?? null, data.nominal, data.metode_asal ?? null,
    data.bukti_url ?? null, data.karyawan_id, data.keterangan ?? null,
  ];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

// Perubahan #83: baris Kios-K (Winpay) lewat kas kecil cuma sesaat (masuk lalu
// langsung "setor otomatis", net 0) -> disembunyikan dari tampilan kas kecil.
const BUKAN_KIOSK = "COALESCE(metode_asal, '') <> 'kiosk'";

/** Saldo per akun (cash & gopay) untuk satu cabang. */
async function saldo(cabangId) {
  const rows = await db.query(
    `SELECT akun, SUM(IF(jenis='masuk', nominal, -nominal)) AS saldo
     FROM kas_kecil WHERE cabang_id = ? GROUP BY akun`,
    [cabangId]
  );
  const out = { cash: 0, gopay: 0 };
  rows.forEach((r) => { out[r.akun] = Number(r.saldo) || 0; });
  out.total = out.cash + out.gopay;
  return out;
}

/** Mutasi kas pada satu tanggal (untuk monitor harian). */
async function mutasiHarian(cabangId, ymd) {
  return db.query(
    `SELECT id, tanggal, akun, jenis, jenis_mutasi, coa_id, nominal, metode_asal, keterangan, transfer_id
     FROM kas_kecil WHERE cabang_id=? AND DATE(tanggal)=? AND ${BUKAN_KIOSK} ORDER BY tanggal ASC, id ASC`,
    [cabangId, ymd]
  );
}

/** Saldo satu akun (cash/gopay) untuk cabang. */
async function saldoAkun(cabangId, akun, conn = null) {
  const runner = conn || db.pool;
  const [rows] = await runner.execute(
    `SELECT SUM(IF(jenis='masuk', nominal, -nominal)) AS saldo
     FROM kas_kecil WHERE cabang_id = ? AND akun = ?`,
    [cabangId, akun]
  );
  return rows[0] && rows[0].saldo !== null ? Number(rows[0].saldo) : 0;
}

/** Tandai baris pendapatan (belum di-transfer) milik transaksi tertentu -> transfer_id. */
async function stempelPendapatan(conn, transferId, transaksiIds) {
  if (!transaksiIds.length) return;
  const ph = transaksiIds.map(() => '?').join(',');
  await conn.execute(
    `UPDATE kas_kecil SET transfer_id = ?
     WHERE jenis_mutasi = 'pendapatan' AND transfer_id IS NULL AND ref_transaksi_id IN (${ph})`,
    [transferId, ...transaksiIds]
  );
}

/** Belanja operasional yang belum di-reimburse (transfer_id NULL). Untuk net-off saat setor. */
async function belanjaBelumReimburse(cabangId, conn = null) {
  const runner = conn || db.pool;
  const [rows] = await runner.execute(
    `SELECT id, tanggal, coa_id, nominal, keterangan
     FROM kas_kecil
     WHERE cabang_id = ? AND jenis_mutasi = 'belanja_ops' AND transfer_id IS NULL
     ORDER BY tanggal ASC, id ASC`,
    [cabangId]
  );
  return rows;
}

/** Tandai baris belanja_ops tertentu sebagai sudah di-reimburse (-> transfer_id). */
async function stempelBelanja(conn, transferId, kasKecilIds) {
  if (!kasKecilIds.length) return;
  const ph = kasKecilIds.map(() => '?').join(',');
  await conn.execute(
    `UPDATE kas_kecil SET transfer_id = ?
     WHERE jenis_mutasi = 'belanja_ops' AND transfer_id IS NULL AND id IN (${ph})`,
    [transferId, ...kasKecilIds]
  );
}

/** Rekap mutasi per tanggal dalam rentang (untuk daftar card per hari). */
async function rekapHarian(cabangId, dari, sampai) {
  return db.query(
    `SELECT DATE(tanggal) AS tanggal,
            COUNT(*) AS jml,
            COALESCE(SUM(IF(jenis='masuk'  AND jenis_mutasi != 'konversi', nominal, 0)),0) AS masuk,
            COALESCE(SUM(IF(jenis='keluar' AND jenis_mutasi != 'konversi', nominal, 0)),0) AS keluar,
            COALESCE(SUM(IF(jenis_mutasi = 'pendapatan', IF(jenis = 'masuk', nominal, -nominal), 0)),0) AS pendapatan,
            COALESCE(SUM(IF(jenis_mutasi = 'belanja_ops', nominal, 0)),0)                   AS belanja,
            COALESCE(SUM(IF(jenis_mutasi = 'reimburse', nominal, 0)),0)                     AS reimburse,
            COALESCE(SUM(IF(jenis_mutasi = 'setor', nominal, 0)),0)                         AS setor,
            COALESCE(SUM(IF(jenis_mutasi = 'biaya_loyalty', nominal, 0)),0)                 AS biaya_loyalty
     FROM kas_kecil
     WHERE cabang_id=? AND DATE(tanggal) BETWEEN ? AND ? AND ${BUKAN_KIOSK}
     GROUP BY DATE(tanggal) ORDER BY tanggal DESC`,
    [cabangId, dari, sampai]
  );
}

/** Biaya loyalty dari transaksi yang akan disetor (berdasarkan list transaksi_id). */
/**
 * Biaya loyalty yang MENGURANGI net transfer (cash beneran) -- SENGAJA
 * kecualikan coa_id 63 (Biaya Marketing & Promosi, dari promo cuci gratis).
 * Alasan: biaya marketing itu murni pembukuan gross-up (pendapatan diakui
 * penuh lalu di-expense balik, net cash = 0 dari awal karena customer emang
 * beneran bayar Rp0) -- BUKAN biaya riil yang harus dipotong dari uang yang
 * disetor. Kalau ikut kepotong di sini, uang yang ditransfer ke management
 * jadi kurang dari yang seharusnya (padahal uang itu benar-benar terkumpul
 * dari pelanggan lain yang bayar penuh).
 * coa_id 54 (Biaya Loyalty/Redeem Poin) TETAP dihitung seperti semula --
 * itu memang biaya riil terkait diskon poin, tidak berubah.
 */
async function loyaltyBelumSetor(cabangId, transaksiIds, conn = null) {
  if (!transaksiIds || transaksiIds.length === 0) return [];
  const placeholders = transaksiIds.map(() => '?').join(',');
  const sql = `SELECT id, nominal, keterangan, ref_transaksi_id
     FROM kas_kecil
     WHERE cabang_id = ? AND jenis_mutasi = 'biaya_loyalty' AND coa_id != 63
       AND ref_transaksi_id IN (${placeholders})`;
  const params = [cabangId, ...transaksiIds];
  if (conn) {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  return db.query(sql, params);
}

module.exports = { insert, saldo, mutasiHarian, rekapHarian, saldoAkun, stempelPendapatan, belanjaBelumReimburse, stempelBelanja, loyaltyBelumSetor, belanjaByTransfer };

/** Detail item belanja yang di-reimburse pada transfer tertentu */
async function belanjaByTransfer(cabangId, transferId) {
  return db.query(
    `SELECT id, tanggal, nominal, keterangan, akun, coa_id
     FROM kas_kecil
     WHERE cabang_id = ? AND transfer_id = ? AND jenis_mutasi = 'belanja_ops'
     ORDER BY tanggal ASC`,
    [cabangId, transferId]
  );
}
