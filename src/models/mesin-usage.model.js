/**
 * src/models/mesin-usage.model.js
 * =============================================================================
 * Akses tabel `mesin_usage` (sesi pemakaian mesin).
 * Kolom: id, mesin_id, detail_transaksi_id, transaksi_id, waktu_mulai,
 *   waktu_selesai, cycle, created_at.
 *
 * Pola: buka sesi saat 'mulai_cuci/kering' (waktu_selesai NULL),
 *       tutup sesi saat 'selesai_cuci/kering'.
 * =============================================================================
 */

const db = require('../config/database');

/** Buka sesi pemakaian (waktu_selesai NULL). conn opsional. @returns insertId */
async function buka(data, conn = null) {
  const sql = `INSERT INTO mesin_usage
    (mesin_id, detail_transaksi_id, transaksi_id, waktu_mulai, waktu_selesai, cycle)
    VALUES (?,?,?,?,NULL,?)`;
  const params = [data.mesin_id, data.detail_transaksi_id, data.transaksi_id, data.waktu_mulai, data.cycle ?? 1];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

/** Tutup sesi terbuka untuk mesin+transaksi (set waktu_selesai). conn opsional. */
async function tutup({ mesinId, transaksiId, waktuSelesai }, conn = null) {
  const runner = conn || db.pool;
  const [r] = await runner.execute(
    `UPDATE mesin_usage SET waktu_selesai = ?
     WHERE mesin_id = ? AND transaksi_id = ? AND waktu_selesai IS NULL
     ORDER BY id DESC LIMIT 1`,
    [waktuSelesai, mesinId, transaksiId]
  );
  return r.affectedRows;
}

async function findByMesin(mesinId, limit = 50) {
  return db.query(
    `SELECT * FROM mesin_usage WHERE mesin_id = ? ORDER BY waktu_mulai DESC, id DESC LIMIT ?`,
    [mesinId, limit]
  );
}

/**
 * Sesi pemakaian yang masih aktif (waktu_selesai NULL) untuk semua mesin di cabang,
 * disertai kode keranjang transaksinya. Untuk papan status mesin di dashboard.
 */
async function aktifByCabang(cabangId) {
  return db.query(
    `SELECT u.mesin_id, u.detail_transaksi_id, u.transaksi_id, u.waktu_mulai,
            t.no_invoice, t.kode_antrian,
            p.nama AS nama_pelanggan,
            l.durasi_menit AS durasi_target
     FROM mesin_usage u
     JOIN transaksi t ON t.id = u.transaksi_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE t.cabang_id = ? AND u.waktu_selesai IS NULL`,
    [cabangId]
  );
}

/** Semua sesi pemakaian mesin untuk 1 transaksi (jalan + selesai), + info mesin + target durasi layanan. */
async function byTransaksi(transaksiId) {
  return db.query(
    `SELECT u.id, u.mesin_id, u.detail_transaksi_id, u.waktu_mulai, u.waktu_selesai, u.cycle,
            m.kode_mesin, m.tipe, m.kapasitas_kg,
            l.durasi_menit AS durasi_target
     FROM mesin_usage u
     JOIN mesin m ON m.id = u.mesin_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE u.transaksi_id = ?
     ORDER BY u.waktu_mulai ASC, u.id ASC`,
    [transaksiId]
  );
}

/**
 * Hitung berapa mesin dengan tipe tertentu (mis. 'dryer') yang MASIH JALAN
 * (waktu_selesai IS NULL) di 1 cabang. Dipakai buat orkestrasi exhaust fan:
 * ON begitu dryer pertama nyala, OFF begitu dryer terakhir mati.
 * conn opsional -> dipanggil dalam transaksi yang sama biar konsisten dgn
 * baris usage yang baru saja dibuka/ditutup (belum commit).
 */
async function countAktifByTipe(cabangId, tipe, conn = null) {
  const runner = conn || db.pool;
  const [rows] = await runner.execute(
    `SELECT COUNT(*) AS jml FROM mesin_usage u
     JOIN mesin m ON m.id = u.mesin_id
     WHERE m.cabang_id = ? AND m.tipe = ? AND u.waktu_selesai IS NULL`,
    [cabangId, tipe]
  );
  return rows[0] ? Number(rows[0].jml) : 0;
}

/**
 * Riwayat pemakaian 1 mesin pada 1 hari tertentu (default hari ini, pakai
 * CURDATE() server DB biar konsisten sama kolom DATETIME lain -- bukan
 * Date() Node yang bisa beda timezone). Dipakai kasir klik mesin di papan
 * status (idle/booking/jalan APAPUN) -> lihat semua pemakaian hari itu,
 * MENGGANTIKAN fitur "Order Terakhir" lama yang cuma nunjukin 1 baris
 * terakhir dan cuma nongol di mesin idle (lihat mesin.model.js:lastOrderByMesin,
 * sekarang gak dipanggil lagi dari kasir).
 */
async function byMesinHariIni(mesinId, tanggal = null) {
  const params = [mesinId];
  let tglExpr = 'CURDATE()';
  if (tanggal) { tglExpr = '?'; params.push(tanggal); }
  return db.query(
    `SELECT u.id, u.transaksi_id, u.waktu_mulai, u.waktu_selesai, u.cycle,
            t.no_invoice, t.total,
            p.nama AS nama_pelanggan, p.telepon,
            l.durasi_menit AS durasi_target
     FROM mesin_usage u
     JOIN transaksi t ON t.id = u.transaksi_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE u.mesin_id = ? AND DATE(u.waktu_mulai) = ${tglExpr}
     ORDER BY u.waktu_mulai ASC, u.id ASC`,
    params
  );
}

module.exports = { buka, tutup, findByMesin, aktifByCabang, byTransaksi, countAktifByTipe, byMesinHariIni };
