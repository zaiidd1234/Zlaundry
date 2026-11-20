/**
 * src/models/pelanggan.model.js
 * =============================================================================
 * Akses tabel `pelanggan`.
 * Kolom: id, cabang_id, nama, telepon, alamat, point, frekuensi_kedatangan,
 *   created_at, updated_at.  (tanpa email — sesuai keputusan)
 * Key identitas pelanggan = (cabang_id, telepon).
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, nama, telepon, alamat, point, frekuensi_kedatangan,
  created_at, updated_at
`;

/** Cari pelanggan by cabang + telepon (key identitas). Null kalau tidak ada. */
/* Perubahan #47: daftar & analitik pelanggan menerima 1 cabang ATAU daftar cabang (gabungan owner). */
const cP = (c) => (Array.isArray(c) ? c.map(Number) : [Number(c)]);
const cQ = (c) => cP(c).map(() => '?').join(',');

async function findByTelepon(cabangId, telepon, conn = null) {
  const runner = conn || db;
  const sql = `SELECT ${FIELDS} FROM pelanggan WHERE cabang_id = ? AND telepon = ? LIMIT 1`;
  if (conn) { const [rows] = await conn.execute(sql, [cabangId, telepon]); return rows[0] || null; }
  return db.queryOne(sql, [cabangId, telepon]);
}

async function findById(id, conn = null) {
  const sql = `SELECT ${FIELDS} FROM pelanggan WHERE id = ? LIMIT 1`;
  if (conn) { const [rows] = await conn.execute(sql, [id]); return rows[0] || null; }
  return db.queryOne(sql, [id]);
}

/**
 * Insert pelanggan baru. Bisa pakai koneksi transaksi (conn) atau pool default.
 * @returns {number} insertId
 */
async function create({ cabangId, nama, telepon, alamat = null }, conn = null) {
  const sql = `INSERT INTO pelanggan (cabang_id, nama, telepon, alamat, point, frekuensi_kedatangan)
               VALUES (?,?,?,?,0,0)`;
  const params = [cabangId, nama, telepon, alamat];
  const runner = conn || db.pool;
  const [r] = await runner.execute(sql, params);
  return r.insertId;
}

/**
 * Tambah point & frekuensi (dipakai saat transaksi lunas). Bisa pakai conn transaksi.
 */
async function tambahPointFrekuensi(id, addPoint, addFrekuensi, conn = null) {
  const sql = `UPDATE pelanggan
               SET point = point + ?, frekuensi_kedatangan = frekuensi_kedatangan + ?
               WHERE id = ?`;
  const runner = conn || db.pool;
  await runner.execute(sql, [addPoint, addFrekuensi, id]);
}

/** Catat login customer: tambah login_count + set last_login + last_lat/last_lng. */
async function catatLogin(id, loc = {}, conn = null) {
  const runner = conn || db.pool;
  if (loc.lat != null && loc.lng != null) {
    await runner.execute(
      `UPDATE pelanggan SET login_count = COALESCE(login_count, 0) + 1, last_login = NOW(),
       last_lat = ?, last_lng = ? WHERE id = ?`,
      [loc.lat, loc.lng, id]
    );
  } else {
    await runner.execute(
      `UPDATE pelanggan SET login_count = COALESCE(login_count, 0) + 1, last_login = NOW() WHERE id = ?`,
      [id]
    );
  }
}

/** Kurangi point (tukar poin). Bisa pakai conn transaksi. */
async function kurangiPoint(id, jumlah, conn = null) {
  const runner = conn || db.pool;
  await runner.execute(
    `UPDATE pelanggan SET point = GREATEST(0, point - ?) WHERE id = ?`,
    [jumlah, id]
  );
}

/** Cari pelanggan (search nama/telepon) untuk admin/kasir. */
async function search(cabangId, keyword, limit = 20) {
  const like = `%${keyword}%`;
  return db.query(
    `SELECT ${FIELDS} FROM pelanggan
     WHERE cabang_id = ? AND (nama LIKE ? OR telepon LIKE ?)
     ORDER BY nama ASC LIMIT ?`,
    [cabangId, like, like, limit]
  );
}

/**
 * List pelanggan untuk manager: search + filter baru/loyal/lepas + pagination.
 * Definisi:
 *   - baru  : kunjungan TERAKHIR masih dalam 30 hari terakhir, DAN total
 *             kunjungan dia SEPANJANG SEJARAH (bukan cuma dalam 30 hari
 *             ini) baru 1x -- murni pelanggan pertama kali & masih anget.
 *   - loyal : kunjungan TERAKHIR masih dalam 30 hari terakhir, DAN total
 *             kunjungan sepanjang sejarah dia lebih dari 1x -- entah
 *             semuanya terjadi di 30 hari terakhir, atau cuma 1x di 30
 *             hari terakhir tapi ada kunjungan lain sebelumnya (mis. bulan
 *             lalu). Yang penting: pernah balik lagi & masih aktif.
 *   - lepas : kunjungan TERAKHIR sudah lebih dari 30 hari yang lalu (atau
 *             belum pernah transaksi lunas sama sekali) -- baik dulunya
 *             cuma 1x datang maupun langganan rutin sekalipun, begitu 30
 *             hari gak balik lagi langsung masuk kategori ini.
 * Tiap baris dikasih kolom `kategori` ('baru'|'loyal'|'lepas') biar FE
 * tinggal pakai, gak perlu itung ulang di JS.
 */
async function listManager(cabangId, { q = '', filter = 'semua', durasi = null, limit = 20, offset = 0 } = {}) {
  const params = [...cP(cabangId)];
  let where = `p.cabang_id IN (${cQ(cabangId)}) AND LOWER(p.nama) NOT LIKE '%walk%'`;
  if (q) { const like = `%${q}%`; where += ` AND (p.nama LIKE ? OR p.telepon LIKE ?)`; params.push(like, like); }

  const base = `
    SELECT y.*, CASE
        WHEN y.last_transaksi IS NULL OR y.last_transaksi < DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 'lepas'
        WHEN y.kedatangan <= 1 THEN 'baru'
        ELSE 'loyal'
      END AS kategori
    FROM (
      SELECT p.id, p.cabang_id, p.nama, p.telepon, p.alamat, p.point, p.frekuensi_kedatangan,
             p.created_at, p.updated_at,
             (SELECT COUNT(DISTINCT DATE(t.tanggal)) FROM transaksi t WHERE t.pelanggan_id = p.id AND t.status_bayar='lunas') AS kedatangan,
             (SELECT COUNT(*) FROM transaksi t WHERE t.pelanggan_id = p.id) AS jml_transaksi,
             (SELECT MAX(t.tanggal) FROM transaksi t WHERE t.pelanggan_id = p.id AND t.status_bayar='lunas') AS last_transaksi
      FROM pelanggan p
      WHERE ${where}
    ) y`;

  let sql = base;

  if (filter === 'baru' || filter === 'loyal' || filter === 'lepas') {
    sql = `SELECT * FROM ( ${base} ) z WHERE z.kategori = ?`;
    params.push(filter);
  } else if (filter === 'point') {
    // Perubahan #17: pelanggan yang punya poin, poin terbanyak dulu
    sql = `SELECT * FROM ( ${base} ) z WHERE z.point > 0 ORDER BY z.point DESC, z.last_transaksi DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));
    return db.query(sql, params);
  } else if (filter === 'durasi' && durasi) {
    // Toleransi ketat untuk durasi kecil, longgar untuk durasi besar
    // ≤3 hari: ±0, 4-7 hari: ±1, >7 hari: ±15%
    let toleransi = 0;
    if (durasi > 7) toleransi = Math.round(durasi * 0.15);
    else if (durasi > 3) toleransi = 1;
    const min = Math.max(1, durasi - toleransi);
    const max = durasi + toleransi;
    sql = `SELECT * FROM (
      SELECT sub.*, CASE WHEN sub.kedatangan >= 2
        THEN ROUND(DATEDIFF(sub.last_transaksi, sub.first_transaksi) / (sub.kedatangan - 1))
        ELSE NULL END AS avg_selang
      FROM (
        SELECT p2.*, sub2.kedatangan, sub2.jml_transaksi, sub2.last_transaksi, sub2.first_transaksi FROM pelanggan p2
        JOIN (
          SELECT p.id,
            COUNT(DISTINCT DATE(t.tanggal)) AS kedatangan,
            COUNT(*) AS jml_transaksi,
            MAX(t.tanggal) AS last_transaksi,
            MIN(t.tanggal) AS first_transaksi
          FROM pelanggan p
          JOIN transaksi t ON t.pelanggan_id = p.id AND t.status_bayar='lunas'
          WHERE p.cabang_id IN (${cQ(cabangId)}) GROUP BY p.id HAVING kedatangan >= 2
        ) sub2 ON sub2.id = p2.id
        WHERE p2.cabang_id IN (${cQ(cabangId)})
        ${q ? `AND (p2.nama LIKE ? OR p2.telepon LIKE ?)` : ''}
      ) sub
    ) x WHERE x.avg_selang BETWEEN ? AND ?`;
    // params untuk subquery
    const likeP = q ? [`%${q}%`, `%${q}%`] : [];
    return db.query(sql + ` ORDER BY avg_selang DESC, last_transaksi DESC LIMIT ? OFFSET ?`,
      [...cP(cabangId), ...cP(cabangId), ...likeP, min, max, Number(limit), Number(offset)]);
  }

  if (filter === 'lepas') {
    sql += ` ORDER BY last_transaksi IS NULL, last_transaksi DESC`;
  } else if (filter === 'loyal') {
    sql += ` ORDER BY kedatangan DESC, last_transaksi DESC`;
  } else {
    sql += ` ORDER BY last_transaksi DESC, created_at DESC`;
  }
  sql += ` LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));
  return db.query(sql, params);
}

/** Update data pelanggan (nama, telepon, alamat). */
async function update(id, { nama, telepon, alamat }) {
  await db.pool.execute(
    `UPDATE pelanggan SET nama = ?, telepon = ?, alamat = ? WHERE id = ?`,
    [nama, telepon, alamat, id]
  );
}

/** Cek telepon sudah dipakai pelanggan lain di cabang (untuk validasi edit). */
async function teleponDipakai(cabangId, telepon, exceptId = null) {
  let sql = `SELECT id FROM pelanggan WHERE cabang_id = ? AND telepon = ?`;
  const params = [cabangId, telepon];
  if (exceptId) { sql += ` AND id <> ?`; params.push(exceptId); }
  const row = await db.queryOne(sql + ' LIMIT 1', params);
  return !!row;
}

/** Hitung jumlah pelanggan per kategori (semua/baru/loyal/lepas) untuk badge tab. q = filter search. */
async function countManager(cabangId, { q = '' } = {}) {
  const params = [...cP(cabangId)];
  let where = `p.cabang_id IN (${cQ(cabangId)}) AND LOWER(p.nama) NOT LIKE '%walk%'`;
  if (q) { const like = `%${q}%`; where += ` AND (p.nama LIKE ? OR p.telepon LIKE ?)`; params.push(like, like); }
  const rows = await db.query(
    `SELECT
       COUNT(*) AS semua,
       COALESCE(SUM(y.kategori = 'baru'), 0) AS baru,
       COALESCE(SUM(y.kategori = 'loyal'), 0) AS loyal,
       COALESCE(SUM(y.kategori = 'lepas'), 0) AS lepas,
       COALESCE(SUM(y.point > 0), 0) AS point,
       COALESCE(SUM(GREATEST(y.point, 0)), 0) AS total_point
     FROM (
       SELECT x.*, CASE
           WHEN x.last_transaksi IS NULL OR x.last_transaksi < DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 'lepas'
           WHEN x.kedatangan <= 1 THEN 'baru'
           ELSE 'loyal'
         END AS kategori
       FROM (
         SELECT p.id, p.point,
                (SELECT COUNT(DISTINCT DATE(t.tanggal)) FROM transaksi t WHERE t.pelanggan_id = p.id AND t.status_bayar='lunas') AS kedatangan,
                (SELECT MAX(t.tanggal) FROM transaksi t WHERE t.pelanggan_id = p.id AND t.status_bayar='lunas') AS last_transaksi
         FROM pelanggan p WHERE ${where}
       ) x
     ) y`,
    params
  );
  const r = rows[0] || {};
  return {
    semua: Number(r.semua) || 0, baru: Number(r.baru) || 0, loyal: Number(r.loyal) || 0, lepas: Number(r.lepas) || 0,
    point: Number(r.point) || 0, total_point: Number(r.total_point) || 0,
  };
}

/**
 * Distribusi frekuensi kunjungan pelanggan LOYAL:
 * Hitung rata-rata selang hari antar kunjungan per pelanggan,
 * lalu kelompokkan: berapa customer yang datang tiap 1 hari, 2 hari, dst.
 * Dibatasi ke pelanggan kategori "loyal" (samakan dengan tab pelanggan):
 * total kunjungan seumur hidup >= 2, DAN kunjungan terakhirnya masih
 * dalam 30 hari terakhir (masih aktif). Yang sudah "lepas" (>30 hari gak
 * balik) gak dihitung di sini walau dulu langganan rutin.
 */
async function distribusiFrekuensi(cabangId) {
  // Exclude Walk-in. Hanya pelanggan loyal (>= 2 kunjungan & masih aktif 30 hari terakhir).
  const rows = await db.query(`
    SELECT
      p.id,
      COUNT(DISTINCT DATE(t.tanggal)) AS kunjungan,
      DATEDIFF(MAX(t.tanggal), MIN(t.tanggal)) AS rentang_hari,
      SUM(t.total) AS total_omzet
    FROM pelanggan p
    JOIN transaksi t ON t.pelanggan_id = p.id AND t.status_bayar = 'lunas'
    WHERE p.cabang_id IN (${cQ(cabangId)}) AND LOWER(p.nama) NOT LIKE '%walk%' AND p.nama NOT LIKE '%Walk%'
    GROUP BY p.id
    HAVING kunjungan >= 2 AND MAX(t.tanggal) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
  `, cP(cabangId));

  const bucket = {};
  for (const r of rows) {
    const selang = Math.round(r.rentang_hari / (r.kunjungan - 1));
    if (selang < 1) continue;
    const key = Math.min(selang, 60);
    if (!bucket[key]) bucket[key] = { jumlah: 0, total_omzet: 0, total_kunjungan: 0 };
    bucket[key].jumlah++;
    bucket[key].total_omzet    += Number(r.total_omzet) || 0;
    bucket[key].total_kunjungan += Number(r.kunjungan) || 0;
  }

  return Object.entries(bucket)
    .map(([hari, b]) => {
      const h = Number(hari);
      // avg omzet per kunjungan (bukan per pelanggan total)
      const avg_omzet_per_kunjungan = b.total_kunjungan > 0
        ? Math.round(b.total_omzet / b.total_kunjungan) : 0;
      // kontribusi harian per pelanggan = omzet per kunjungan / selang hari
      const avg_omzet_per_pelanggan_per_hari = Math.round(avg_omzet_per_kunjungan / h);
      // total kontribusi harian dari seluruh pelanggan di segmen ini
      const total_per_hari = avg_omzet_per_pelanggan_per_hari * b.jumlah;
      return {
        hari: h,
        jumlah: b.jumlah,
        avg_omzet_per_pelanggan: avg_omzet_per_kunjungan,
        avg_omzet_per_pelanggan_per_hari,
        total_per_hari,
      };
    })
    .sort((a, b) => a.hari - b.hari);
}

/**
 * Forecast omzet bulan berjalan & bulan depan.
 * Metodologi:
 *   - Repeat: kontribusi harian dari pelanggan existing (distribusi frekuensi)
 *   - Baru: rata2 pelanggan baru per hari (30 hari terakhir) * avg omzet first transaction
 *   - Forecast = (repeat_harian + baru_harian) * sisa hari + realisasi s.d. hari ini
 */
async function forecastOmzet(cabangId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Hari terakhir bulan ini dan bulan depan
  const lastDayThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const lastDayNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0);

  // ── 1. DATA PELANGGAN REPEAT ──────────────────────────────
  // Ambil pelanggan >= 2 kunjungan di 30 hari terakhir (aktif)
  const repeatRows = await db.query(`
    SELECT
      p.id,
      COUNT(DISTINCT DATE(t.tanggal)) AS kunjungan,
      DATEDIFF(MAX(t.tanggal), MIN(t.tanggal)) AS rentang_hari,
      MAX(t.tanggal) AS last_trx,
      SUM(t.total) AS total_omzet,
      COUNT(t.id) AS jml_transaksi
    FROM pelanggan p
    JOIN transaksi t ON t.pelanggan_id = p.id AND t.status_bayar = 'lunas'
    WHERE p.cabang_id IN (${cQ(cabangId)})
      AND LOWER(p.nama) NOT LIKE '%walk%'
    GROUP BY p.id
    HAVING kunjungan >= 2
      AND MAX(t.tanggal) >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
  `, cP(cabangId));

  // ── 2. HITUNG PREDIKSI PER HARI ──────────────────────────
  const forecastMap = {}; // { 'YYYY-MM-DD': { repeat: 0, count: 0 } }

  const addDay = (d, n) => {
    const r = new Date(d); r.setDate(r.getDate() + n); return r;
  };
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  for (const p of repeatRows) {
    if (!p.last_trx || p.kunjungan < 2 || p.rentang_hari <= 0) continue;
    const avgSelang  = Math.round(p.rentang_hari / (p.kunjungan - 1));
    if (avgSelang < 1) continue;
    const avgOmzet   = Math.round(p.total_omzet / p.jml_transaksi); // per kunjungan
    const lastTrxDt  = new Date(p.last_trx);
    lastTrxDt.setHours(0, 0, 0, 0);

    // Project next visits mulai dari besok s/d akhir bulan depan
    let nextVisit = addDay(lastTrxDt, avgSelang);
    while (nextVisit <= lastDayNextMonth) {
      if (nextVisit > today) {
        const key = fmtDate(nextVisit);
        if (!forecastMap[key]) forecastMap[key] = { repeat: 0, repeat_count: 0 };
        forecastMap[key].repeat       += avgOmzet;
        forecastMap[key].repeat_count += 1;
      }
      nextVisit = addDay(nextVisit, avgSelang);
    }
  }

  // ── 3. PELANGGAN BARU (trend 30 hari terakhir) ───────────
  // Pelanggan baru: first transaction dalam 30 hari terakhir
  const [newRows] = await db.pool.execute(`
    SELECT
      COUNT(DISTINCT p.id) AS jml_baru,
      AVG(first_t.total)   AS avg_first_omzet
    FROM pelanggan p
    JOIN (
      SELECT t.pelanggan_id, MIN(t.tanggal) AS first_tgl, 
             (SELECT t2.total FROM transaksi t2 WHERE t2.pelanggan_id=t.pelanggan_id AND t2.status_bayar='lunas' ORDER BY t2.tanggal ASC LIMIT 1) AS total
      FROM transaksi t
      WHERE t.status_bayar = 'lunas'
      GROUP BY t.pelanggan_id
    ) first_t ON first_t.pelanggan_id = p.id
    WHERE p.cabang_id IN (${cQ(cabangId)})
      AND LOWER(p.nama) NOT LIKE '%walk%'
      AND DATE(first_t.first_tgl) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
  `, cP(cabangId));

  const jml_baru_30hr   = Number(newRows[0].jml_baru) || 0;
  const avg_first_omzet = Number(newRows[0].avg_first_omzet) || 0;
  const baru_per_hari   = jml_baru_30hr / 30;

  // Tambahkan kontribusi pelanggan baru ke setiap hari forecast
  let checkDate = addDay(today, 1);
  while (checkDate <= lastDayNextMonth) {
    const key = fmtDate(checkDate);
    if (!forecastMap[key]) forecastMap[key] = { repeat: 0, repeat_count: 0 };
    forecastMap[key].baru = Math.round(baru_per_hari * avg_first_omzet);
    checkDate = addDay(checkDate, 1);
  }

  // ── 4. REALISASI BULAN INI S.D. HARI INI ────────────────
  const [realRows] = await db.pool.execute(`
    SELECT
      COALESCE(SUM(t.total), 0) AS realisasi,
      DAY(LAST_DAY(CURDATE()))  AS total_hari_bulan,
      DAY(CURDATE())            AS hari_berjalan
    FROM transaksi t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar = 'lunas'
      AND LOWER(p.nama) NOT LIKE '%walk%'
      AND YEAR(t.tanggal) = YEAR(CURDATE())
      AND MONTH(t.tanggal) = MONTH(CURDATE())
  `, cP(cabangId));

  const realisasi_bulan_ini = Number(realRows[0].realisasi) || 0;
  const total_hari_bulan    = Number(realRows[0].total_hari_bulan) || 30;
  const hari_berjalan       = Number(realRows[0].hari_berjalan) || 1;

  // ── 5. TOTAL FORECAST PER BULAN ──────────────────────────
  const thisMonthEnd = fmtDate(lastDayThisMonth);
  const nextMonthEnd = fmtDate(lastDayNextMonth);

  let forecast_sisa_bulan_ini = 0;
  let forecast_bulan_depan    = 0;
  const detail_per_hari = [];

  for (const [tgl, v] of Object.entries(forecastMap).sort()) {
    const total_hari = (v.repeat || 0) + (v.baru || 0);
    detail_per_hari.push({ tgl, repeat: v.repeat || 0, baru: v.baru || 0, total: total_hari, pelanggan: v.repeat_count || 0 });
    if (tgl <= thisMonthEnd) forecast_sisa_bulan_ini += total_hari;
    else if (tgl <= nextMonthEnd) forecast_bulan_depan += total_hari;
  }

  const forecast_bulan_ini = realisasi_bulan_ini + forecast_sisa_bulan_ini;

  // ── 6. AKTUAL HARIAN 30HR (referensi) ────────────────────
  const [aktualRows] = await db.pool.execute(`
    SELECT
      COALESCE(SUM(t.total), 0)           AS total_30hr,
      COUNT(DISTINCT DATE(t.tanggal))     AS hari_aktif
    FROM transaksi t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar = 'lunas'
      AND LOWER(p.nama) NOT LIKE '%walk%'
      AND DATE(t.tanggal) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
  `, cP(cabangId));

  const aktual_30hr         = Number(aktualRows[0].total_30hr) || 0;
  const hari_aktif_30       = Number(aktualRows[0].hari_aktif) || 1;
  const avg_aktual_per_hari = Math.round(aktual_30hr / hari_aktif_30);

  // Estimasi harian rata-rata dari forecast
  const avg_forecast_per_hari = detail_per_hari.length > 0
    ? Math.round(detail_per_hari.reduce((s, d) => s + d.total, 0) / detail_per_hari.length)
    : 0;

  return {
    per_hari: {
      repeat           : Math.round(detail_per_hari.slice(0, 7).reduce((s,d)=>s+d.repeat,0)/Math.min(7,detail_per_hari.length)||0),
      baru             : Math.round(baru_per_hari * avg_first_omzet),
      total            : avg_forecast_per_hari,
      aktual_historis  : avg_aktual_per_hari,
    },
    bulan_ini: {
      realisasi: realisasi_bulan_ini,
      sisa_hari        : total_hari_bulan - hari_berjalan,
      forecast         : forecast_bulan_ini,
      hari_berjalan,
      total_hari       : total_hari_bulan,
    },
    bulan_depan: {
      forecast         : forecast_bulan_depan,
      total_hari       : lastDayNextMonth.getDate(),
    },
    asumsi: {
      pelanggan_repeat_aktif : repeatRows.length,
      pelanggan_baru_30hr    : jml_baru_30hr,
      avg_first_omzet        : Math.round(avg_first_omzet),
      baru_per_hari          : Math.round(baru_per_hari * 10) / 10,
      aktual_30hr,
      hari_aktif_30,
    },
    detail_per_hari,   // [{tgl, repeat, baru, total, pelanggan}]
  };
}

/**
 * Forecast Performa (omzet + pelanggan baru + pelanggan loyal + pelanggan lepas),
 * metodologi BULANAN berbasis 2 BULAN SEBELUMNYA (N-2, N-1):
 *
 *   1. HISTORIS (bulan sebelum bulan berjalan): ditampilkan APA ADANYA per bulan
 *      kalender (data real). Tiap bulan dipecah:
 *        - pelanggan_baru  : transaksi lunas PERTAMA KALI jatuh di bulan itu.
 *        - pelanggan_loyal : transaksi di bulan itu, tapi first transaction-nya
 *                            di bulan-bulan sebelumnya (udah pernah datang).
 *        - pelanggan_lepas : pelanggan yang AKTIF bulan sebelumnya (N-1) tapi
 *                            TIDAK aktif di bulan ini (N) -- gak balik lagi
 *                            bulan berikutnya, persis-persisan bulan berdekatan.
 *        - pelanggan_total = baru + loyal, omzet_total = omzet_baru + omzet_loyal,
 *          avg_revenue_per_pelanggan = omzet_total / pelanggan_total.
 *   2. BULAN BERJALAN: DUA kartu independen --
 *        - "real"     : realisasi s.d. hari ini (data real, bulan masih jalan).
 *        - "forecast" : estimasi PENUH 1 bulan, dihitung dari 2 bulan sebelum
 *                       bulan berjalan (N-2, N-1): kenaikan/penurunan jumlah
 *                       pelanggan baru & loyal antara N-2 -> N-1 diteruskan
 *                       sebagai estimasi bulan berjalan (N-1 + delta), lalu
 *                       dikali rata-rata revenue/pelanggan (basis N-2 & N-1)
 *                       buat dapetin estimasi omzet.
 *   3. 6 BULAN KE DEPAN: forecast BERANTAI (rolling) -- tiap bulan target
 *      pakai data 2 bulan sebelumnya PERSIS metodologi yang sama; begitu satu
 *      bulan forecast selesai dihitung, hasilnya jadi basis buat bulan
 *      berikutnya (mis. Oktober pakai Agustus[real] & September[forecast
 *      penuh dari langkah 2], November pakai September[forecast] & Oktober
 *      [forecast baru], dst).
 */
async function forecastTahunan(cabangId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bulanKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = (d) => d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  const monthLabelSingkat = (d) => d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' });
  const round0 = (n) => Math.round(Number(n) || 0);
  const prevMonthKey = (mk) => {
    const [y, m] = mk.split('-').map(Number);
    const d = new Date(y, m - 2, 1); // m sudah 1-indexed; bulan sebelumnya = (y, m-2, 1) di Date yg 0-indexed
    return bulanKey(d);
  };

  // ── 0. Cari tanggal cabang buka (transaksi lunas pertama, exclude Walk-in) ──
  const [bukaRows] = await db.pool.execute(`
    SELECT MIN(t.tanggal) AS pertama
    FROM transaksi t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar = 'lunas' AND LOWER(p.nama) NOT LIKE '%walk%'
  `, cP(cabangId));
  const tglBukaRaw = bukaRows[0] && bukaRows[0].pertama ? new Date(bukaRows[0].pertama) : null;

  if (!tglBukaRaw) {
    return {
      cabang_buka: null,
      bulan_acuan: bulanKey(today),
      historis: [],
      bulan_berjalan: null,
      forecast_6bulan: [],
      asumsi: { basis_cukup: false },
    };
  }
  const tglBuka = new Date(tglBukaRaw);
  tglBuka.setHours(0, 0, 0, 0);

  // ── 1. Ambil SEMUA transaksi lunas (per pelanggan per tanggal) + tanggal transaksi
  //      pertama pelanggan itu (utk klasifikasi baru/loyal) ──
  const rows = await db.query(`
    SELECT t.pelanggan_id, DATE(t.tanggal) AS tgl, t.total, DATE(fp.first_tgl) AS first_tgl
    FROM transaksi t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN (
      SELECT pelanggan_id, MIN(tanggal) AS first_tgl
      FROM transaksi WHERE status_bayar = 'lunas'
      GROUP BY pelanggan_id
    ) fp ON fp.pelanggan_id = t.pelanggan_id
    WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar = 'lunas' AND LOWER(p.nama) NOT LIKE '%walk%'
  `, cP(cabangId));

  // ── 2. Bucket per BULAN kalender ──
  const monthBuckets = new Map(); // 'YYYY-MM' -> { baruSet, loyalSet, omzetBaru, omzetLoyal }
  const emptyBucket = () => ({ baruSet: new Set(), loyalSet: new Set(), omzetBaru: 0, omzetLoyal: 0 });

  // Klasifikasi baru/loyal dilakukan per PELANGGAN per BULAN (bukan per
  // transaksi): baru = bulan ini adalah bulan pertama kalinya dia pernah
  // transaksi (bulan dari first_tgl == bulan transaksi ini); loyal = dia udah
  // pernah transaksi di bulan-bulan sebelumnya. Dengan ini, mau dia datang 1x
  // atau berkali-kali dalam bulan yang sama, tetap konsisten masuk SATU
  // kategori aja (gak dobel kehitung di baru & loyal sekaligus).
  rows.forEach((r) => {
    const tgl = new Date(r.tgl); tgl.setHours(0, 0, 0, 0);
    const firstTgl = new Date(r.first_tgl); firstTgl.setHours(0, 0, 0, 0);
    const total = Number(r.total) || 0;
    const mk = bulanKey(tgl);
    const isBaru = mk === bulanKey(firstTgl);
    if (!monthBuckets.has(mk)) monthBuckets.set(mk, emptyBucket());
    const mb = monthBuckets.get(mk);
    if (isBaru) { mb.baruSet.add(r.pelanggan_id); mb.omzetBaru += total; }
    else { mb.loyalSet.add(r.pelanggan_id); mb.omzetLoyal += total; }
  });

  const activeIds = (mk) => {
    const b = monthBuckets.get(mk);
    if (!b) return new Set();
    return new Set([...b.baruSet, ...b.loyalSet]);
  };
  // Pelanggan lepas bulan mk = aktif di (mk-1) tapi TIDAK aktif di mk.
  const lepasCount = (mk) => {
    const prevActive = activeIds(prevMonthKey(mk));
    if (prevActive.size === 0) return 0;
    const curActive = activeIds(mk);
    let cnt = 0;
    prevActive.forEach((id) => { if (!curActive.has(id)) cnt++; });
    return cnt;
  };

  const cardFromBucket = (md, mk) => {
    const b = monthBuckets.get(mk) || emptyBucket();
    const jmlBaru = b.baruSet.size, jmlLoyal = b.loyalSet.size;
    const jmlTotal = jmlBaru + jmlLoyal;
    const omzetTotal = b.omzetBaru + b.omzetLoyal;
    const avgBaru = jmlBaru > 0 ? round0(b.omzetBaru / jmlBaru) : 0;
    const avgLoyal = jmlLoyal > 0 ? round0(b.omzetLoyal / jmlLoyal) : 0;
    return {
      bulan: md.bulan, label: md.label, label_singkat: md.label_singkat,
      pelanggan_baru: jmlBaru, omzet_baru: round0(b.omzetBaru), avg_revenue_baru: avgBaru,
      pelanggan_loyal: jmlLoyal, omzet_loyal: round0(b.omzetLoyal), avg_revenue_loyal: avgLoyal,
      pelanggan_lepas: lepasCount(mk),
      pelanggan_total: jmlTotal, omzet_total: round0(omzetTotal),
      avg_revenue_per_pelanggan: jmlTotal > 0 ? round0(omzetTotal / jmlTotal) : 0,
    };
  };

  // ── 3. Daftar bulan kalender: cabang buka s.d. bulan berjalan ──
  const bulanBerjalanKey = bulanKey(today);
  const monthDefs = [];
  {
    let mcursor = new Date(tglBuka.getFullYear(), tglBuka.getMonth(), 1);
    const stop = new Date(today.getFullYear(), today.getMonth(), 1);
    while (bulanKey(mcursor) <= bulanKey(stop)) {
      monthDefs.push({
        bulan: bulanKey(mcursor), date: new Date(mcursor),
        label: monthLabel(mcursor), label_singkat: monthLabelSingkat(mcursor),
        lastDay: new Date(mcursor.getFullYear(), mcursor.getMonth() + 1, 0).getDate(),
      });
      mcursor = new Date(mcursor.getFullYear(), mcursor.getMonth() + 1, 1);
    }
  }

  // ── 4. Histori (bulan < bulan berjalan): data real apa adanya ──
  const bulanHistorisDefs = monthDefs.filter((md) => md.bulan < bulanBerjalanKey);
  const historis = bulanHistorisDefs.map((md) => ({ ...cardFromBucket(md, md.bulan), tipe: 'real' }));

  // `resolved`: peta bulan -> ringkasan {pelanggan_baru, omzet_baru, pelanggan_loyal,
  // omzet_loyal, pelanggan_lepas, ...} dipakai sbg basis N-2/N-1 buat forecast
  // berantai. Bulan < bulan berjalan pakai data REAL; bulan berjalan & seterusnya
  // diisi hasil forecast (lihat bawah).
  const resolved = new Map();
  bulanHistorisDefs.forEach((md) => resolved.set(md.bulan, cardFromBucket(md, md.bulan)));

  // ── 5. Fungsi generik: forecast 1 bulan penuh dari basis 2 bulan sebelumnya ──
  function forecastFromBasis(basisN2, basisN1) {
    const deltaBaru = basisN1.pelanggan_baru - basisN2.pelanggan_baru;
    const deltaLoyal = basisN1.pelanggan_loyal - basisN2.pelanggan_loyal;
    const deltaLepas = basisN1.pelanggan_lepas - basisN2.pelanggan_lepas;
    const estBaru = Math.max(0, round0(basisN1.pelanggan_baru + deltaBaru));
    const estLoyal = Math.max(0, round0(basisN1.pelanggan_loyal + deltaLoyal));
    const estLepas = Math.max(0, round0(basisN1.pelanggan_lepas + deltaLepas));

    const sumBaruJml = basisN2.pelanggan_baru + basisN1.pelanggan_baru;
    const sumBaruOmzet = basisN2.omzet_baru + basisN1.omzet_baru;
    const sumLoyalJml = basisN2.pelanggan_loyal + basisN1.pelanggan_loyal;
    const sumLoyalOmzet = basisN2.omzet_loyal + basisN1.omzet_loyal;
    const avgRevBaru = sumBaruJml > 0 ? sumBaruOmzet / sumBaruJml : 0;
    const avgRevLoyal = sumLoyalJml > 0 ? sumLoyalOmzet / sumLoyalJml : 0;

    const omzetBaru = round0(estBaru * avgRevBaru);
    const omzetLoyal = round0(estLoyal * avgRevLoyal);
    const jmlTotal = estBaru + estLoyal;
    const omzetTotal = omzetBaru + omzetLoyal;
    return {
      pelanggan_baru: estBaru, omzet_baru: omzetBaru, avg_revenue_baru: round0(avgRevBaru),
      pelanggan_loyal: estLoyal, omzet_loyal: omzetLoyal, avg_revenue_loyal: round0(avgRevLoyal),
      pelanggan_lepas: estLepas,
      pelanggan_total: jmlTotal, omzet_total: omzetTotal,
      avg_revenue_per_pelanggan: jmlTotal > 0 ? round0(omzetTotal / jmlTotal) : 0,
    };
  }
  const ZERO_BASIS = { pelanggan_baru: 0, omzet_baru: 0, pelanggan_loyal: 0, omzet_loyal: 0, pelanggan_lepas: 0 };
  const basisOf = (mk) => resolved.get(mk) || ZERO_BASIS;

  // ── 6. Bulan berjalan: kartu "real" (s.d. hari ini) + kartu "forecast" ──
  //      Forecast bulan berjalan pakai basis MINGGUAN: ambil jumlah pelanggan
  //      (baru & loyal, dihitung dari kunjungan) per minggu dari 6 MINGGU PENUH
  //      terakhir (minggu berjalan yg belum penuh gak diikutkan), cari rata-rata
  //      kenaikan per minggu, lalu proyeksikan kenaikan itu buat sisa minggu s.d.
  //      akhir bulan dan ditambahkan ke jumlah real s.d. hari ini.
  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const mdBerjalan = monthDefs[monthDefs.length - 1];
  const hariBerjalan = today.getDate();
  const totalHariBulanBerjalan = mdBerjalan.lastDay;
  const sisaHari = Math.max(0, totalHariBulanBerjalan - hariBerjalan);
  const realCard = { ...cardFromBucket(mdBerjalan, bulanBerjalanKey), tipe: 'berjalan_real' };

  // Basis N-2/N-1 (bulanan) -- tetap dipakai buat rata-rata revenue/pelanggan
  // fallback & sebagai konteks di "asumsi", meski forecast jumlah pelanggan
  // bulan berjalan sekarang pakai tren mingguan (bukan lagi delta bulanan ini).
  const mkN1 = prevMonthKey(bulanBerjalanKey);
  const mkN2 = prevMonthKey(mkN1);
  const basisN1 = basisOf(mkN1);
  const basisN2 = basisOf(mkN2);
  const basisCukup = mkN1 >= bulanKey(tglBuka) && mkN2 >= bulanKey(tglBuka) && (monthBuckets.has(mkN1) || monthBuckets.has(mkN2));

  // -- Tren mingguan: bucket kunjungan pelanggan per minggu (Senin-Minggu), 6
  //    minggu penuh terakhir sebelum minggu berjalan ini --
  const mondayOf = (d) => {
    const x = new Date(d);
    const day = x.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const mingguKey = (d) => {
    const m = mondayOf(d);
    return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
  };
  const JML_MINGGU_TREN = 6;
  const currentWeekStart = mondayOf(today);
  const weekStarts = []; // 6 minggu PENUH terakhir, urut lama -> baru
  for (let i = JML_MINGGU_TREN; i >= 1; i--) {
    const ws = new Date(currentWeekStart);
    ws.setDate(ws.getDate() - 7 * i);
    weekStarts.push(ws);
  }
  const weekBuckets = new Map(); // mingguKey -> { baruSet, loyalSet, omzetBaru, omzetLoyal }
  weekStarts.forEach((ws) => weekBuckets.set(mingguKey(ws), { baruSet: new Set(), loyalSet: new Set(), omzetBaru: 0, omzetLoyal: 0 }));
  const weekRangeStart = weekStarts[0];
  const weekRangeEnd = currentWeekStart; // eksklusif -- minggu berjalan gak diikutkan
  rows.forEach((r) => {
    const tgl = new Date(r.tgl); tgl.setHours(0, 0, 0, 0);
    if (tgl < weekRangeStart || tgl >= weekRangeEnd) return;
    const firstTgl = new Date(r.first_tgl); firstTgl.setHours(0, 0, 0, 0);
    const wk = mingguKey(tgl);
    const wb = weekBuckets.get(wk);
    if (!wb) return;
    const total = Number(r.total) || 0;
    // Sama kayak bucket bulanan: baru/loyal ditentukan per pelanggan per
    // minggu (minggu dari first_tgl == minggu ini), bukan per transaksi.
    if (wk === mingguKey(firstTgl)) { wb.baruSet.add(r.pelanggan_id); wb.omzetBaru += total; }
    else { wb.loyalSet.add(r.pelanggan_id); wb.omzetLoyal += total; }
  });
  const weeklySeries = weekStarts.map((ws) => {
    const wb = weekBuckets.get(mingguKey(ws));
    const baru = wb.baruSet.size, loyal = wb.loyalSet.size;
    return {
      minggu_mulai: mingguKey(ws), pelanggan_baru: baru, pelanggan_loyal: loyal, pelanggan_total: baru + loyal,
      omzet_baru: round0(wb.omzetBaru), omzet_loyal: round0(wb.omzetLoyal), omzet_total: round0(wb.omzetBaru + wb.omzetLoyal),
    };
  });
  const avgDeltaOf = (arr) => {
    if (arr.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < arr.length; i++) sum += (arr[i] - arr[i - 1]);
    return sum / (arr.length - 1);
  };
  const avgOf = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const avgDeltaBaru = avgDeltaOf(weeklySeries.map((w) => w.pelanggan_baru));
  const avgDeltaLoyal = avgDeltaOf(weeklySeries.map((w) => w.pelanggan_loyal));
  // Laundry sifatnya mingguan (orang nyuci ~1x/minggu), jadi run-rate omzet
  // dipakai buat proyeksi sisa bulan, BUKAN dirata-rata per hari.
  const avgOmzetMingguanBaru = avgOf(weeklySeries.map((w) => w.omzet_baru));
  const avgOmzetMingguanLoyal = avgOf(weeklySeries.map((w) => w.omzet_loyal));
  const mingguDataCukup = weeklySeries.filter((w) => w.pelanggan_total > 0).length >= 2;
  const sisaMinggu = sisaHari / 7;

  // Kenaikan JUMLAH PELANGGAN sampai akhir bulan = rata-rata kenaikan/minggu x
  // sisa minggu, gak pernah bikin estimasi turun di bawah angka real yg udah pasti.
  const estBaruTotal = mingguDataCukup
    ? Math.max(realCard.pelanggan_baru, round0(realCard.pelanggan_baru + avgDeltaBaru * sisaMinggu))
    : realCard.pelanggan_baru;
  const estLoyalTotal = mingguDataCukup
    ? Math.max(realCard.pelanggan_loyal, round0(realCard.pelanggan_loyal + avgDeltaLoyal * sisaMinggu))
    : realCard.pelanggan_loyal;

  // Rata-rata revenue/pelanggan (fallback, dipakai kalau data mingguan blm cukup):
  // pakai data real bulan berjalan; kalau belum ada data, fallback ke bulan
  // sebelumnya (N-1, lalu N-2).
  const avgRevBaru = realCard.pelanggan_baru > 0 ? realCard.avg_revenue_baru
    : (basisN1.pelanggan_baru > 0 ? round0(basisN1.omzet_baru / basisN1.pelanggan_baru)
      : (basisN2.pelanggan_baru > 0 ? round0(basisN2.omzet_baru / basisN2.pelanggan_baru) : 0));
  const avgRevLoyal = realCard.pelanggan_loyal > 0 ? realCard.avg_revenue_loyal
    : (basisN1.pelanggan_loyal > 0 ? round0(basisN1.omzet_loyal / basisN1.pelanggan_loyal)
      : (basisN2.pelanggan_loyal > 0 ? round0(basisN2.omzet_loyal / basisN2.pelanggan_loyal) : 0));

  // Proyeksi OMZET sisa bulan = omzet real s.d. hari ini + run-rate omzet
  // mingguan (rata-rata 6 minggu terakhir) x sisa minggu -- karena pelanggan
  // yang udah tercatat bulan ini TETAP bakal transaksi lagi di sisa hari,
  // bukan cuma pelanggan tambahan doang yang nyumbang omzet.
  const omzetBaruForecast = mingguDataCukup
    ? round0(realCard.omzet_baru + avgOmzetMingguanBaru * sisaMinggu)
    : round0(estBaruTotal * avgRevBaru);
  const omzetLoyalForecast = mingguDataCukup
    ? round0(realCard.omzet_loyal + avgOmzetMingguanLoyal * sisaMinggu)
    : round0(estLoyalTotal * avgRevLoyal);
  const jmlTotalForecast = estBaruTotal + estLoyalTotal;
  const omzetTotalForecast = omzetBaruForecast + omzetLoyalForecast;
  const forecastFull = {
    pelanggan_baru: estBaruTotal, omzet_baru: omzetBaruForecast, avg_revenue_baru: estBaruTotal > 0 ? round0(omzetBaruForecast / estBaruTotal) : 0,
    pelanggan_loyal: estLoyalTotal, omzet_loyal: omzetLoyalForecast, avg_revenue_loyal: estLoyalTotal > 0 ? round0(omzetLoyalForecast / estLoyalTotal) : 0,
    pelanggan_lepas: realCard.pelanggan_lepas, // gak diproyeksikan, ikut angka real
    pelanggan_total: jmlTotalForecast, omzet_total: omzetTotalForecast,
    avg_revenue_per_pelanggan: jmlTotalForecast > 0 ? round0(omzetTotalForecast / jmlTotalForecast) : 0,
  };
  const forecastCard = { bulan: mdBerjalan.bulan, label: mdBerjalan.label, label_singkat: mdBerjalan.label_singkat, tipe: 'forecast', ...forecastFull };
  resolved.set(bulanBerjalanKey, forecastFull); // basis buat forecast 6 bulan ke depan (metode bulanan, gak berubah)

  const bulanBerjalanOut = {
    bulan: mdBerjalan.bulan, label: mdBerjalan.label, label_singkat: mdBerjalan.label_singkat,
    hari_berjalan: hariBerjalan, total_hari: totalHariBulanBerjalan, sisa_hari: sisaHari,
    real: realCard,
    forecast: forecastCard,
    rata_rata_harian: {
      revenue_per_hari: hariBerjalan > 0 ? round0(realCard.omzet_total / hariBerjalan) : 0,
      pelanggan_lepas_per_hari: hariBerjalan > 0 ? round1(realCard.pelanggan_lepas / hariBerjalan) : 0,
    },
    tren_mingguan: {
      minggu: weeklySeries,
      rata_rata_kenaikan_per_minggu: { baru: round1(avgDeltaBaru), loyal: round1(avgDeltaLoyal), total: round1(avgDeltaBaru + avgDeltaLoyal) },
      rata_rata_omzet_per_minggu: { baru: round0(avgOmzetMingguanBaru), loyal: round0(avgOmzetMingguanLoyal), total: round0(avgOmzetMingguanBaru + avgOmzetMingguanLoyal) },
      sisa_minggu: round1(sisaMinggu),
      data_cukup: mingguDataCukup,
    },
  };

  // ── 7. 6 bulan ke depan: forecast BERANTAI, tiap bulan pakai basis 2 bulan sebelumnya ──
  const forecast6 = [];
  for (let i = 1; i <= 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const mk = bulanKey(d);
    const p1 = prevMonthKey(mk);
    const p2 = prevMonthKey(p1);
    const f = forecastFromBasis(basisOf(p2), basisOf(p1));
    const card = { bulan: mk, label: monthLabel(d), label_singkat: monthLabelSingkat(d), tipe: 'forecast', ...f };
    forecast6.push(card);
    resolved.set(mk, f);
  }

  return {
    cabang_buka: `${tglBuka.getFullYear()}-${String(tglBuka.getMonth() + 1).padStart(2, '0')}-${String(tglBuka.getDate()).padStart(2, '0')}`,
    bulan_acuan: bulanBerjalanKey,
    historis,
    bulan_berjalan: bulanBerjalanOut,
    forecast_6bulan: forecast6,
    asumsi: {
      metode_bulan_berjalan: 'Tren MINGGUAN (laundry siklusnya mingguan, bukan harian): jumlah pelanggan & omzet per minggu dari 6 minggu penuh terakhir. Jumlah pelanggan = real s.d. hari ini + (rata-rata kenaikan pelanggan/minggu x sisa minggu). Omzet = real s.d. hari ini + (rata-rata omzet/minggu x sisa minggu) -- karena pelanggan yang udah transaksi bulan ini tetap bakal balik lagi di sisa hari, bukan cuma dihitung dari pelanggan tambahan doang.',
      metode_6bulan_kedepan: 'Estimasi dari kenaikan/penurunan jumlah pelanggan 2 bulan sebelumnya (N-2 -> N-1), dikalikan rata-rata revenue/pelanggan dari basis yang sama, berantai (rolling) bulan demi bulan.',
      basis_cukup: basisCukup,
      basis_n2: { bulan: mkN2, pelanggan_baru: basisN2.pelanggan_baru, pelanggan_loyal: basisN2.pelanggan_loyal, pelanggan_lepas: basisN2.pelanggan_lepas },
      basis_n1: { bulan: mkN1, pelanggan_baru: basisN1.pelanggan_baru, pelanggan_loyal: basisN1.pelanggan_loyal, pelanggan_lepas: basisN1.pelanggan_lepas },
      avg_revenue_per_pelanggan_baru: forecastFull.avg_revenue_baru,
      avg_revenue_per_pelanggan_loyal: forecastFull.avg_revenue_loyal,
    },
  };
}




module.exports = { findByTelepon, findById, create, tambahPointFrekuensi, kurangiPoint, catatLogin, search, listManager, countManager, update, teleponDipakai, distribusiFrekuensi, forecastOmzet, forecastTahunan };
