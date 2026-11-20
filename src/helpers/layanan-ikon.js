/**
 * src/helpers/layanan-ikon.js
 * =============================================================================
 * Perubahan #4 -- ikon layanan berwarna (kartu mesin & popup mesin kasir).
 *
 * Tiap layanan yang dipilih customer diberi "warna status" berdasarkan status
 * transaksi saat ini:
 *   hijau  = layanan itu sudah selesai
 *   biru   = belum dikerjakan
 *   kuning = teralokasi di mesin, belum mulai (khusus cuci & kering)
 *   merah  = sedang jalan / sedang diproses
 *
 * Ikon (Font Awesome) ditentukan di frontend per kategori:
 *   cuci fa-soap, kering fa-wind, drop_off fa-people-carry-box, lipat fa-shirt,
 *   setrika_lipat fa-fire, antar fa-truck-fast, antar_jemput fa-route
 * =============================================================================
 */

const { BY_KODE } = require('../constants/status');

const URUTAN_KATEGORI = ['cuci', 'kering', 'drop_off', 'lipat', 'setrika_lipat', 'antar', 'antar_jemput', 'jemput'];
const LABEL = {
  cuci: 'Cuci', kering: 'Kering', drop_off: 'Drop-Off', lipat: 'Lipat',
  setrika_lipat: 'Setrika Lipat', antar: 'Antar', antar_jemput: 'Antar Jemput', jemput: 'Jemput',
};

function u(kode) { return (BY_KODE[kode] && BY_KODE[kode].urutan) || 0; }

/** Warna status 1 kategori layanan untuk status transaksi tertentu. */
function warnaLayanan(kategori, statusKode) {
  const now = u(statusKode);
  switch (kategori) {
    case 'cuci':
      if (statusKode === 'alokasi_mesin_cuci') return 'kuning';
      if (statusKode === 'mulai_cuci') return 'merah';
      return now >= u('selesai_cuci') ? 'hijau' : 'biru';
    case 'kering':
      if (statusKode === 'alokasi_mesin_kering') return 'kuning';
      if (statusKode === 'mulai_kering') return 'merah';
      return now >= u('selesai_kering') ? 'hijau' : 'biru';
    case 'lipat':
      if (statusKode === 'proses_lipat') return 'merah';
      return now >= u('selesai_lipat') ? 'hijau' : 'biru';
    case 'setrika_lipat':
      if (statusKode === 'proses_setrika') return 'merah';
      return now >= u('selesai_setrika') ? 'hijau' : 'biru';
    case 'antar':
      if (statusKode === 'proses_antar') return 'merah';
      return now >= u('selesai_antar') ? 'hijau' : 'biru';
    case 'jemput': // Perubahan #73
      if (statusKode === 'proses_jemput') return 'merah';
      return now >= u('selesai_jemput') ? 'hijau' : 'biru';
    case 'antar_jemput':
      if (statusKode === 'proses_jemput' || statusKode === 'proses_antar') return 'merah';
      return now >= u('selesai_antar') ? 'hijau' : 'biru';
    case 'drop_off':
      // tidak punya tahap sendiri: biru selama diproses, hijau begitu siap diambil / selesai
      return ['siap_diambil', 'sudah_diambil', 'selesai_antar'].includes(statusKode) ? 'hijau' : 'biru';
    default:
      return 'biru';
  }
}

/**
 * @param {string|string[]} kategoriList  "cuci,kering" (GROUP_CONCAT) atau array
 * @param {string} statusKode
 * @param {{durasiKering?:number}} [opt]
 * @returns {{kategori:string,label:string,warna:string}[]} urut baku
 */
function ikonLayanan(kategoriList, statusKode, { durasiKering = null } = {}) {
  const set = new Set(Array.isArray(kategoriList)
    ? kategoriList : String(kategoriList || '').split(',').map((s) => s.trim()).filter(Boolean));
  return URUTAN_KATEGORI.filter((k) => set.has(k))
    .map((k) => {
      const o = { kategori: k, label: LABEL[k], warna: warnaLayanan(k, statusKode) };
      // Perubahan #5: durasi paket kering (menit) ditampilkan di kanan bawah ikon
      if (k === 'kering' && Number(durasiKering) > 0) o.durasi_menit = Number(durasiKering);
      return o;
    });
}

module.exports = { ikonLayanan, warnaLayanan, URUTAN_KATEGORI };
