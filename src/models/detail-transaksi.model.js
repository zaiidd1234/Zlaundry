/**
 * src/models/detail-transaksi.model.js
 * =============================================================================
 * Akses tabel `detail_transaksi` (item per transaksi).
 * Kolom: id, transaksi_id, item_tipe('jasa'|'barang'), layanan_id, barang_id,
 *   mesin_id, nama_item(snapshot), harga_satuan(snapshot), qty, subtotal, created_at.
 *
 * Constraint DB: tepat satu dari layanan_id/barang_id terisi sesuai item_tipe.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, transaksi_id, item_tipe, layanan_id, barang_id, mesin_id,
  nama_item, harga_satuan, qty, subtotal, created_at
`;

/** Insert satu item. conn WAJIB. @returns insertId */
async function create(conn, d) {
  const sql = `INSERT INTO detail_transaksi
    (transaksi_id, item_tipe, layanan_id, barang_id, mesin_id, nama_item, harga_satuan, qty, subtotal)
    VALUES (?,?,?,?,?,?,?,?,?)`;
  const params = [
    d.transaksi_id, d.item_tipe,
    d.layanan_id ?? null, d.barang_id ?? null, d.mesin_id ?? null,
    d.nama_item, d.harga_satuan, d.qty, d.subtotal,
  ];
  const [r] = await conn.execute(sql, params);
  return r.insertId;
}

/** Semua item milik 1 transaksi. */
async function findByTransaksi(transaksiId) {
  return db.query(
    `SELECT d.id, d.transaksi_id, d.item_tipe, d.layanan_id, d.barang_id, d.mesin_id,
            d.nama_item, d.harga_satuan, d.qty, d.subtotal, d.created_at,
            l.satuan_hitung, l.kategori AS layanan_kategori,
            b.satuan AS barang_satuan
     FROM detail_transaksi d
     LEFT JOIN layanan l ON l.id = d.layanan_id
     LEFT JOIN barang b ON b.id = d.barang_id
     WHERE d.transaksi_id = ? ORDER BY d.id ASC`,
    [transaksiId]
  );
}

/** Set mesin_id pada baris detail (saat alokasi mesin di Fase 5). */
async function setMesin(conn, detailId, mesinId) {
  // Begitu dapat mesin beneran, keluar dari antrian terkunci (kolom antrian_*).
  if (mesinId) {
    await conn.execute(`UPDATE detail_transaksi SET mesin_id=?, antrian_mesin_id=NULL, antrian_urutan=NULL WHERE id=?`, [mesinId, detailId]);
  } else {
    await conn.execute(`UPDATE detail_transaksi SET mesin_id=? WHERE id=?`, [mesinId, detailId]);
  }
}

/**
 * Jumlah transaksi yang SUDAH BAYAR (lunas) untuk kategori layanan tertentu
 * ('cuci' -> butuh washer, 'kering' -> butuh dryer) TAPI belum dapat alokasi
 * mesin (mesin_id masih NULL) -- ini "antrean nyata" yang belum kelihatan
 * dari status mesin itu sendiri, dipakai buat estimasi "mesin tersedia dalam
 * X menit" di customer.service.js (statusMesin), supaya orang yang lagi
 * antre juga ikut diperhitungkan, bukan cuma yang mesinnya udah kepegang.
 */
async function hitungAntreanMesin(cabangId, kategoriLayanan) {
  const row = await db.queryOne(
    `SELECT COUNT(DISTINCT dt.transaksi_id) AS jml
     FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id
     JOIN layanan l ON l.id = dt.layanan_id
     WHERE t.cabang_id = ? AND (t.status_bayar = 'lunas' OR t.bayar_saat_ambil = 1)
       AND l.kategori = ? AND dt.mesin_id IS NULL`,
    [cabangId, kategoriLayanan]
  );
  return row ? Number(row.jml) || 0 : 0;
}

module.exports = { create, findByTransaksi, setMesin, hitungAntreanMesin };
