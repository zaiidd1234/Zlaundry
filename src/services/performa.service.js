/**
 * src/services/performa.service.js
 * =============================================================================
 * Analitik performa untuk MANAGER (scope 1 cabang).
 * Tahap Ringkasan: data harian untuk chart kombo —
 *   - omzet mesin (cuci & kering) vs non-mesin (jasa lain + barang), stacked bar
 *   - jumlah transaksi (line)
 *   - pelanggan unik (line)
 * Filter periode: 7 atau 30 hari terakhir (termasuk hari ini).
 * =============================================================================
 */

const transaksiModel = require('../models/transaksi.model');
const cabangModel = require('../models/cabang.model');
const db = require('../config/database');
const { today, now } = require('../helpers/date');

/** Hitung rentang N hari terakhir (WIB-safe), termasuk hari ini. */
function rangeHari(n) {
  const ymd = today();
  const base = new Date(ymd + 'T00:00:00+07:00');
  base.setDate(base.getDate() - (n - 1));
  const dari = new Date(base.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return { dari, sampai: ymd };
}

/** Bangun deret tanggal kontinu dari dari..sampai (YYYY-MM-DD). */
function deretTanggal(dari, sampai) {
  const out = [];
  let cur = new Date(dari + 'T00:00:00+07:00');
  const end = new Date(sampai + 'T00:00:00+07:00');
  while (cur <= end) {
    out.push(new Date(cur.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function ymdOf(v) {
  return String(v).slice(0, 10);
}

function fmtTglShort(ymd) {
  const [, m, d] = ymd.split('-');
  return `${d}/${m}`;
}
function namaBulanShort(ym) {
  const [y, m] = ym.split('-').map(Number);
  const nm = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${nm[m - 1]} ${String(y).slice(2)}`;
}
/** Rentang tanggal -> "5–11 Mei" atau "28 Mei–3 Jun" (lintas bulan). */
function rentangLabel(a, b) {
  const nm = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const [, ma, da] = a.split('-').map((x, i) => i === 0 ? x : Number(x));
  const [, mb, db] = b.split('-').map((x, i) => i === 0 ? x : Number(x));
  const ba = nm[Number(a.slice(5, 7)) - 1], bb = nm[Number(b.slice(5, 7)) - 1];
  const dA = Number(a.slice(8, 10)), dB = Number(b.slice(8, 10));
  if (a.slice(0, 7) === b.slice(0, 7)) return `${dA}–${dB} ${bb}`;
  return `${dA} ${ba}–${dB} ${bb}`;
}

/** Tanggal transaksi pertama cabang (patokan "buka usaha"). null kalau belum ada. */
async function tanggalBuka(cabangId) {
  const row = await transaksiModel.tanggalTransaksiPertama
    ? await transaksiModel.tanggalTransaksiPertama(cabangId)
    : null;
  return row;
}

/**
 * Tanggal buka (tanggal_buka manual, fallback transaksi lunas pertama).
 * Perubahan #47: cabangId boleh array (gabungan owner) -> tanggal paling awal.
 */
async function tanggalBukaCabang(cabangId) {
  const ids = Array.isArray(cabangId) ? cabangId : [cabangId];
  const hasil = await Promise.all(ids.map(async (id) => {
    const row = await cabangModel.findById(id).catch(() => null);
    return (row && row.tanggal_buka) ? String(row.tanggal_buka).slice(0, 10) : transaksiModel.tanggalTransaksiPertama(id);
  }));
  const ada = hasil.filter(Boolean).sort();
  return ada[0] || null;
}

/** Selisih hari antar 2 ymd. */
function selisihHari(a, b) {
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

/** Nomor minggu ke-N sejak tanggal buka (minggu 1 = minggu pertama buka). */
function nomorMinggu(ymd, ymdBuka) {
  if (!ymdBuka) return 1;
  const d = selisihHari(ymdBuka, ymd);
  return Math.floor(d / 7) + 1;
}

/** Awal-akhir rentang N periode terakhir (mingguan/bulanan), dalam tanggal. */
function rangeMode(mode, n, ymdSampai) {
  const sampai = ymdSampai;
  const base = new Date(sampai + 'T00:00:00+07:00');
  if (mode === 'bulanan') {
    base.setMonth(base.getMonth() - (n - 1));
    base.setDate(1);
  } else { // mingguan
    base.setDate(base.getDate() - (n * 7 - 1));
  }
  const dari = new Date(base.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return { dari, sampai };
}

/** Ringkasan harian untuk chart kombo. periode = 7 | 30. */
async function ringkasan(cabangId, opts = {}) {
  // opts: { periode: 7|30, mode: 'harian'|'mingguan'|'bulanan' }
  const mode = ['mingguan', 'bulanan'].includes(opts.mode) ? opts.mode : 'harian';
  const ymd = today();

  // Buat mingguan/bulanan: tarik FULL histori sejak cabang buka (bukan cuma
  // window N bucket terakhir) -- biar UI bisa nampilin 8/6 bucket default di
  // ujung kanan (terbaru), TAPI tetap bisa discroll ke kiri buat lihat semua
  // histori dari awal. bucketCount di sini cuma dipakai buat "ukuran window
  // default" (metadata utk FE), bukan lagi buat MEMBATASI rentang tanggal.
  let dari, sampai, bucketCount, ymdBuka = null;
  if (mode === 'mingguan' || mode === 'bulanan') {
    // prioritas: tanggal_buka manual (kalau diisi) -- lebih akurat drpd nebak
    // dari transaksi lunas pertama (bisa meleset kalau transaksi pertama baru
    // terjadi beberapa hari SETELAH toko resmi buka).
    ymdBuka = await tanggalBukaCabang(cabangId);
    sampai = ymd;
    if (mode === 'mingguan') {
      bucketCount = 8;
      dari = ymdBuka || rangeMode('mingguan', 8, ymd).dari; // fallback kalau belum pernah ada transaksi
    } else {
      bucketCount = 6;
      dari = ymdBuka ? ymdBuka.slice(0, 7) + '-01' : rangeMode('bulanan', 6, ymd).dari;
    }
  } else {
    // Perubahan #18: harian tarik histori PENUH sejak cabang buka; layar
    // menampilkan 8 / 30 hari terakhir, sisanya digeser ke kiri.
    bucketCount = opts.periode === 30 ? 30 : 8;
    ({ dari, sampai } = rangeHari(bucketCount));
    ymdBuka = await tanggalBukaCabang(cabangId);
    if (ymdBuka && ymdBuka < dari) dari = ymdBuka;
  }

  // Perubahan #79: jam sekarang (WIB) untuk garis "omzet s/d titik waktu yang sama"
  const nowStr = now(); const jamNow = nowStr.slice(11, 19); const hariIni = nowStr.slice(0, 10);
  const [omzetRows, txRows, sdRows] = await Promise.all([
    transaksiModel.omzetMesinHarian(cabangId, dari, sampai),
    transaksiModel.transaksiPelangganHarian(cabangId, dari, sampai),
    transaksiModel.omzetTotalHarianSampaiJam(cabangId, dari, sampai, jamNow),
  ]);
  const omzetMap = new Map(omzetRows.map((r) => [ymdOf(r.tanggal), r]));
  const sdMap = new Map(sdRows.map((r) => [ymdOf(r.tanggal), Number(r.omzet) || 0]));
  const fullHari = (t) => { const o = omzetMap.get(t) || {}; return (Number(o.omzet_mesin) || 0) + (Number(o.omzet_nonmesin) || 0); };
  const tambahHari = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  // omzet dari tgl a s/d tgl b (penuh) + tgl c s/d jamNow
  const omzetSd = (awal, akhirPenuh, hariPotong) => {
    let s = 0;
    for (let t = awal; t <= akhirPenuh; t = tambahHari(t, 1)) s += fullHari(t);
    if (hariPotong) s += sdMap.get(hariPotong) || 0;
    return s;
  };
  const txMap = new Map(txRows.map((r) => [ymdOf(r.tanggal), r]));

  let data;
  if (mode === 'harian') {
    data = deretTanggal(dari, sampai).map((t) => {
      const o = omzetMap.get(t) || {}; const x = txMap.get(t) || {};
      const m = Number(o.omzet_mesin) || 0, nm = Number(o.omzet_nonmesin) || 0;
      const cuci = Number(o.omzet_cuci) || 0, kering = Number(o.omzet_kering) || 0;
      return { label: fmtTglShort(t), tanggal: t, omzet_cuci: cuci, omzet_kering: kering, omzet_mesin: m, omzet_nonmesin: nm, omzet_total: m + nm, jumlah_transaksi: Number(x.jumlah_transaksi) || 0, pelanggan_unik: Number(x.pelanggan_unik) || 0,
        omzet_sd: sdMap.get(t) || 0 }; // #79 hour to hour
    });
  } else {
    // agregasi harian -> bucket (minggu/bulan)
    const buckets = new Map();
    for (const t of deretTanggal(dari, sampai)) {
      let key, label, valid = true;
      if (mode === 'bulanan') {
        key = t.slice(0, 7); label = namaBulanShort(key);
        if (ymdBuka && key < ymdBuka.slice(0, 7)) valid = false; // sebelum buka
      } else {
        const w = nomorMinggu(t, ymdBuka);
        if (w < 1) valid = false;                                // sebelum minggu buka
        key = 'W' + w; label = 'Minggu ' + w;
      }
      if (!valid) continue;
      if (!buckets.has(key)) buckets.set(key, { label, omzet_cuci: 0, omzet_kering: 0, omzet_mesin: 0, omzet_nonmesin: 0, jumlah_transaksi: 0, _pel: 0, tgl_awal: t, tgl_akhir: t });
      const b = buckets.get(key);
      if (t < b.tgl_awal) b.tgl_awal = t;
      if (t > b.tgl_akhir) b.tgl_akhir = t;
      const o = omzetMap.get(t) || {}; const x = txMap.get(t) || {};
      b.omzet_cuci += Number(o.omzet_cuci) || 0;
      b.omzet_kering += Number(o.omzet_kering) || 0;
      b.omzet_mesin += Number(o.omzet_mesin) || 0;
      b.omzet_nonmesin += Number(o.omzet_nonmesin) || 0;
      b.jumlah_transaksi += Number(x.jumlah_transaksi) || 0;
      b._pel += Number(x.pelanggan_unik) || 0;
    }
    data = [...buckets.entries()].map(([key, b]) => ({
      label: b.label,
      bulan: mode === 'bulanan' ? key : undefined,
      rentang: rentangLabel(b.tgl_awal, b.tgl_akhir),
      tgl_awal: b.tgl_awal, tgl_akhir: b.tgl_akhir, // Perubahan #71
      omzet_cuci: b.omzet_cuci, omzet_kering: b.omzet_kering,
      omzet_mesin: b.omzet_mesin, omzet_nonmesin: b.omzet_nonmesin,
      omzet_total: b.omzet_mesin + b.omzet_nonmesin,
      jumlah_transaksi: b.jumlah_transaksi, pelanggan_unik: b._pel || 0,
      _key: key,
    }));
    // Perubahan #79: omzet s/d titik yang sama dengan sekarang
    if (mode === 'mingguan') {
      // minggu = blok 7 hari sejak toko buka; k = indeks hari sekarang di blok (0..6)
      const k = ymdBuka ? ((selisihHari(ymdBuka, hariIni) % 7) + 7) % 7 : 0;
      for (const d of data) {
        const w = Number(String(d._key).slice(1));
        const awal = ymdBuka ? tambahHari(ymdBuka, 7 * (w - 1)) : d.tgl_awal;
        d.omzet_sd = omzetSd(awal, tambahHari(awal, k - 1), tambahHari(awal, k));
        d.sd_label = `s/d hari ke-${k + 1} ${jamNow.slice(0, 5)}`;
      }
    } else {
      const tgl = Number(hariIni.slice(8, 10));
      for (const d of data) {
        const [y, m] = d.bulan.split('-').map(Number);
        const akhirBln = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const awal = `${d.bulan}-01`;
        if (tgl > akhirBln) d.omzet_sd = omzetSd(awal, `${d.bulan}-${String(akhirBln).padStart(2, '0')}`, null); // bulan lebih pendek
        else d.omzet_sd = omzetSd(awal, tambahHari(`${d.bulan}-${String(tgl).padStart(2, '0')}`, -1), `${d.bulan}-${String(tgl).padStart(2, '0')}`);
        d.sd_label = `s/d tgl ${tgl} ${jamNow.slice(0, 5)}`;
      }
    }
    data.forEach((d) => { delete d._key; });
  }
  if (mode === 'harian') data.forEach((d) => { d.sd_label = `s/d ${jamNow.slice(0, 5)}`; });

  // ringkasan (kartu Total Omzet dkk) HARUS tetap cuma window default (8
  // minggu/6 bulan terakhir), BUKAN full histori -- biar tetap relevan sbg
  // "ringkasan periode ini", walau `data` (buat chart) isinya full histori
  // supaya bisa discroll.
  // Perubahan #18: bulanan -> bar ke-2 keuangan dari KAS BESAR (sama dengan
  // Laporan Laba-Rugi): pendapatan = masuk setor_penjualan, biaya = keluar
  // reimburse/opex/akrual/biaya_loyalty/winpay_mdr, laba = pendapatan - biaya.
  if (mode === 'bulanan' && data.length) {
    const keu = await db.query(
      `SELECT DATE_FORMAT(tanggal, '%Y-%m') AS bln,
              SUM(CASE WHEN jenis = 'masuk' AND sumber = 'setor_penjualan' THEN nominal ELSE 0 END) AS pendapatan,
              SUM(CASE WHEN jenis = 'keluar' AND sumber IN ('reimburse','opex','akrual','biaya_loyalty','winpay_mdr') THEN nominal ELSE 0 END) AS biaya
         FROM kas_besar
        WHERE ref_cabang_id IN (${(Array.isArray(cabangId) ? cabangId : [cabangId]).map(() => '?').join(',')}) AND DATE(tanggal) BETWEEN ? AND LAST_DAY(?)
        GROUP BY DATE_FORMAT(tanggal, '%Y-%m')`,
      // s/d AKHIR bulan berjalan (bukan hari ini): beban akrual (sewa, internet)
      // dicatat bertanggal akhir bulan -- sama dengan Laporan Laba-Rugi bulanan.
      [...(Array.isArray(cabangId) ? cabangId : [cabangId]), dari, sampai]
    );
    const keuMap = new Map(keu.map((r) => [r.bln, r]));
    for (const d of data) {
      const k = keuMap.get(d.bulan) || {};
      const pend = Math.round(Number(k.pendapatan) || 0), biaya = Math.round(Number(k.biaya) || 0);
      d.keu_pendapatan = pend;
      d.keu_biaya = biaya;
      d.keu_laba = pend - biaya;                 // bisa negatif (rugi)
      d.keu_laba_bar = Math.max(0, pend - biaya); // segmen hijau (rugi -> 0)
    }
  }

  const ringkasData = data.slice(-bucketCount);
  const totalOmzet = ringkasData.reduce((s, d) => s + d.omzet_total, 0);
  const totalTransaksi = ringkasData.reduce((s, d) => s + d.jumlah_transaksi, 0);
  return {
    mode, dari, sampai,
    periode: bucketCount,
    tanggal_buka: ymdBuka || null,
    data,
    ringkas: {
      total_omzet: totalOmzet,
      total_omzet_cuci: ringkasData.reduce((s, d) => s + d.omzet_cuci, 0),
      total_omzet_kering: ringkasData.reduce((s, d) => s + d.omzet_kering, 0),
      total_omzet_mesin: ringkasData.reduce((s, d) => s + d.omzet_mesin, 0),
      total_omzet_nonmesin: ringkasData.reduce((s, d) => s + d.omzet_nonmesin, 0),
      total_transaksi: totalTransaksi,
      rata_omzet_harian: ringkasData.length ? Math.round(totalOmzet / ringkasData.length) : 0,
    },
  };
}

/**
 * Performa-Pelanggan: bar baru/lama + garis akumulasi total pelanggan.
 * Perubahan #70: data penuh SEJAK TOKO BUKA (bisa digeser seperti tab Ringkasan);
 * tampilan awal = window terbaru (8/30 hari, 8 minggu, 6 bulan). Mode harian /
 * mingguan / bulanan. Kartu ringkas tetap hanya window terbaru.
 */
async function pelanggan(cabangId, opts = {}) {
  if (typeof opts === 'number') opts = { periode: opts };
  const mode = ['mingguan', 'bulanan'].includes(opts.mode) ? opts.mode : 'harian';
  const ymd = today();
  const ymdBuka = await tanggalBukaCabang(cabangId);
  let dari, sampai = ymd, bucketCount;
  if (mode === 'harian') {
    bucketCount = opts.periode === 30 ? 30 : 8;
    ({ dari, sampai } = rangeHari(bucketCount));
    if (ymdBuka && ymdBuka < dari) dari = ymdBuka;
  } else if (mode === 'mingguan') {
    bucketCount = 8; dari = ymdBuka || rangeMode('mingguan', 8, ymd).dari;
  } else {
    bucketCount = 6; dari = ymdBuka ? ymdBuka.slice(0, 7) + '-01' : rangeMode('bulanan', 6, ymd).dari;
  }

  const [harianRows, baruSejakAwal] = await Promise.all([
    transaksiModel.pelangganBaruLamaHarian(cabangId, dari, sampai),
    transaksiModel.pelangganBaruSejakAwal(cabangId, sampai),
  ]);
  const harianMap = new Map(harianRows.map((r) => [ymdOf(r.tanggal), r]));
  const akumMap = new Map();
  let run = 0;
  baruSejakAwal.forEach((r) => { run += Number(r.baru) || 0; akumMap.set(ymdOf(r.tanggal), run); });
  let lastAkum = 0;
  for (const r of baruSejakAwal) {
    if (ymdOf(r.tanggal) < dari) lastAkum = akumMap.get(ymdOf(r.tanggal));
    else break;
  }
  const harian = deretTanggal(dari, sampai).map((t) => {
    const h = harianMap.get(t) || {};
    if (akumMap.has(t)) lastAkum = akumMap.get(t);
    return { tanggal: t, baru: Number(h.baru) || 0, lama: Number(h.lama) || 0, total_harian: (Number(h.baru) || 0) + (Number(h.lama) || 0), akumulasi: lastAkum };
  });

  let data = harian;
  if (mode !== 'harian') {
    const buckets = new Map();
    for (const d of harian) {
      let key, label;
      if (mode === 'bulanan') {
        key = d.tanggal.slice(0, 7); label = namaBulanShort(key);
        if (ymdBuka && key < ymdBuka.slice(0, 7)) continue;
      } else {
        const w = nomorMinggu(d.tanggal, ymdBuka);
        if (w < 1) continue;
        key = 'W' + w; label = 'Minggu ' + w;
      }
      if (!buckets.has(key)) buckets.set(key, { label, bulan: mode === 'bulanan' ? key : undefined, baru: 0, lama: 0, total_harian: 0, akumulasi: 0, tgl_awal: d.tanggal, tgl_akhir: d.tanggal });
      const b = buckets.get(key);
      b.baru += d.baru; b.lama += d.lama; b.total_harian += d.total_harian; b.akumulasi = d.akumulasi;
      if (d.tanggal < b.tgl_awal) b.tgl_awal = d.tanggal;
      if (d.tanggal > b.tgl_akhir) b.tgl_akhir = d.tanggal;
    }
    data = [...buckets.values()].map((b) => ({ ...b, tanggal: b.tgl_awal, rentang: rentangLabel(b.tgl_awal, b.tgl_akhir) }));
  }

  const jendela = data.slice(-bucketCount);
  return {
    mode, periode: bucketCount, dari, sampai, tanggal_buka: ymdBuka || null, data,
    ringkas: {
      total_pelanggan: data.length ? data[data.length - 1].akumulasi : 0,
      pelanggan_baru: jendela.reduce((s, d) => s + d.baru, 0),
      kunjungan_lama: jendela.reduce((s, d) => s + d.lama, 0),
    },
  };
}

/** Performa-Produk: layanan terlaris, barang terlaris, mesin terlaku, jam ramai. */
async function produk(cabangId, periode = 8) {
  const n = periode === 30 ? 30 : 8;
  const { dari, sampai } = rangeHari(n);

  const [layanan, barang, mesin, jamRows] = await Promise.all([
    transaksiModel.layananTerlaris(cabangId, dari, sampai, 8),
    transaksiModel.barangTerlaris(cabangId, dari, sampai, 8),
    transaksiModel.mesinTerlaku(cabangId, dari, sampai, 10),
    transaksiModel.jamRamai(cabangId, dari, sampai),
  ]);

  // jam ramai: isi 0-23 penuh
  const jamMap = new Map(jamRows.map((r) => [Number(r.jam), Number(r.jumlah) || 0]));
  const jam = Array.from({ length: 24 }, (_, h) => ({ jam: h, jumlah: jamMap.get(h) || 0 }));
  const jamTop = jamRows.length
    ? jamRows.reduce((a, b) => (Number(b.jumlah) > Number(a.jumlah) ? b : a))
    : null;

  return {
    periode: n, dari, sampai,
    layanan: layanan.map((l) => ({ nama: l.nama, qty: Number(l.qty) || 0, omzet: Number(l.omzet) || 0, transaksi: Number(l.transaksi) || 0 })),
    barang: barang.map((b) => ({ nama: b.nama, qty: Number(b.qty) || 0, omzet: Number(b.omzet) || 0 })),
    mesin: mesin.map((m) => ({ kode: m.kode, nama: m.nama_mesin, tipe: m.tipe, pemakaian: Number(m.pemakaian) || 0 })),
    jam,
    jam_ramai: jamTop ? { jam: Number(jamTop.jam), jumlah: Number(jamTop.jumlah) } : null,
  };
}

module.exports = { ringkasan, pelanggan, produk };
