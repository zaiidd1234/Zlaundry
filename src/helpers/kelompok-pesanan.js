/**
 * src/helpers/kelompok-pesanan.js
 * =============================================================================
 * Perubahan #9 -- 8 kelompok pesanan kasir (kartu Transaksi dashboard & tab
 * menu Pesanan). SATU sumber definisi, dipakai ringkasOperasional() (angka
 * kartu) dan listForKasir() (isi tab) supaya angka & daftar tidak pernah beda.
 *
 *   belum_bayar   : status_bayar = belum (termasuk bayar saat ambil yang sedang diproses)
 *   antre_mesin   : lunas, tahap berikutnya = alokasi mesin (sub cuci / kering)
 *                   (sudah_bayar / jemput -> cuci; selesai_cuci + ada kering -> kering)
 *   alokasi_mesin : alokasi_mesin_cuci / alokasi_mesin_kering (sub cuci / kering)
 *   proses_mesin  : mulai_cuci / mulai_kering (sub cuci / kering)
 *   drop_off      : ada layanan drop-off & belum siap diambil (boleh dobel)
 *   lipat         : sudah selesai mesin & belum selesai lipat (termasuk setrika lipat)
 *   siap          : siap_diambil, ATAU semua tahap kerja sudah selesai tapi
 *                   belum ditandai siap (mis. Cuci Saja status selesai_cuci) --
 *                   hanya tampilan, status tidak diubah. Order antar: siap
 *                   diantar / sedang diantar.
 *   sudah_diambil : ditandai sudah diambil / selesai antar HARI INI (log status)
 * =============================================================================
 */

const { BY_KODE } = require('../constants/status');
const { nextStatus } = require('./state-machine');

const TERMINAL = ['sudah_diambil', 'selesai_antar'];
const TAB_BARU = ['belum_bayar', 'antre_mesin', 'alokasi_mesin', 'proses_mesin', 'drop_off', 'lipat', 'siap', 'sudah_diambil'];
const LIPAT_STATUS = ['proses_setrika', 'selesai_setrika', 'proses_lipat'];

function u(kode) { return (BY_KODE[kode] && BY_KODE[kode].urutan) || 0; }

/**
 * @param {{status_bayar:string, status_kode:string|null, kategori:string[]}} r
 * @returns {{grup:string|null, sub:'cuci'|'kering'|null, drop_off:boolean}}
 */
function kelompokkan(r) {
  const kode = r.status_kode || 'menunggu_bayar';
  const kat = r.kategori || [];
  const ada = (k) => kat.includes(k);
  const out = { grup: null, sub: null, drop_off: false, belum_bayar: false };
  if (TERMINAL.includes(kode)) return out;
  const lunas = r.status_bayar === 'lunas';
  // Perubahan #13: bayar saat ambil -> ikut alur proses seperti lunas, tapi
  // tetap dihitung di Belum Bayar (dobel, seperti Drop-Off).
  const bsa = !lunas && !!r.bayar_saat_ambil;
  out.belum_bayar = !lunas;

  if (!lunas && !bsa) {
    out.grup = 'belum_bayar';
  } else if (kode === 'siap_diambil' || kode === 'proses_antar') {
    out.grup = 'siap';
  } else if (kode === 'alokasi_mesin_cuci' || kode === 'alokasi_mesin_kering') {
    out.grup = 'alokasi_mesin'; out.sub = kode === 'alokasi_mesin_cuci' ? 'cuci' : 'kering';
  } else if (kode === 'mulai_cuci' || kode === 'mulai_kering') {
    out.grup = 'proses_mesin'; out.sub = kode === 'mulai_cuci' ? 'cuci' : 'kering';
  } else if (LIPAT_STATUS.includes(kode)) {
    out.grup = 'lipat';
  } else {
    const next = nextStatus(kode, kat);
    if (next === 'alokasi_mesin_cuci') { out.grup = 'antre_mesin'; out.sub = 'cuci'; }
    else if (next === 'alokasi_mesin_kering') { out.grup = 'antre_mesin'; out.sub = 'kering'; }
    else if (next === 'proses_setrika' || next === 'proses_lipat') out.grup = 'lipat';
    else if (!next || next === 'siap_diambil' || next === 'proses_antar') out.grup = 'siap';
    else if (u(kode) < u('alokasi_mesin_cuci')) {
      // tahap jemput: masuk antre mesin pertama yang dipesan
      if (ada('cuci')) { out.grup = 'antre_mesin'; out.sub = 'cuci'; }
      else if (ada('kering')) { out.grup = 'antre_mesin'; out.sub = 'kering'; }
      else if (ada('lipat') || ada('setrika_lipat')) out.grup = 'lipat';
      else out.grup = 'siap';
    }
  }
  out.drop_off = ada('drop_off') && out.grup !== 'siap';
  return out;
}

/** Cocokkan hasil kelompokkan() dengan tab (+ sub opsional). */
function cocokTab(k, tab, sub) {
  if (tab === 'drop_off') return k.drop_off;
  if (tab === 'belum_bayar') return k.belum_bayar;
  if (k.grup !== tab) return false;
  if (sub && ['antre_mesin', 'alokasi_mesin', 'proses_mesin'].includes(tab)) return k.sub === sub;
  return true;
}

module.exports = { kelompokkan, cocokTab, TAB_BARU, TERMINAL };
