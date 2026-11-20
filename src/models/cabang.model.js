/**
 * src/models/cabang.model.js
 * =============================================================================
 * Akses tabel `cabang` (read-only untuk Fase 3).
 * Kolom: id, kode, nama, alamat, kota, provinsi, no_hp, latitude, longitude,
 *   link_wa, link_gmap_review, link_ig, link_fb, link_tiktok, link_logo,
 *   target_omzet_bulanan, nilai_per_poin, tanggal_buka, pemilihan_mesin,
 *   status, created_at, updated_at.
 *
 * `nilai_per_poin` = berapa rupiah nilai 1 poin loyalty kalau ditukar (dulu
 * hardcode Rp10/poin di kode -- sekarang bisa diatur beda-beda per cabang).
 *
 * `tanggal_buka` = tanggal cabang RESMI buka (diisi manual). Dipakai sebagai
 * titik awal "Minggu 1"/"Bulan 1" di grafik Performa (lihat performa.service.js)
 * -- kalau NULL, sistem fallback nebak dari transaksi lunas PERTAMA cabang itu.
 *
 * `pemilihan_mesin` ENUM('manual','otomatis') DEFAULT 'manual' -- kalau
 * 'otomatis', customer/kasir TIDAK pilih mesin sendiri lagi; sistem yang
 * mengalokasikan (lihat mesin.service.js pilihOtomatis()) dengan antrian
 * dinamis kalau semua mesin penuh (lihat transaksi.service.js daftarAntrian
 * & cascade auto-assign).
 *
 * `winpay_aktif` TINYINT(1) DEFAULT 0 -- saklar per-cabang buat fitur QRIS
 * dinamis Winpay (lihat sql/2026-09-23_winpay_prioritas_cabang.sql). Kalau
 * aktif DAN metode bayar = qris, sistem coba generate QR dinamis Winpay
 * DULU (prioritas); kalau gagal/nonaktif, fallback ke mekanisme QRIS statis
 * lama (lihat pembayaran-qris.service.js & public/customer|kasir/app.js).
 * `mdr_winpay_persen` DECIMAL(5,3) NULL -- persentase fee MDR Winpay per
 * cabang (mis. 0.700 = 0.7%), beda-beda tergantung kesepakatan dgn Winpay.
 * NULL/0 dianggap belum ada fee (jangan hardcode di kode, lihat
 * transaksi.service.js:bayar() step posting kas_besar untuk pemakaiannya).
 * Kolom ini SENGAJA read-only di model ini (belum ada UI toggle manager di
 * fase ini) -- diisi langsung lewat SQL sampai ada permintaan UI-nya.
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, kode, nama, alamat, kota, provinsi, no_hp, latitude, longitude,
  link_wa, link_gmap_review, link_ig, link_fb, link_tiktok, link_logo,
  target_omzet_bulanan, nilai_per_poin, tanggal_buka, pemilihan_mesin,
  winpay_aktif, mdr_winpay_persen, status, created_at, updated_at
`;

/** Semua cabang (default hanya aktif). */
async function findAll({ includeNonaktif = false } = {}) {
  let sql = `SELECT ${FIELDS} FROM cabang`;
  if (!includeNonaktif) sql += ` WHERE status = 'aktif'`;
  sql += ` ORDER BY kode ASC`;
  return db.query(sql);
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM cabang WHERE id = ? LIMIT 1`, [id]);
}

async function findByKode(kode) {
  return db.queryOne(`SELECT ${FIELDS} FROM cabang WHERE kode = ? LIMIT 1`, [kode]);
}

module.exports = { findAll, findById, findByKode };
