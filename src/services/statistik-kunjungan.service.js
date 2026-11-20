/**
 * src/services/statistik-kunjungan.service.js
 * =============================================================================
 * Perubahan #60 -- Manager › Customer: statistik 30 hari terakhir (kemarin
 * mundur 30 hari; hari ini tidak ikut karena belum lengkap).
 *  - hari : RATA-RATA kunjungan per hari (Sen..Min). 1 kunjungan = 1 pelanggan
 *           pada 1 tanggal (bukan transaksi). Rata = total ÷ berapa kali hari
 *           itu muncul di rentang.
 *  - jam  : TOTAL kunjungan per jam 00..23 (1 pelanggan dihitung 1x per jam per tanggal).
 *  - antre: rata-rata per hari jumlah proses yang HARUS ANTRE karena mesin penuh:
 *           cuci  -> saat dibayar, semua washer cabang sedang jalan;
 *           kering-> saat cucinya selesai (atau saat bayar bila hanya kering),
 *                    semua dryer cabang sedang jalan.
 *           #61: + % antre per hari & rata-rata menit tunggu (sampai mesin
 *           pertama yang sedang jalan selesai).
 *           Sumber: mesin_usage (waktu mulai-selesai). Jumlah mesin = mesin
 *           yang tidak nonaktif sekarang. Hanya baca.
 * cabangId boleh angka atau array (owner gabungan).
 * =============================================================================
 */
const db = require('../config/database');
const { today } = require('../helpers/date');

const HARI = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
// MySQL DAYOFWEEK: 1=Min..7=Sab -> index 0=Sen..6=Min
const idxHari = (dow) => (Number(dow) + 5) % 7;
const r1 = (n) => Math.round(n * 10) / 10;

function rentang() {
  const t = new Date(`${today()}T00:00:00Z`);
  const sampai = new Date(t.getTime() - 86400000);           // kemarin
  const dari = new Date(t.getTime() - 30 * 86400000);        // 30 hari
  const ymd = (d) => d.toISOString().slice(0, 10);
  const nHari = Array(7).fill(0);
  for (let d = new Date(dari); d <= sampai; d = new Date(d.getTime() + 86400000)) nHari[(d.getUTCDay() + 6) % 7] += 1;
  return { dari: ymd(dari), sampai: ymd(sampai), nHari };
}

async function antreCabang(cabangId, dari, sampai) {
  const mesin = await db.query(
    "SELECT tipe, COUNT(*) AS n FROM mesin WHERE cabang_id = ? AND status <> 'nonaktif' AND tipe IN ('washer','dryer') GROUP BY tipe", [cabangId]);
  const jml = { washer: 0, dryer: 0 };
  mesin.forEach((m) => { jml[m.tipe] = Number(m.n); });
  const hasil = { cuci: Array(7).fill(0), kering: Array(7).fill(0), proses: 0,
    // Perubahan #61: semua proses per hari & total menit tunggu (hanya yang antre)
    proses_cuci: Array(7).fill(0), proses_kering: Array(7).fill(0), tunggu_cuci: Array(7).fill(0), tunggu_kering: Array(7).fill(0) };
  // Ambil sekali, hitung di JS (jauh lebih cepat daripada subquery berkorelasi).
  const [usage, job] = await Promise.all([
    db.query(
      `SELECT u.mesin_id, m.tipe, u.transaksi_id, DATE_FORMAT(u.waktu_mulai, '%Y-%m-%d %H:%i:%s') AS a, DATE_FORMAT(u.waktu_selesai, '%Y-%m-%d %H:%i:%s') AS b
         FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
        WHERE m.cabang_id = ? AND m.tipe IN ('washer','dryer') AND u.waktu_selesai IS NOT NULL
          AND u.waktu_mulai < ? + INTERVAL 2 DAY AND u.waktu_selesai > ? - INTERVAL 1 DAY`, [cabangId, sampai, dari]),
    db.query(
      `SELECT dt.transaksi_id, l.kategori, DATE_FORMAT(COALESCE(t.tanggal_bayar, t.tanggal), '%Y-%m-%d %H:%i:%s') AS bayar
         FROM detail_transaksi dt JOIN layanan l ON l.id = dt.layanan_id JOIN transaksi t ON t.id = dt.transaksi_id
        WHERE t.cabang_id = ? AND l.kategori IN ('cuci','kering') AND dt.mesin_id IS NOT NULL
          AND t.tanggal >= ? - INTERVAL 1 DAY AND t.tanggal < ? + INTERVAL 1 DAY`, [cabangId, dari, sampai]),
  ]);
  // waktu tersimpan sebagai jam WIB -> detik (bebas zona waktu server DB)
  const dtk = (x) => Date.parse(String(x).replace(' ', 'T') + '+07:00') / 1000;
  usage.forEach((u) => { u.a = dtk(u.a); u.b = dtk(u.b); });
  job.forEach((j) => { j.bayar = dtk(j.bayar); });
  const per = { washer: [], dryer: [] };
  const cuciSelesai = new Map(); // transaksi -> waktu cuci selesai terakhir
  usage.forEach((u) => {
    per[u.tipe].push(u);
    if (u.tipe === 'washer') cuciSelesai.set(Number(u.transaksi_id), Math.max(cuciSelesai.get(Number(u.transaksi_id)) || 0, u.b));
  });
  // null = ada mesin kosong; angka = detik sampai mesin pertama yang sedang jalan selesai
  const penuh = (tipe, t0) => {
    if (!jml[tipe]) return null;
    const sibuk = new Map();
    for (const u of per[tipe]) if (u.a <= t0 && u.b > t0) sibuk.set(u.mesin_id, Math.max(sibuk.get(u.mesin_id) || 0, u.b));
    if (sibuk.size < jml[tipe]) return null;
    return Math.min(...sibuk.values()) - t0;
  };
  const tDari = Date.parse(`${dari}T00:00:00+07:00`) / 1000;
  const tSampai = Date.parse(`${sampai}T00:00:00+07:00`) / 1000 + 86400;
  for (const j of job) {
    const kering = j.kategori === 'kering';
    const t0 = kering ? (cuciSelesai.get(Number(j.transaksi_id)) || j.bayar) : j.bayar;
    if (!(t0 >= tDari && t0 < tSampai)) continue;
    hasil.proses += 1;
    const hariIdx = (new Date((t0 + 7 * 3600) * 1000).getUTCDay() + 6) % 7; // WIB, 0=Sen
    const k = kering ? 'kering' : 'cuci';
    hasil['proses_' + k][hariIdx] += 1;
    const tunggu = penuh(kering ? 'dryer' : 'washer', t0);
    if (tunggu != null) { hasil[k][hariIdx] += 1; hasil['tunggu_' + k][hariIdx] += tunggu / 60; }
  }
  return hasil;
}

async function statistik(cabangId) {
  const ids = (Array.isArray(cabangId) ? cabangId : [cabangId]).map(Number);
  const { dari, sampai, nHari } = rentang();
  const ph = ids.map(() => '?').join(',');
  const [hariRows, jamRows] = await Promise.all([
    db.query(
      `SELECT DAYOFWEEK(d) AS dow, COUNT(*) AS n FROM (
         SELECT DISTINCT cabang_id, DATE(tanggal) AS d, COALESCE(pelanggan_id, -id) AS p
           FROM transaksi WHERE cabang_id IN (${ph}) AND tanggal >= ? AND tanggal < ? + INTERVAL 1 DAY) x
       GROUP BY dow`, [...ids, dari, sampai]),
    db.query(
      `SELECT h AS jam, COUNT(*) AS n FROM (
         SELECT DISTINCT cabang_id, DATE(tanggal) AS d, HOUR(tanggal) AS h, COALESCE(pelanggan_id, -id) AS p
           FROM transaksi WHERE cabang_id IN (${ph}) AND tanggal >= ? AND tanggal < ? + INTERVAL 1 DAY) x
       GROUP BY h`, [...ids, dari, sampai]),
  ]);
  const totHari = Array(7).fill(0);
  hariRows.forEach((r) => { totHari[idxHari(r.dow)] += Number(r.n); });
  const jam = Array.from({ length: 24 }, (_, h) => ({ jam: h, total: 0 }));
  jamRows.forEach((r) => { jam[Number(r.jam)].total = Number(r.n); });

  const K7 = ['cuci', 'kering', 'proses_cuci', 'proses_kering', 'tunggu_cuci', 'tunggu_kering'];
  const antre = { proses: 0 }; K7.forEach((k) => { antre[k] = Array(7).fill(0); });
  for (const id of ids) {
    const a = await antreCabang(id, dari, sampai);
    for (let i = 0; i < 7; i++) K7.forEach((k) => { antre[k][i] += a[k][i]; });
    antre.proses += a.proses;
  }
  const pct = (a, b) => (b ? r1((a / b) * 100) : 0);
  const rataT = (t, n) => (n ? Math.round(t / n) : null);
  return {
    dari, sampai,
    hari: HARI.map((label, i) => ({ label, total: totHari[i], n_hari: nHari[i], rata: nHari[i] ? r1(totHari[i] / nHari[i]) : 0 })),
    jam,
    antre: HARI.map((label, i) => ({
      label, cuci: antre.cuci[i], kering: antre.kering[i], n_hari: nHari[i],
      cuci_rata: nHari[i] ? r1(antre.cuci[i] / nHari[i]) : 0, kering_rata: nHari[i] ? r1(antre.kering[i] / nHari[i]) : 0,
      // Perubahan #61
      proses_cuci: antre.proses_cuci[i], proses_kering: antre.proses_kering[i],
      persen: pct(antre.cuci[i] + antre.kering[i], antre.proses_cuci[i] + antre.proses_kering[i]),
      persen_cuci: pct(antre.cuci[i], antre.proses_cuci[i]), persen_kering: pct(antre.kering[i], antre.proses_kering[i]),
      tunggu_cuci: rataT(antre.tunggu_cuci[i], antre.cuci[i]), tunggu_kering: rataT(antre.tunggu_kering[i], antre.kering[i]),
      tunggu: rataT(antre.tunggu_cuci[i] + antre.tunggu_kering[i], antre.cuci[i] + antre.kering[i]),
    })),
    tunggu_rata: rataT(antre.tunggu_cuci.reduce((a, b) => a + b, 0) + antre.tunggu_kering.reduce((a, b) => a + b, 0),
      antre.cuci.reduce((a, b) => a + b, 0) + antre.kering.reduce((a, b) => a + b, 0)),
    persen_total: pct(antre.cuci.reduce((a, b) => a + b, 0) + antre.kering.reduce((a, b) => a + b, 0), antre.proses),
    antre_total: antre.cuci.reduce((a, b) => a + b, 0) + antre.kering.reduce((a, b) => a + b, 0),
    proses_total: antre.proses,
  };
}

module.exports = { statistik };
