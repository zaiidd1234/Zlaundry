/**
 * src/helpers/poin.js
 * =============================================================================
 * Aturan loyalty:
 *   hitungPoin(total)            -> FLOOR(total / 1000)   (aturan LAMA, dipakai
 *                                   hanya untuk transaksi lama yg poin_didapat NULL)
 *   hitungPoinItems(items,total) -> Perubahan #83: poin HANYA dari layanan mesin
 *                                   (cuci & kering). Detergen, pewangi, kresek,
 *                                   cafe, lipat, antar, drop-off tidak dapat poin.
 *                                   Basis = MIN(subtotal cuci+kering, total).
 *   poinTercatat(header)         -> poin yg dulu benar2 diberikan (kolom
 *                                   transaksi.poin_didapat), fallback aturan lama.
 *   PER_RUPIAH = 1000 (1 poin per Rp1.000)
 *
 * Frekuensi kedatangan (keputusan: pelanggan sama + tanggal sama = 1 kedatangan):
 *   addFrekuensi(sudahAdaTrxHariIni) -> 0 jika hari itu pelanggan sudah transaksi,
 *                                       1 jika ini transaksi pertamanya hari itu.
 * Penentuan "sudahAdaTrxHariIni" dilakukan di service (cek DB), helper ini
 * cuma menerjemahkan ke angka tambahan.
 * =============================================================================
 */

const PER_RUPIAH = 1000;

function hitungPoin(total) {
  const t = Number(total) || 0;
  return Math.floor(t / PER_RUPIAH);
}

// Perubahan #83: kategori layanan yang menghasilkan poin
const KATEGORI_POIN = ['cuci', 'kering'];

/** items: baris detail ({item_tipe, kategori|layanan_kategori, subtotal}). */
function basisPoin(items, total) {
  const mesin = (items || []).reduce((s, it) => {
    const kat = it.kategori || it.layanan_kategori;
    if (it.item_tipe !== 'jasa' || !KATEGORI_POIN.includes(kat)) return s;
    return s + (Number(it.subtotal) || 0);
  }, 0);
  return Math.max(0, Math.min(mesin, Number(total) || 0));
}

function hitungPoinItems(items, total) {
  return Math.floor(basisPoin(items, total) / PER_RUPIAH);
}

/** Poin yang SUDAH diberikan untuk transaksi ini (buat dibalik saat hapus/pindah/ubah). */
function poinTercatat(header) {
  if (header && header.poin_didapat !== undefined && header.poin_didapat !== null) return Number(header.poin_didapat) || 0;
  return hitungPoin(header ? header.total : 0);
}

function addFrekuensi(sudahAdaTrxHariIni) {
  return sudahAdaTrxHariIni ? 0 : 1;
}

module.exports = { hitungPoin, hitungPoinItems, basisPoin, poinTercatat, addFrekuensi, PER_RUPIAH, KATEGORI_POIN };
