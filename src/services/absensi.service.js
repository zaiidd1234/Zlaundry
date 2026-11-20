/**
 * src/services/absensi.service.js
 * =============================================================================
 * Perubahan #27 -- Absensi kasir + benefit (lipat / drop-off / antar jemput).
 *
 * ABSENSI
 *  - 1 baris tabel `absensi` = 1 sesi kerja (masuk -> pulang). Boleh lebih dari
 *    1 sesi per hari.
 *  - Absen masuk & pulang WAJIB di radius outlet (cabang.radius_absen_m,
 *    default 50 m dari cabang.latitude/longitude). Jarak dihitung di SERVER.
 *  - Masuk  : centang "Lembur (gantikan shift orang)"  -> lembur_ganti_shift.
 *  - Pulang : centang "Pulang terlambat karena lembur" -> pulang_lembur.
 *  - Lupa absen pulang -> kasir ajukan koreksi (jam pulang + alasan), berlaku
 *    setelah disetujui manager/owner.
 *  - Gerbang: role kasir hanya bisa memakai menu lain selama punya sesi
 *    TERBUKA hari ini (lihat middleware/gerbangAbsen.js). Manager/owner bebas.
 *
 * BENEFIT (dihitung dari riwayat status, order LUNAS saja)
 *  - Lipat     50% subtotal item kategori 'lipat'. Mulai Lipat & Selesai
 *              Lipat beda orang -> 25% + 25%; sama orang -> 50%.
 *  - Drop-off  50% subtotal item kategori 'drop_off', untuk yang menjalankan
 *              mesin (Mulai Cuci / Mulai Kering). Beda orang -> 25% + 25%;
 *              sama orang / hanya 1 mesin -> 50%.
 *  - Antar     80% subtotal item 'antar' + 'antar_jemput', untuk yang klik
 *              Proses Antar (hanya dia yang boleh Selesai Antar).
 *  - Tanggal benefit: Selesai Lipat (lipat), Mulai Cuci/Kering pertama
 *    (drop-off), Proses Antar (antar).
 * =============================================================================
 */

const db = require('../config/database');
const { now, today } = require('../helpers/date');
const { badRequest, conflict, forbidden, notFound } = require('../helpers/errors');

const RADIUS_DEFAULT_M = 50;
// Sesi dianggap masih "aktif" sampai 16 jam sejak absen masuk (shift lewat
// tengah malam tetap aman). Lebih dari itu tanpa absen pulang = lupa pulang.
const MAKS_SESI_JAM = 16;
function batasSesi() {
  const { format } = require('../helpers/date');
  return format(new Date(Date.now() - MAKS_SESI_JAM * 3600 * 1000), 'YYYY-MM-DD HH:mm:ss');
}
const PERSEN = { lipat: 0.5, drop_off: 0.5, antar: 0.8 };

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

/** Jarak 2 titik (meter), rumus haversine. */
function jarakMeter(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function angka(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function cabangAbsen(cabangId) {
  const c = await db.queryOne('SELECT * FROM cabang WHERE id = ? LIMIT 1', [cabangId]);
  if (!c) throw notFound('Cabang tidak ditemukan');
  return {
    id: c.id, kode: c.kode, nama: c.nama,
    latitude: angka(c.latitude), longitude: angka(c.longitude),
    radius_m: angka(c.radius_absen_m) || RADIUS_DEFAULT_M,
    absensi_aktif: Number(c.absensi_aktif || 0), // Perubahan #29b: saklar per cabang
  };
}

/** Gerbang menu kasir: true kalau absensi cabang nonaktif ATAU punya sesi aktif. */
async function bolehAkses(user) {
  const r = await db.queryOne(
    `SELECT c.absensi_aktif,
            (SELECT a.id FROM absensi a WHERE a.karyawan_id = ? AND a.cabang_id = c.id AND a.jam_pulang IS NULL AND a.jam_masuk >= ?
              ORDER BY a.id DESC LIMIT 1) AS sesi_id
       FROM cabang c WHERE c.id = ?`, [user.id, batasSesi(), user.cabang_id]);
  if (!r) return false;
  return !Number(r.absensi_aktif) || !!r.sesi_id;
}
function wajibAktif(cab) {
  if (!cab.absensi_aktif) throw conflict('Absensi tidak aktif di cabang ini.');
}

/** Validasi lokasi kasir terhadap outlet -> { lat, lng, jarak } (lempar error kalau di luar radius). */
async function cekLokasi(cabangId, input) {
  const lat = angka(input && input.lat);
  const lng = angka(input && input.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest('Lokasi HP belum terbaca. Nyalakan GPS / izinkan akses lokasi, lalu coba lagi.');
  }
  const cab = await cabangAbsen(cabangId);
  if (cab.latitude === null || cab.longitude === null) {
    // titik outlet belum diatur -> absen tetap tercatat (jarak kosong)
    return { lat, lng, jarak: null, cabang: cab };
  }
  const jarak = Math.round(jarakMeter(lat, lng, cab.latitude, cab.longitude));
  if (jarak > cab.radius_m) {
    const akurasi = angka(input.akurasi);
    const info = akurasi ? ` (akurasi GPS ±${Math.round(akurasi)} m)` : '';
    throw forbidden(`Kamu berada ${jarak} m dari outlet${info}. Absen hanya bisa dalam radius ${cab.radius_m} m dari ${cab.nama}.`);
  }
  return { lat, lng, jarak, cabang: cab };
}

// ---------------------------------------------------------------------------
// sesi
// ---------------------------------------------------------------------------

const KOLOM = `a.id, a.karyawan_id, a.cabang_id, a.tanggal, a.jam_masuk, a.jarak_masuk_m,
  a.lembur_ganti_shift, a.jam_pulang, a.jarak_pulang_m, a.pulang_lembur, a.pulang_dikoreksi, a.pulang_otomatis,
  a.terakhir_di_outlet_at, a.luar_radius_sejak`;

/** Sesi terbuka (masuk < 16 jam lalu, belum pulang) -- dipakai gerbang menu. */
async function sesiAktif(karyawanId, cabangId) {
  return db.queryOne(
    `SELECT ${KOLOM} FROM absensi a
      WHERE a.karyawan_id = ? AND a.cabang_id = ? AND a.jam_pulang IS NULL AND a.jam_masuk >= ?
      ORDER BY a.id DESC LIMIT 1`,
    [karyawanId, cabangId, batasSesi()],
  );
}

/** Sesi lama (masuk > 16 jam lalu) yang belum absen pulang. */
async function sesiLupaPulang(karyawanId, cabangId) {
  return db.query(
    `SELECT ${KOLOM},
            (SELECT k.status FROM absensi_koreksi k WHERE k.absensi_id = a.id ORDER BY k.id DESC LIMIT 1) AS koreksi_status
       FROM absensi a
      WHERE a.karyawan_id = ? AND a.cabang_id = ? AND a.jam_pulang IS NULL AND a.jam_masuk < ?
      ORDER BY a.id DESC LIMIT 10`,
    [karyawanId, cabangId, batasSesi()],
  );
}

async function status(user) {
  const cab = await cabangAbsen(user.cabang_id);
  const wajib = user.role === 'kasir' && !!cab.absensi_aktif;
  const aktif = await sesiAktif(user.id, user.cabang_id);
  const lupa = await sesiLupaPulang(user.id, user.cabang_id);
  return {
    wajib_absen: wajib,
    sudah_masuk: !!aktif,
    boleh_akses: !wajib || !!aktif,
    sesi: aktif,
    lupa_pulang: lupa,
    absensi_aktif: cab.absensi_aktif,
    interval_lokasi_detik: INTERVAL_LOKASI_DETIK,
    cabang: { id: cab.id, kode: cab.kode, nama: cab.nama, radius_m: cab.radius_m, lokasi_diatur: cab.latitude !== null },
  };
}

async function masuk(user, input = {}) {
  wajibAktif(await cabangAbsen(user.cabang_id));
  const lokasi = await cekLokasi(user.cabang_id, input);
  return db.transaction(async (conn) => {
    // kunci baris karyawan supaya klik ganda tidak membuat 2 sesi
    await conn.execute('SELECT id FROM karyawan WHERE id = ? FOR UPDATE', [user.id]);
    const [ada] = await conn.execute(
      `SELECT id FROM absensi WHERE karyawan_id = ? AND cabang_id = ? AND jam_pulang IS NULL AND jam_masuk >= ? LIMIT 1`,
      [user.id, user.cabang_id, batasSesi()],
    );
    if (ada.length) throw conflict('Kamu sudah absen masuk. Absen pulang dulu sebelum masuk lagi.');
    const waktu = now();
    const [r] = await conn.execute(
      `INSERT INTO absensi (karyawan_id, cabang_id, tanggal, jam_masuk, lat_masuk, lng_masuk, jarak_masuk_m, lembur_ganti_shift, perangkat,
                            terakhir_di_outlet_at, lokasi_terakhir_at, jarak_terakhir_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.id, user.cabang_id, waktu.slice(0, 10), waktu, lokasi.lat, lokasi.lng, lokasi.jarak,
        input.lembur_ganti_shift ? 1 : 0, String(input.perangkat || '').slice(0, 255) || null, waktu, waktu, lokasi.jarak],
    );
    return { id: r.insertId, jam_masuk: waktu, jarak_m: lokasi.jarak, lembur_ganti_shift: input.lembur_ganti_shift ? 1 : 0 };
  });
}

async function pulang(user, input = {}) {
  wajibAktif(await cabangAbsen(user.cabang_id));
  const lokasi = await cekLokasi(user.cabang_id, input);
  const aktif = await sesiAktif(user.id, user.cabang_id);
  if (!aktif) throw conflict('Belum ada absen masuk yang aktif.');
  const waktu = now();
  const [r] = await db.pool.execute(
    `UPDATE absensi SET jam_pulang = ?, lat_pulang = ?, lng_pulang = ?, jarak_pulang_m = ?, pulang_lembur = ?
      WHERE id = ? AND jam_pulang IS NULL`,
    [waktu, lokasi.lat, lokasi.lng, lokasi.jarak, input.pulang_lembur ? 1 : 0, aktif.id],
  );
  if (!r.affectedRows) throw conflict('Sesi ini sudah absen pulang.');
  return { id: aktif.id, jam_masuk: aktif.jam_masuk, jam_pulang: waktu, jarak_m: lokasi.jarak, pulang_lembur: input.pulang_lembur ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Perubahan #30: pulang otomatis
// ---------------------------------------------------------------------------
const INTERVAL_LOKASI_DETIK = 300;       // HP kirim lokasi tiap 5 menit selama app terbuka
const TOLERANSI_SETELAH_JADWAL_MENIT = 15;
const TUTUP_TANPA_KABAR_JAM = 2;         // server tutup sendiri 2 jam setelah jadwal habis tanpa kabar
const JAUH_PASTI_M = 500;                // di luar sejauh ini = langsung dianggap pulang
const msW = (s) => new Date(String(s).replace(' ', 'T') + '+07:00').getTime();
function teksW(t) {
  const { format } = require('../helpers/date');
  return format(new Date(t), 'YYYY-MM-DD HH:mm:ss');
}

/**
 * Jam pulang otomatis = maks(terakhir terlihat di outlet, min(akhir jadwal,
 * pertama terlihat di luar)). Tanpa jadwal -> terakhir terlihat di outlet.
 * Tidak pernah melebihi sekarang / kurang dari jam masuk.
 */
function hitungJamPulangOtomatis(sesi, akhirJadwal, nowMs) {
  const terlihat = msW(sesi.terakhir_di_outlet_at || sesi.jam_masuk);
  let t = terlihat;
  if (akhirJadwal) {
    const luar = sesi.luar_radius_sejak ? msW(sesi.luar_radius_sejak) : akhirJadwal;
    t = Math.max(terlihat, Math.min(akhirJadwal, luar));
  }
  return Math.max(msW(sesi.jam_masuk), Math.min(t, nowMs));
}

async function tutupOtomatis(sesi, jamMs, lokasi = {}) {
  const [r] = await db.pool.execute(
    `UPDATE absensi SET jam_pulang = ?, pulang_otomatis = 1, pulang_lembur = 0,
            lat_pulang = ?, lng_pulang = ?, jarak_pulang_m = ?
      WHERE id = ? AND jam_pulang IS NULL`,
    [teksW(jamMs), lokasi.lat ?? null, lokasi.lng ?? null, lokasi.jarak ?? null, sesi.id]);
  return r.affectedRows > 0;
}

/** POST /absensi/lokasi -- laporan lokasi berkala dari app kasir. */
async function laporLokasi(user, input = {}) {
  const cab = await cabangAbsen(user.cabang_id);
  if (user.role !== 'kasir' || !cab.absensi_aktif) return { dicatat: false };
  const sesi = await sesiAktif(user.id, user.cabang_id);
  if (!sesi) return { dicatat: false, sesi_aktif: false };
  const lat = angka(input.lat); const lng = angka(input.lng);
  if (lat === null || lng === null || cab.latitude === null) return { dicatat: false, sesi_aktif: true };
  const akurasi = Math.min(Math.max(angka(input.akurasi) || 0, 0), 100);
  const jarak = Math.round(jarakMeter(lat, lng, cab.latitude, cab.longitude));
  const waktu = now(); const nowMs = msW(waktu);
  const diDalam = jarak <= cab.radius_m;
  const pastiLuar = jarak - akurasi > cab.radius_m; // di luar walau dikurangi akurasi GPS
  if (diDalam || !pastiLuar) {
    // di dalam (atau ragu karena akurasi) -> anggap masih di outlet
    await db.pool.execute(
      `UPDATE absensi SET lokasi_terakhir_at = ?, jarak_terakhir_m = ?, terakhir_di_outlet_at = IF(?, ?, terakhir_di_outlet_at),
              luar_radius_sejak = NULL WHERE id = ? AND jam_pulang IS NULL`,
      [waktu, jarak, diDalam ? 1 : 0, waktu, sesi.id]);
    return { dicatat: true, sesi_aktif: true, di_outlet: diDalam, jarak_m: jarak };
  }
  // pasti di luar radius
  const luarSejakSebelumnya = sesi.luar_radius_sejak;
  await db.pool.execute(
    `UPDATE absensi SET lokasi_terakhir_at = ?, jarak_terakhir_m = ?, luar_radius_sejak = IFNULL(luar_radius_sejak, ?)
      WHERE id = ? AND jam_pulang IS NULL`, [waktu, jarak, waktu, sesi.id]);
  const s2 = { ...sesi, luar_radius_sejak: luarSejakSebelumnya || waktu };
  const akhir = await require('./shift.service').akhirJadwalSesi(sesi);
  const lewatJadwal = akhir === null || nowMs >= akhir + TOLERANSI_SETELAH_JADWAL_MENIT * 60000;
  // konfirmasi: sudah 2x terbaca di luar, atau sudah jauh sekali
  const yakin = !!luarSejakSebelumnya || jarak >= JAUH_PASTI_M;
  if (lewatJadwal && yakin) {
    const jam = hitungJamPulangOtomatis(s2, akhir, nowMs);
    const ok = await tutupOtomatis(sesi, jam, { lat, lng, jarak });
    if (ok) return { dicatat: true, sesi_aktif: false, pulang_otomatis: true, jam_pulang: teksW(jam), jarak_m: jarak };
  }
  return { dicatat: true, sesi_aktif: true, di_outlet: false, jarak_m: jarak, menunggu_konfirmasi: !yakin, dalam_jadwal: !lewatJadwal };
}

/**
 * Pengecekan berkala server (tiap 10 menit, aman di banyak proses): sesi
 * terbuka di cabang absensi aktif yang sudah > 2 jam lewat dari akhir jadwal
 * (atau > 2 jam sejak terakhir terlihat di outlet bila tanpa jadwal) tanpa
 * kabar lokasi di outlet -> ditutup otomatis.
 */
async function tutupSesiTerlantar() {
  const rows = await db.query(
    `SELECT a.* FROM absensi a JOIN cabang c ON c.id = a.cabang_id
      WHERE a.jam_pulang IS NULL AND c.absensi_aktif = 1 AND a.jam_masuk >= NOW() - INTERVAL 7 DAY`);
  const nowMs = msW(now());
  const cache = {};
  let ditutup = 0;
  for (const s of rows) {
    const akhir = await require('./shift.service').akhirJadwalSesi(s, cache);
    const terlihat = msW(s.terakhir_di_outlet_at || s.jam_masuk);
    const acuan = akhir === null ? terlihat : Math.max(akhir, terlihat);
    if (nowMs < acuan + TUTUP_TANPA_KABAR_JAM * 3600 * 1000) continue;
    if (await tutupOtomatis(s, hitungJamPulangOtomatis(s, akhir, nowMs))) ditutup += 1;
  }
  return ditutup;
}
let _jobAbsen = null;
function mulaiPenutupOtomatis(intervalMs = 10 * 60 * 1000) {
  if (_jobAbsen) return;
  const jalan = () => tutupSesiTerlantar().catch((e) => {
    try { require('../config/logger').warn('Penutup absensi otomatis gagal', { err: e.message }); } catch (x) { /* abaikan */ }
  });
  setTimeout(jalan, 30 * 1000).unref();
  _jobAbsen = setInterval(jalan, intervalMs);
  _jobAbsen.unref();
}

/** PUT /absensi/pengaturan -- saklar absensi cabang (manager/owner). */
async function aturPengaturan(user, input = {}) {
  const cabangId = user.role === 'owner' && input.cabang_id ? Number(input.cabang_id) : Number(user.cabang_id);
  const aktif = input.absensi_aktif ? 1 : 0;
  await db.pool.execute('UPDATE cabang SET absensi_aktif = ? WHERE id = ?', [aktif, cabangId]);
  return { cabang_id: cabangId, absensi_aktif: aktif };
}

function durasiMenit(masuk, pulangW) {
  if (!masuk || !pulangW) return null;
  const t = (s) => new Date(String(s).replace(' ', 'T') + '+07:00').getTime();
  return Math.max(0, Math.round((t(pulangW) - t(masuk)) / 60000));
}

/** Riwayat absen + benefit 1 kasir dalam periode. */
async function riwayat(user, { dari, sampai, karyawanId = null } = {}) {
  const per = periode(dari, sampai);
  const kid = karyawanId || user.id;
  const rows = await db.query(
    `SELECT ${KOLOM},
            (SELECT k.status FROM absensi_koreksi k WHERE k.absensi_id = a.id ORDER BY k.id DESC LIMIT 1) AS koreksi_status
       FROM absensi a
      WHERE a.karyawan_id = ? AND a.cabang_id = ? AND a.tanggal BETWEEN ? AND ?
      ORDER BY a.jam_masuk DESC`,
    [kid, user.cabang_id, per.dari, per.sampai],
  );
  const sesi = rows.map((r) => ({ ...r, durasi_menit: durasiMenit(r.jam_masuk, r.jam_pulang) }));
  const ben = await benefit({ cabangId: user.cabang_id, dari: per.dari, sampai: per.sampai, karyawanId: kid, rinci: true });
  // Perubahan #29: ringkasan absensi per shift / part (milik sendiri)
  const rk = await require('./shift.service').rekap({ cabangId: user.cabang_id, dari: per.dari, sampai: per.sampai, karyawanId: kid });
  const rekap = { shift_diatur: rk.shift_diatur, shifts: rk.shifts, aturan: rk.aturan, saya: rk.per_karyawan[0] || null };
  return { periode: per, sesi, benefit: ben, rekap };
}

// ---------------------------------------------------------------------------
// koreksi
// ---------------------------------------------------------------------------

async function ajukanKoreksi(user, input = {}) {
  const absensiId = Number(input.absensi_id);
  const alasan = String(input.alasan || '').trim();
  const jam = String(input.jam_pulang || '').trim().replace('T', ' ');
  if (!absensiId) throw badRequest('Pilih sesi absen yang dikoreksi');
  if (alasan.length < 5) throw badRequest('Alasan wajib diisi (minimal 5 huruf)');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(jam)) throw badRequest('Jam pulang tidak valid');
  const jamPulang = jam.length === 16 ? `${jam}:00` : jam;

  const a = await db.queryOne('SELECT * FROM absensi WHERE id = ? LIMIT 1', [absensiId]);
  if (!a || Number(a.karyawan_id) !== Number(user.id)) throw notFound('Sesi absen tidak ditemukan');
  if (a.jam_pulang) throw conflict('Sesi ini sudah absen pulang, tidak perlu koreksi.');
  if (jamPulang <= a.jam_masuk) throw badRequest('Jam pulang harus setelah jam masuk');
  if (jamPulang > now()) throw badRequest('Jam pulang tidak boleh melebihi waktu sekarang');
  const menunggu = await db.queryOne(
    `SELECT id FROM absensi_koreksi WHERE absensi_id = ? AND status = 'menunggu' LIMIT 1`, [absensiId]);
  if (menunggu) throw conflict('Koreksi untuk sesi ini sedang menunggu persetujuan.');

  const [r] = await db.pool.execute(
    `INSERT INTO absensi_koreksi (absensi_id, jam_pulang_usulan, pulang_lembur, alasan, diajukan_oleh)
     VALUES (?, ?, ?, ?, ?)`,
    [absensiId, jamPulang, input.pulang_lembur ? 1 : 0, alasan.slice(0, 255), user.id],
  );
  return { id: r.insertId, status: 'menunggu' };
}

function cabangScope(user, cabangIdQuery) {
  if (user.role === 'owner') return cabangIdQuery ? Number(cabangIdQuery) : (user.cabang_dipilih ? Number(user.cabang_id) : null); // null = semua (#47: kecuali owner memilih cabang)
  return user.cabang_id;
}

async function daftarKoreksi(user, { status: st = 'menunggu', cabang_id } = {}) {
  const cab = cabangScope(user, cabang_id);
  const params = [];
  let where = '1=1';
  if (st && st !== 'semua') { where += ' AND k.status = ?'; params.push(st); }
  if (cab) { where += ' AND a.cabang_id = ?'; params.push(cab); }
  return db.query(
    `SELECT k.id, k.absensi_id, k.jam_pulang_usulan, k.pulang_lembur, k.alasan, k.status, k.created_at,
            k.diputuskan_at, k.catatan_keputusan, pk.nama AS diputuskan_nama,
            a.karyawan_id, ky.nama AS karyawan_nama, a.cabang_id, c.kode AS cabang_kode,
            a.tanggal, a.jam_masuk, a.lembur_ganti_shift
       FROM absensi_koreksi k
       JOIN absensi a ON a.id = k.absensi_id
       JOIN karyawan ky ON ky.id = a.karyawan_id
       JOIN cabang c ON c.id = a.cabang_id
       LEFT JOIN karyawan pk ON pk.id = k.diputuskan_oleh
      WHERE ${where}
      ORDER BY (k.status = 'menunggu') DESC, k.id DESC
      LIMIT 200`,
    params,
  );
}

async function putuskanKoreksi(user, koreksiId, input = {}) {
  const setuju = input.keputusan === 'setuju';
  if (!setuju && input.keputusan !== 'tolak') throw badRequest('Keputusan harus setuju / tolak');
  return db.transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT k.*, a.cabang_id, a.jam_pulang, a.jam_masuk FROM absensi_koreksi k JOIN absensi a ON a.id = k.absensi_id
        WHERE k.id = ? FOR UPDATE`, [koreksiId]);
    const k = rows[0];
    if (!k) throw notFound('Pengajuan koreksi tidak ditemukan');
    if (user.role !== 'owner' && Number(k.cabang_id) !== Number(user.cabang_id)) throw forbidden('Bukan cabang kamu');
    if (k.status !== 'menunggu') throw conflict('Pengajuan ini sudah diputuskan');
    const waktu = now();
    await conn.execute(
      `UPDATE absensi_koreksi SET status = ?, diputuskan_oleh = ?, diputuskan_at = ?, catatan_keputusan = ? WHERE id = ?`,
      [setuju ? 'disetujui' : 'ditolak', user.id, waktu, String(input.catatan || '').slice(0, 255) || null, koreksiId]);
    if (setuju) {
      if (k.jam_pulang) throw conflict('Sesi ini sudah absen pulang');
      await conn.execute(
        `UPDATE absensi SET jam_pulang = ?, pulang_lembur = ?, pulang_dikoreksi = 1 WHERE id = ? AND jam_pulang IS NULL`,
        [k.jam_pulang_usulan, k.pulang_lembur ? 1 : 0, k.absensi_id]);
    }
    return { id: Number(koreksiId), status: setuju ? 'disetujui' : 'ditolak' };
  });
}

// ---------------------------------------------------------------------------
// benefit
// ---------------------------------------------------------------------------

function periode(dari, sampai) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const t = today();
  const s = re.test(String(sampai || '')) ? sampai : t;
  const d = re.test(String(dari || '')) ? dari : `${s.slice(0, 8)}01`;
  if (d > s) throw badRequest('Tanggal awal melebihi tanggal akhir');
  return { dari: d, sampai: s };
}

/** Log terakhir (karyawan tidak null) untuk 1 status. */
function terakhir(logs, kode) {
  const r = logs.filter((l) => l.kode === kode && l.karyawan_id);
  return r.length ? r[r.length - 1] : null;
}
function pertama(logs, kode) {
  return logs.find((l) => l.kode === kode) || null;
}

/** Bagi persentase ke 1-2 orang. Beda orang -> rata, sama / hanya 1 -> penuh. */
function bagi(ids) {
  const unik = [...new Set(ids.filter(Boolean).map(Number))];
  return unik.map((id) => ({ id, porsi: 1 / unik.length }));
}

/**
 * Hitung benefit per karyawan di 1 cabang (cabangId null = semua cabang).
 * @returns {{periode, per_karyawan:[...], rincian?:[...]}}
 */
async function benefit({ cabangId = null, dari, sampai, karyawanId = null, rinci = false }) {
  const per = periode(dari, sampai);
  const awal = `${per.dari} 00:00:00`;
  const akhir = `${per.sampai} 23:59:59`;
  // order kandidat: punya event benefit di periode ini (anchor dicek lagi di bawah)
  const paramsC = [awal, akhir];
  let whereCab = '';
  if (cabangId) { whereCab = ' AND t.cabang_id = ?'; paramsC.push(cabangId); }
  const kandidat = await db.query(
    `SELECT DISTINCT t.id, t.no_invoice, t.cabang_id, t.tanggal
       FROM transaksi_status_log l
       JOIN status_master s ON s.id = l.status_id
       JOIN transaksi t ON t.id = l.transaksi_id
      WHERE l.waktu BETWEEN ? AND ?
        AND s.kode IN ('selesai_lipat','proses_lipat','mulai_cuci','mulai_kering','proses_antar')
        AND t.status_bayar = 'lunas'${whereCab}`,
    paramsC,
  );
  if (!kandidat.length) return { periode: per, per_karyawan: [], ...(rinci ? { rincian: [] } : {}) };

  const ids = kandidat.map((k) => k.id);
  const ph = ids.map(() => '?').join(',');
  const items = await db.query(
    `SELECT d.transaksi_id, l.kategori, SUM(d.subtotal) AS subtotal, SUM(d.qty) AS qty,
            (SELECT GROUP_CONCAT(DISTINCT l2.kategori) FROM detail_transaksi d2 JOIN layanan l2 ON l2.id = d2.layanan_id
              WHERE d2.transaksi_id = d.transaksi_id AND d2.item_tipe = 'jasa') AS semua_kat
       FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
      WHERE d.transaksi_id IN (${ph}) AND d.item_tipe = 'jasa'
        AND l.kategori IN ('lipat','drop_off','antar','antar_jemput','jemput')
      GROUP BY d.transaksi_id, l.kategori`, ids);
  const logs = await db.query(
    `SELECT l.transaksi_id, l.karyawan_id, l.waktu, s.kode
       FROM transaksi_status_log l JOIN status_master s ON s.id = l.status_id
      WHERE l.transaksi_id IN (${ph})
        AND s.kode IN ('selesai_lipat','proses_lipat','mulai_cuci','mulai_kering','proses_antar')
      ORDER BY l.waktu, l.id`, ids);

  const dasar = new Map(); // trxId -> {lipat, drop_off, antar}
  for (const it of items) {
    const b = dasar.get(it.transaksi_id) || { lipat: 0, drop_off: 0, antar: 0, drop_qty: 0, kat: [] };
    const kat = ['antar_jemput', 'jemput'].includes(it.kategori) ? 'antar' : it.kategori; // #73: jemput = benefit antar 80%
    b[kat] += Number(it.subtotal) || 0;
    if (kat === 'drop_off') b.drop_qty += Number(it.qty) || 0;
    b.kat = String(it.semua_kat || '').split(',');
    dasar.set(it.transaksi_id, b);
  }
  const logPer = new Map();
  for (const l of logs) {
    if (!logPer.has(l.transaksi_id)) logPer.set(l.transaksi_id, []);
    logPer.get(l.transaksi_id).push(l);
  }
  const diPeriode = (w) => w && w >= awal && w <= akhir;

  const baris = []; // {karyawan_id, transaksi_id, no_invoice, jenis, dasar, persen, nilai, waktu, peran}
  for (const t of kandidat) {
    const b = dasar.get(t.id);
    const lg = logPer.get(t.id) || [];
    if (!b) continue;

    // Perubahan #43: yang START yang dapat benefit.
    if (b.lipat > 0) {
      // lipat: seluruh bagian untuk yang MULAI lipat (cadangan: yang menyelesaikan, kalau tidak ada log mulai)
      const mulai = terakhir(lg, 'proses_lipat') || terakhir(lg, 'selesai_lipat');
      const anchor = (pertama(lg, 'selesai_lipat') || {}).waktu;
      if (mulai && diPeriode(anchor)) {
        baris.push({ karyawan_id: Number(mulai.karyawan_id), transaksi_id: t.id, no_invoice: t.no_invoice, jenis: 'lipat', dasar: b.lipat,
          persen: PERSEN.lipat * 100, nilai: Math.round(b.lipat * PERSEN.lipat), waktu: anchor, peran: 'Mulai lipat' });
      }
    }
    if (b.drop_off > 0) {
      // drop-off: dibagi per mesin yang di-start karyawan.
      //   2x (cuci + kering)        -> start cuci 1/2, start kering 1/2
      //   1x pada order cuci+kering -> petugas memindahkan ke pengering -> yang start kering
      //   cuci saja / kering saja   -> yang start mesin itu
      const cuci = terakhir(lg, 'mulai_cuci');
      const kering = terakhir(lg, 'mulai_kering');
      const awalMesin = lg.find((l) => l.kode === 'mulai_cuci' || l.kode === 'mulai_kering');
      const anchor = awalMesin && awalMesin.waktu;
      const adaCuci = b.kat.includes('cuci'); const adaKering = b.kat.includes('kering');
      let bagian;
      if (adaCuci && adaKering) bagian = b.drop_qty >= 2 ? [[cuci, 0.5, 'cuci'], [kering, 0.5, 'kering']] : [[kering, 1, 'kering']];
      else bagian = [[adaKering ? kering : cuci, 1, adaKering ? 'kering' : 'cuci']];
      if (diPeriode(anchor)) {
        const per = new Map();
        for (const [lgx, porsi, nm] of bagian) {
          if (!lgx || !lgx.karyawan_id) continue;
          const id = Number(lgx.karyawan_id);
          const x = per.get(id) || { porsi: 0, peran: [] };
          x.porsi += porsi; x.peran.push(nm); per.set(id, x);
        }
        for (const [id, x] of per) {
          baris.push({ karyawan_id: id, transaksi_id: t.id, no_invoice: t.no_invoice, jenis: 'drop_off', dasar: b.drop_off,
            persen: PERSEN.drop_off * x.porsi * 100, nilai: Math.round(b.drop_off * PERSEN.drop_off * x.porsi), waktu: anchor, peran: `Start mesin ${x.peran.join(' + ')}` });
        }
      }
    }
    if (b.antar > 0) {
      const pa = terakhir(lg, 'proses_antar');
      if (pa && diPeriode(pa.waktu)) {
        baris.push({ karyawan_id: Number(pa.karyawan_id), transaksi_id: t.id, no_invoice: t.no_invoice, jenis: 'antar', dasar: b.antar,
          persen: PERSEN.antar * 100, nilai: Math.round(b.antar * PERSEN.antar), waktu: pa.waktu, peran: 'Proses antar' });
      }
    }
  }

  const pilih = karyawanId ? baris.filter((r) => r.karyawan_id === Number(karyawanId)) : baris;
  const agg = new Map();
  for (const r of pilih) {
    const a = agg.get(r.karyawan_id) || { karyawan_id: r.karyawan_id, lipat: 0, drop_off: 0, antar: 0, total: 0, jumlah_order: new Set(),
      trx_lipat: 0, trx_drop_off: 0, trx_antar: 0 };
    a[r.jenis] += r.nilai;
    a['trx_' + r.jenis] += 1; // Perubahan #29: jumlah transaksi per item benefit
    a.total += r.nilai;
    a.jumlah_order.add(r.transaksi_id);
    agg.set(r.karyawan_id, a);
  }
  const kids = [...agg.keys()];
  const nama = new Map();
  if (kids.length) {
    const ks = await db.query(
      `SELECT k.id, k.nama, r.nama_role AS role FROM karyawan k JOIN role r ON r.id = k.role_id WHERE k.id IN (${kids.map(() => '?').join(',')})`, kids);
    for (const k of ks) nama.set(Number(k.id), k);
  }
  const perKaryawan = [...agg.values()].map((a) => ({
    ...a, jumlah_order: a.jumlah_order.size,
    nama: (nama.get(a.karyawan_id) || {}).nama || `#${a.karyawan_id}`,
    role: (nama.get(a.karyawan_id) || {}).role || null,
  })).sort((x, y) => y.total - x.total);

  const out = { periode: per, per_karyawan: perKaryawan };
  if (rinci) out.rincian = pilih.sort((x, y) => String(y.waktu).localeCompare(String(x.waktu)));
  return out;
}

module.exports = {
  status, masuk, pulang, riwayat, sesiAktif, bolehAkses,
  laporLokasi, tutupSesiTerlantar, mulaiPenutupOtomatis, aturPengaturan,
  ajukanKoreksi, daftarKoreksi, putuskanKoreksi,
  benefit, periode, cabangScope,
  _internal: { jarakMeter, bagi, hitungJamPulangOtomatis },
};
