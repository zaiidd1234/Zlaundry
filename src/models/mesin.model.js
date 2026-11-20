/**
 * src/models/mesin.model.js
 * =============================================================================
 * Akses tabel `mesin` — read Fase 3 (alokasi/usage di Fase 5).
 * Kolom: id, cabang_id, kode_mesin, nama_mesin, tipe(washer|dryer), kapasitas_kg,
 *   merk, model, sn, command(JSON), total_cycle, status(aktif|jalan|maintenance|nonaktif),
 *   keterangan, created_at, updated_at.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, kode_mesin, nama_mesin, tipe, kapasitas_kg, merk, model, sn,
  command, total_cycle, status, keterangan, tuya_device_id,
  iot_provider, iot_trigger, iot_local_ip, iot_local_key,
  created_at, updated_at
`;

/**
 * Daftar mesin per cabang, opsional filter tipe (washer/dryer).
 * Tiap baris dilengkapi flag `direservasi` (boolean) -- true kalau mesin ini
 * SUDAH dipilih/dialokasikan (detail_transaksi.mesin_id) buat transaksi lain
 * yang masih di status "alokasi_mesin_cuci"/"alokasi_mesin_kering" (sudah
 * ditunjuk kasir, tapi belum "mulai" -> mesin.status masih 'aktif' padahal
 * sebenarnya sudah "dipesan" orang lain). Dipakai buat nyaring pilihan mesin
 * di kasir/customer, biar mesin yang lagi direservasi TIDAK ditawarkan lagi
 * ke transaksi lain, walau kolom `status` mentahnya masih 'aktif'.
 *
 * PENTING: detail_transaksi.mesin_id TIDAK di-NULL-kan lagi begitu cuci/kering
 * selesai (dipakai buat histori & prediksi pairing dryer). Makanya reservasi
 * harus dicocokkan ke KATEGORI layanan baris itu sendiri (cuci vs kering),
 * BUKAN cuma status transaksi saat ini -- kalau tidak, washer yang sudah
 * kelar cuci (transaksi sudah lanjut ke fase alokasi_mesin_kering) bakal
 * ikut kebaca "direservasi" terus (nyangkut ke status fase berikutnya),
 * padahal jobnya sendiri sudah selesai dan mesinnya sudah bebas.
 */
async function findByCabang(cabangId, { tipe = null } = {}) {
  let sql = `
    SELECT ${FIELDS},
      EXISTS(
        SELECT 1 FROM detail_transaksi dt
        JOIN transaksi t ON t.id = dt.transaksi_id
        JOIN status_master sm ON sm.id = t.status_terakhir_id
        JOIN layanan l ON l.id = dt.layanan_id
        WHERE dt.mesin_id = m.id
          AND (
            (l.kategori = 'cuci' AND sm.kode = 'alokasi_mesin_cuci')
            OR (l.kategori = 'kering' AND sm.kode = 'alokasi_mesin_kering')
          )
      ) AS direservasi
    FROM mesin m
    WHERE m.cabang_id = ?`;
  const params = [cabangId];
  if (tipe) { sql += ` AND m.tipe = ?`; params.push(tipe); }
  sql += ` ORDER BY m.tipe ASC, m.kode_mesin ASC`;
  const rows = await db.query(sql, params);
  return rows.map((r) => ({ ...r, direservasi: !!Number(r.direservasi) }));
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM mesin WHERE id = ? LIMIT 1`, [id]);
}

/**
 * Cari mesin 'aktif' (siap pakai) sesuai tipe & kapasitas >= berat, kapasitas terkecil dulu.
 * Dipakai Fase 5 untuk alokasi. Return null kalau tidak ada (sinyal: tolak / pecah transaksi).
 */
async function findAvailable(cabangId, tipe, beratKg) {
  const sql = `SELECT ${FIELDS} FROM mesin
               WHERE cabang_id = ? AND tipe = ? AND status = 'aktif' AND kapasitas_kg >= ?
               ORDER BY kapasitas_kg ASC LIMIT 1`;
  return db.queryOne(sql, [cabangId, tipe, beratKg]);
}

async function updateIotProvider(id, provider) {
  await db.query('UPDATE mesin SET iot_provider = ? WHERE id = ?', [provider, id]);
}

/**
 * Daftar mesin yang lagi "teralokasi" (direservasi tapi belum "mulai") di 1
 * cabang, sekalian info transaksi/pelanggan pemiliknya -- dipakai papan mesin
 * kasir/manager biar kartu "Teralokasi" bisa langsung dibuka ke transaksinya
 * (beda dari `direservasi` di findByCabang yang cuma boolean).
 * Sama seperti findByCabang: dicocokkan ke kategori layanan baris itu sendiri
 * (cuci vs kering) supaya washer yang sudah kelar cuci tidak ikut nyangkut
 * kebaca reservasi cuma gara-gara transaksinya sudah lanjut ke fase kering.
 */
async function reservasiAktifByCabang(cabangId) {
  return db.query(
    `SELECT dt.mesin_id, dt.id AS detail_transaksi_id, t.id AS transaksi_id,
            t.no_invoice, t.kode_antrian, p.nama AS nama_pelanggan
     FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id
     JOIN status_master sm ON sm.id = t.status_terakhir_id
     JOIN layanan l ON l.id = dt.layanan_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE t.cabang_id = ? AND dt.mesin_id IS NOT NULL
       AND (
         (l.kategori = 'cuci' AND sm.kode = 'alokasi_mesin_cuci')
         OR (l.kategori = 'kering' AND sm.kode = 'alokasi_mesin_kering')
       )`,
    [cabangId]
  );
}

module.exports = {
  findByCabang, findById, findAvailable, lockById, setStatus, tambahCycle,
  updateIotProvider, lastOrderByMesin, reservasiAktifByCabang,
};

/** Ambil mesin dengan lock (FOR UPDATE) untuk alokasi aman dalam transaksi. */
async function lockById(conn, id) {
  const [rows] = await conn.execute(
    `SELECT id, cabang_id, kode_mesin, nama_mesin, tipe, kapasitas_kg, sn, command,
            tuya_device_id, iot_provider, iot_trigger, iot_local_ip, iot_local_key, status
     FROM mesin WHERE id = ? FOR UPDATE`, [id]
  );
  return rows.length ? rows[0] : null;
}

/** Set status mesin ('aktif'|'jalan'|'maintenance'|'nonaktif'). conn opsional. */
async function setStatus(id, status, conn = null) {
  const runner = conn || db.pool;
  await runner.execute(`UPDATE mesin SET status = ? WHERE id = ?`, [status, id]);
}

/** Tambah total_cycle (saat selesai 1 sesi). conn opsional. */
async function tambahCycle(id, n = 1, conn = null) {
  const runner = conn || db.pool;
  await runner.execute(`UPDATE mesin SET total_cycle = total_cycle + ? WHERE id = ?`, [n, id]);
}

/** Transaksi terakhir yang menggunakan mesin ini */
async function lastOrderByMesin(mesinId) {
  const rows = await db.query(
    `SELECT t.id, t.no_invoice, t.total, t.tanggal,
            p.nama AS nama_pelanggan, p.telepon
     FROM mesin_usage mu
     JOIN transaksi t ON t.id = mu.transaksi_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE mu.mesin_id = ?
     ORDER BY mu.id DESC LIMIT 1`,
    [mesinId]
  );
  return rows[0] || null;
}
