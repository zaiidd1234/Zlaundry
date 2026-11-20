/**
 * src/models/layanan.model.js
 * =============================================================================
 * Akses tabel `layanan` (jasa).
 * Kolom: id, cabang_id, coa_id, nama_paket, kategori, satuan_hitung, harga,
 *   harga_promo, berat_maks, durasi_menit, pakai_mesin, is_promo, jenis_promo,
 *   tanggal_mulai, tanggal_selesai, status, created_at, updated_at.
 *
 * TIER HARGA BERDASAR BERAT (kategori='cuci' saja): kalau 1 cabang punya LEBIH
 * DARI SATU baris "Cuci" aktif, masing-masing boleh diisi `berat_maks` (kg) --
 * NULL berarti "tanpa batas atas" (tier paling mahal/besar). Sistem otomatis
 * milih baris yang PALING PAS sesuai berat_kg pesanan (lihat findCuciByBerat).
 * Kalau cuma ADA SATU baris Cuci per cabang (default/lama), fitur ini otomatis
 * tidak aktif -- backward compatible, harga tetap flat seperti biasa.
 *
 * PROMO CUCI GRATIS: direpresentasikan sebagai baris layanan TERSENDIRI
 * (is_promo=1, jenis_promo diisi, kategori TETAP 'cuci' supaya alur berat/mesin
 * tidak berubah). `harga` di baris promo = harga normal (buat referensi/
 * pembukuan "pendapatan penuh"), `harga_promo` = yang beneran ditagih ke
 * customer (biasanya 0). Baris ini SENGAJA disembunyikan dari daftar layanan
 * yang ditampilkan ke customer/kasir (lihat findByCabang) -- customer/kasir
 * tetap pilih "Cuci" biasa; backend yang otomatis substitusi ke baris promo
 * ini kalau eligible (lihat services/promo.service.js & transaksi.service.js).
 * Toggle on/off promo = tinggal ubah `status` baris ini ('aktif'/'nonaktif'),
 * reuse mekanisme yang sudah ada, tidak ada kolom boolean terpisah lagi.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, coa_id, nama_paket, kategori, satuan_hitung, harga, harga_promo,
  berat_maks, durasi_menit, pakai_mesin, is_promo, jenis_promo, tanggal_mulai, tanggal_selesai,
  status, created_at, updated_at
`;

/**
 * Daftar layanan per cabang buat ditampilkan ke customer/kasir (default hanya
 * aktif, DAN default menyembunyikan baris promo -- itu bukan untuk dipilih
 * manual). Kirim includePromo:true kalau memang butuh lihat baris promonya.
 */
async function findByCabang(cabangId, { kategori = null, includeNonaktif = false, includePromo = false } = {}) {
  let sql = `SELECT ${FIELDS} FROM layanan WHERE cabang_id = ?`;
  const params = [cabangId];
  if (!includeNonaktif) sql += ` AND status = 'aktif'`;
  if (!includePromo) sql += ` AND is_promo = 0`;
  if (kategori) { sql += ` AND kategori = ?`; params.push(kategori); }
  sql += ` ORDER BY kategori ASC, harga ASC`;
  return db.query(sql, params);
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM layanan WHERE id = ? LIMIT 1`, [id]);
}

/** Semua baris "Cuci" (kategori='cuci', is_promo=0) aktif di 1 cabang, urut dari kapasitas berat terkecil. Dipakai server buat tier harga berdasar berat. */
async function findCuciByCabang(cabangId) {
  const rows = await db.query(
    `SELECT ${FIELDS} FROM layanan WHERE cabang_id = ? AND kategori = 'cuci' AND is_promo = 0 AND status = 'aktif'`,
    [cabangId]
  );
  return rows.sort((a, b) => {
    if (a.berat_maks == null) return 1;
    if (b.berat_maks == null) return -1;
    return Number(a.berat_maks) - Number(b.berat_maks);
  });
}

/**
 * Baris layanan promo AKTIF untuk 1 cabang + 1 jenis_promo tertentu.
 * Return null kalau promo ini belum di-setup atau sedang dinonaktifkan
 * (status='nonaktif') di cabang tsb -- itulah mekanisme "disable per cabang".
 */
/**
 * Baris layanan promo AKTIF untuk 1 cabang + 1 jenis_promo tertentu.
 * Return null kalau promo ini belum di-setup, sedang dinonaktifkan
 * (status='nonaktif'), ATAU hari ini di luar rentang tanggal_mulai/
 * tanggal_selesai (kalau diisi -- kalau NULL berarti tidak ada batas,
 * promo jalan terus selama status='aktif').
 */
async function findPromoByCabangJenis(cabangId, jenisPromo) {
  return db.queryOne(
    `SELECT ${FIELDS} FROM layanan
     WHERE cabang_id = ? AND is_promo = 1 AND jenis_promo = ? AND status = 'aktif'
       AND (tanggal_mulai IS NULL OR tanggal_mulai <= CURDATE())
       AND (tanggal_selesai IS NULL OR tanggal_selesai >= CURDATE())
     LIMIT 1`,
    [cabangId, jenisPromo]
  );
}

/** Semua baris promo (aktif ATAU nonaktif) milik 1 cabang -- dipakai layar toggle manager. */
async function findAllPromoByCabang(cabangId) {
  return db.query(
    `SELECT ${FIELDS} FROM layanan WHERE cabang_id = ? AND is_promo = 1 ORDER BY jenis_promo ASC`,
    [cabangId]
  );
}

/** Ubah status (aktif/nonaktif) 1 baris layanan promo tertentu. */
async function setStatusPromo(id, status) {
  if (!['aktif', 'nonaktif'].includes(status)) throw new Error('Status tidak valid');
  await db.query(`UPDATE layanan SET status = ? WHERE id = ? AND is_promo = 1`, [status, id]);
}

module.exports = { findByCabang, findById, findCuciByCabang, findPromoByCabangJenis, findAllPromoByCabang, setStatusPromo };
