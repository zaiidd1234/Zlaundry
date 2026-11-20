/**
 * src/services/promo.service.js
 * =============================================================================
 * Penentuan promo "cuci gratis" otomatis saat transaksi dibuat.
 *
 * ATURAN BISNIS (per instruksi owner):
 * 1) PELANGGAN BARU  : pelanggan yang belum PERNAH punya transaksi *lunas*
 *                       sebelum hari ini -> dapat 1x cuci gratis, berlaku hari
 *                       apa saja. Kalau di hari itu dia bikin >1 transaksi,
 *                       promo cuma kepakai di transaksi PERTAMA yang mengandung
 *                       layanan "Cuci" -- transaksi berikutnya di hari yang
 *                       sama tidak dapat lagi.
 * 2) JUMAT BERKAH    : tiap hari Jumat, 5 pelanggan pertama (urutan kedatangan/
 *                       urutan transaksi PERTAMA mereka hari itu, per cabang)
 *                       dapat 1x cuci gratis -- berlaku untuk pelanggan baru
 *                       MAUPUN lama.
 *
 * PRIORITAS kalau pelanggan kebetulan lolos KEDUANYA: promo JUMAT yang dipakai.
 * Promo pelanggan baru pada kasus ini HANGUS SELAMANYA -- otomatis, karena
 * begitu lewat hari itu, pelanggan sudah dianggap "pelanggan lama".
 *
 * GUARD "1 promo / pelanggan / hari": walau lolos kriteria, kalau pelanggan
 * HARI ITU sudah dapat promo apapun (dari transaksi lain di hari yang sama),
 * tidak dapat lagi.
 *
 * ON/OFF PER CABANG: BUKAN urusan modul ini. Modul ini cuma nentuin jenis
 * promo yang ELIGIBLE secara aturan. Availability (aktif/nonaktif di cabang
 * tsb) dicek oleh caller lewat `jumatTersedia`/`pelangganBaruTersedia` --
 * biasanya diisi dari ADA-TIDAKNYA baris layanan promo aktif utk cabang itu
 * (lihat layananModel.findPromoByCabangJenis, dipakai di transaksi.service.js).
 *
 * CATATAN KONKURENSI: fungsi ini WAJIB dipanggil di dalam transaksi DB yang
 * SAMA dengan yang dipakai `generateNoInvoice` (lock FOR UPDATE atas baris
 * transaksi cabang+tanggal ini) -- otomatis menyerialkan checkout bersamaan
 * di cabang yang sama, jadi kuota "5 pelanggan pertama" Jumat tidak kebobolan.
 * =============================================================================
 */

const transaksiModel = require('../models/transaksi.model');

const KUOTA_JUMAT_PERTAMA = 5;
const HARI_JUMAT = 5; // getUTCDay(): 0=Minggu ... 5=Jumat ... 6=Sabtu

// COA "Biaya Marketing - Promo Cuci Gratis" (beban) -- id 63, kode 7-112.
// Dipakai transaksi.service.js (bayar()) buat catat biaya marketing di
// kas_kecil saat item promo (is_promo=1) lunas dibayar.
const MARKETING_COA_ID = 63;

const PROMO_LABEL = {
  gratis_cuci_pelanggan_baru: 'Cuci Gratis - Pelanggan Baru',
  gratis_cuci_jumat_berkah: 'Cuci Gratis - Jumat Berkah',
};

/** Ambil 'YYYY-MM-DD' dari string tanggal 'YYYY-MM-DD HH:mm:ss'. */
function tanggalSaja(tanggal) {
  return String(tanggal).slice(0, 10);
}

/** Hari-ke berapa (0-6) dari tanggal 'YYYY-MM-DD', dihitung sbg kalender (bukan jam). */
function hariKe(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/**
 * Tentukan jenis promo yang berlaku (atau null) untuk 1 transaksi yang SEDANG
 * dibuat. Dipanggil HANYA kalau order-nya mengandung layanan kategori "cuci".
 *
 * @param {object} conn      koneksi transaksi DB (mysql2) -- WAJIB
 * @param {number} cabangId
 * @param {number} pelangganId
 * @param {string} tanggal   'YYYY-MM-DD HH:mm:ss'
 * @param {boolean} jumatTersedia         baris layanan promo Jumat Berkah AKTIF di cabang ini?
 * @param {boolean} pelangganBaruTersedia baris layanan promo Pelanggan Baru AKTIF di cabang ini?
 * @returns {Promise<'gratis_cuci_jumat_berkah'|'gratis_cuci_pelanggan_baru'|null>}
 */
async function tentukanPromoCuci(conn, { cabangId, pelangganId, tanggal, jumatTersedia, pelangganBaruTersedia }) {
  const ymd = tanggalSaja(tanggal);
  if (!jumatTersedia && !pelangganBaruTersedia) return null;

  const sudahPakai = await transaksiModel.sudahPakaiPromoHariIni(conn, pelangganId, ymd);
  if (sudahPakai) return null;

  if (jumatTersedia && hariKe(ymd) === HARI_JUMAT) {
    const posisi = await transaksiModel.posisiPelangganHariIni(conn, cabangId, ymd, pelangganId);
    if (posisi <= KUOTA_JUMAT_PERTAMA) return 'gratis_cuci_jumat_berkah';
  }

  if (pelangganBaruTersedia) {
    const sudahPernahLunas = await transaksiModel.pernahTransaksiLunasSebelum(conn, pelangganId, ymd);
    if (!sudahPernahLunas) return 'gratis_cuci_pelanggan_baru';
  }

  return null;
}

/**
 * Sama aturan eligibility-nya kayak tentukanPromoCuci, TAPI balikin SEMUA
 * jenis promo yang eligible (bukan cuma 1 yang diprioritaskan) -- dipakai
 * buat tombol "Gunakan Promo" di customer/kasir, biar mereka lihat & pilih
 * sendiri kalau kebetulan eligible lebih dari satu.
 *
 * `runner` boleh `conn` (dalam transaksi, dipakai pas order beneran dibuat)
 * ATAU `db.pool` (di luar transaksi, dipakai pas cuma preview/cek doang
 * sebelum order dibuat -- lihat customer.service.js promoTersedia()).
 */
async function promoYangBisaDipakai(runner, { cabangId, pelangganId, tanggal, jumatTersedia, pelangganBaruTersedia }) {
  const ymd = tanggalSaja(tanggal);
  const hasil = [];
  if (!jumatTersedia && !pelangganBaruTersedia) return hasil;

  const sudahPakai = await transaksiModel.sudahPakaiPromoHariIni(runner, pelangganId, ymd);
  if (sudahPakai) return hasil;

  if (jumatTersedia && hariKe(ymd) === HARI_JUMAT) {
    const posisi = await transaksiModel.posisiPelangganHariIni(runner, cabangId, ymd, pelangganId);
    if (posisi <= KUOTA_JUMAT_PERTAMA) hasil.push('gratis_cuci_jumat_berkah');
  }
  if (pelangganBaruTersedia) {
    const sudahPernahLunas = await transaksiModel.pernahTransaksiLunasSebelum(runner, pelangganId, ymd);
    if (!sudahPernahLunas) hasil.push('gratis_cuci_pelanggan_baru');
  }
  return hasil;
}

/**
 * Validasi 1 pilihan promo spesifik (yang di-klik customer/kasir di tombol
 * "Gunakan Promo") masih SAH dipakai SAAT INI (dicek ulang di dalam
 * transaksi order beneran dibuat -- jangan percaya begitu saja input dari
 * client). Return true/false.
 */
async function validasiPromoPilihan(conn, jenisPromo, ctx) {
  const daftar = await promoYangBisaDipakai(conn, ctx);
  return daftar.includes(jenisPromo);
}

module.exports = {
  tentukanPromoCuci, promoYangBisaDipakai, validasiPromoPilihan,
  KUOTA_JUMAT_PERTAMA, MARKETING_COA_ID, PROMO_LABEL,
};
