/**
 * src/services/shift.service.js
 * =============================================================================
 * Perubahan #29 -- Shift, part & jadwal mingguan kasir + rekap absensi.
 *
 *  shift_part   : definisi part per cabang (bebas diatur manager/owner).
 *  jadwal_shift : jadwal mingguan hari x part -> karyawan, berversi
 *                 (berlaku_mulai). Ubah jadwal hari ini = baris baru bertanggal
 *                 hari ini, sehingga rekap tanggal sebelumnya tetap.
 *
 *  Rekap per part (untuk tiap tanggal di periode, s/d sekarang):
 *   - HADIR       : jam kerja (absen masuk..pulang) menutupi >= 75% durasi part
 *   - TELAT       : hadir di part terjadwal, datang > 15 menit setelah part mulai
 *   - TIDAK HADIR : dijadwalkan, part sudah lewat, tidak hadir
 *   - LUAR JADWAL : hadir di part yang bukan jadwalnya (gantikan / lembur)
 *  Sesi tanpa absen pulang: kalau masih aktif dihitung s/d sekarang; kalau
 *  lupa pulang tidak dihitung sampai koreksinya disetujui.
 * =============================================================================
 */

const db = require('../config/database');
const { now, today } = require('../helpers/date');
const { badRequest, notFound, conflict } = require('../helpers/errors');

const AMBANG_HADIR = 0.75;   // porsi part yang harus ditutup jam kerja
const TOLERANSI_TELAT_MENIT = 15;
const MAKS_SESI_JAM = 16;    // sama dengan absensi.service
const MAKS_PER_SEL = 3;      // Perubahan #29b: 1 part maks 3 karyawan
const NAMA_HARI = ['', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

// ---------------------------------------------------------------------------
// util waktu (semua WIB)
// ---------------------------------------------------------------------------
const ms = (s) => new Date(String(s).replace(' ', 'T') + '+07:00').getTime();
function menitDariJam(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}
function jamTeks(t) { return String(t).slice(0, 5); }
/** Hari ISO 1=Senin..7=Minggu dari 'YYYY-MM-DD'. */
function hariIso(tgl) {
  const d = new Date(`${tgl}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
function tambahHari(tgl, n) {
  const d = new Date(`${tgl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function cabangDari(user, cabangIdQuery) {
  if (user.role === 'owner' && cabangIdQuery) return Number(cabangIdQuery);
  return Number(user.cabang_id);
}

// ---------------------------------------------------------------------------
// shift_part
// ---------------------------------------------------------------------------
async function daftarPart(cabangId, { semua = false } = {}) {
  const rows = await db.query(
    `SELECT id, cabang_id, shift, kode, nama, jam_mulai, jam_selesai, hari_berlaku, status
       FROM shift_part WHERE cabang_id = ? ${semua ? '' : "AND status = 'aktif'"}
      ORDER BY shift, jam_mulai, kode`, [cabangId]);
  return rows.map((r) => ({
    ...r,
    jam_mulai: jamTeks(r.jam_mulai), jam_selesai: jamTeks(r.jam_selesai),
    durasi_menit: durasiPart(r),
  }));
}
function durasiPart(p) {
  let d = menitDariJam(p.jam_selesai) - menitDariJam(p.jam_mulai);
  if (d <= 0) d += 1440; // lewat tengah malam
  return d;
}

function validasiPart(input) {
  const shift = Number(input.shift);
  const kode = String(input.kode || '').trim().toUpperCase();
  const nama = String(input.nama || '').trim();
  const re = /^([01]\d|2[0-4]):[0-5]\d$/;
  const mulai = String(input.jam_mulai || '').slice(0, 5);
  const selesai = String(input.jam_selesai || '').slice(0, 5);
  const hari = [...new Set(String(input.hari_berlaku || '1234567').replace(/[^1-7]/g, '').split(''))].sort().join('');
  if (!Number.isInteger(shift) || shift < 1 || shift > 9) throw badRequest('Nomor shift 1–9');
  if (!kode || kode.length > 10) throw badRequest('Kode part wajib (maks 10 huruf), mis. 1A');
  if (!nama || nama.length > 30) throw badRequest('Nama part wajib (maks 30 huruf), mis. Pagi');
  if (!re.test(mulai) || !re.test(selesai) || mulai > '23:59') throw badRequest('Jam tidak valid (format JJ:MM, selesai boleh 24:00)');
  if (mulai === selesai) throw badRequest('Jam mulai dan selesai tidak boleh sama');
  if (!hari) throw badRequest('Pilih minimal 1 hari berlaku');
  return { shift, kode, nama, jam_mulai: `${mulai}:00`, jam_selesai: `${selesai}:00`, hari_berlaku: hari };
}

async function simpanPart(user, cabangIdQuery, input, id = null) {
  const cabangId = cabangDari(user, cabangIdQuery || input.cabang_id);
  const v = validasiPart(input);
  if (id) {
    const ada = await db.queryOne('SELECT id FROM shift_part WHERE id = ? AND cabang_id = ?', [id, cabangId]);
    if (!ada) throw notFound('Part shift tidak ditemukan');
    const bentrok = await db.queryOne('SELECT id FROM shift_part WHERE cabang_id = ? AND kode = ? AND id <> ?', [cabangId, v.kode, id]);
    if (bentrok) throw conflict(`Kode ${v.kode} sudah dipakai`);
    await db.pool.execute(
      `UPDATE shift_part SET shift = ?, kode = ?, nama = ?, jam_mulai = ?, jam_selesai = ?, hari_berlaku = ?, status = 'aktif' WHERE id = ?`,
      [v.shift, v.kode, v.nama, v.jam_mulai, v.jam_selesai, v.hari_berlaku, id]);
    return { id };
  }
  const lama = await db.queryOne('SELECT id, status FROM shift_part WHERE cabang_id = ? AND kode = ?', [cabangId, v.kode]);
  if (lama && lama.status === 'aktif') throw conflict(`Kode ${v.kode} sudah dipakai`);
  if (lama) { // pakai lagi baris nonaktif dengan kode sama
    await db.pool.execute(
      `UPDATE shift_part SET shift = ?, nama = ?, jam_mulai = ?, jam_selesai = ?, hari_berlaku = ?, status = 'aktif' WHERE id = ?`,
      [v.shift, v.nama, v.jam_mulai, v.jam_selesai, v.hari_berlaku, lama.id]);
    return { id: lama.id };
  }
  const [r] = await db.pool.execute(
    `INSERT INTO shift_part (cabang_id, shift, kode, nama, jam_mulai, jam_selesai, hari_berlaku) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cabangId, v.shift, v.kode, v.nama, v.jam_mulai, v.jam_selesai, v.hari_berlaku]);
  return { id: r.insertId };
}

async function hapusPart(user, cabangIdQuery, id) {
  const cabangId = cabangDari(user, cabangIdQuery);
  const [r] = await db.pool.execute(`UPDATE shift_part SET status = 'nonaktif' WHERE id = ? AND cabang_id = ?`, [id, cabangId]);
  if (!r.affectedRows) throw notFound('Part shift tidak ditemukan');
  return { id };
}

// ---------------------------------------------------------------------------
// jadwal mingguan
// ---------------------------------------------------------------------------
async function semuaJadwal(cabangId, sampai) {
  return db.query(
    `SELECT j.hari, j.shift_part_id, j.slot, j.karyawan_id, j.berlaku_mulai
       FROM jadwal_shift j WHERE j.cabang_id = ? AND j.berlaku_mulai <= ?
      ORDER BY j.berlaku_mulai, j.slot`, [cabangId, sampai]);
}
/**
 * Fungsi pencari jadwal efektif: (tgl, hari, partId) -> [karyawan_id, ...]
 * (Perubahan #29b: 1 sel boleh 1..3 karyawan). Versi sel = berlaku_mulai
 * terbaru <= tgl; semua slot di versi itu yang dipakai.
 */
function pencariJadwal(rows) {
  const per = new Map(); // `${hari}|${part}` -> Map(mulai -> [kid])
  for (const r of rows) {
    const k = `${r.hari}|${r.shift_part_id}`;
    if (!per.has(k)) per.set(k, new Map());
    const versi = per.get(k);
    const mulai = String(r.berlaku_mulai).slice(0, 10);
    if (!versi.has(mulai)) versi.set(mulai, []);
    if (r.karyawan_id) versi.get(mulai).push(Number(r.karyawan_id));
  }
  return (tgl, hari, partId) => {
    const versi = per.get(`${hari}|${partId}`);
    if (!versi) return [];
    let pakai = [];
    for (const [mulai, kids] of [...versi.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (mulai <= tgl) pakai = kids; else break;
    }
    return [...new Set(pakai)];
  };
}

async function karyawanCabang(cabangId) {
  return db.query(
    `SELECT k.id, k.nama, r.nama_role AS role FROM karyawan k JOIN role r ON r.id = k.role_id
      WHERE k.cabang_id = ? AND k.status = 'aktif' AND r.nama_role IN ('kasir','operator')
      ORDER BY k.nama`, [cabangId]);
}

async function jadwal(user, { cabang_id, tanggal } = {}) {
  const cabangId = cabangDari(user, cabang_id);
  const tgl = /^\d{4}-\d{2}-\d{2}$/.test(String(tanggal || '')) ? tanggal : today();
  const parts = await daftarPart(cabangId);
  const cari = pencariJadwal(await semuaJadwal(cabangId, tgl));
  const kry = await karyawanCabang(cabangId);
  const namaK = new Map(kry.map((k) => [Number(k.id), k.nama]));
  const tanpaNama = [...new Set((await semuaJadwal(cabangId, tgl)).map((r) => r.karyawan_id).filter((x) => x && !namaK.has(Number(x))))];
  if (tanpaNama.length) {
    const ks = await db.query(`SELECT id, nama FROM karyawan WHERE id IN (${tanpaNama.map(() => '?').join(',')})`, tanpaNama);
    for (const k of ks) namaK.set(Number(k.id), `${k.nama} (nonaktif)`);
  }
  const sel = [];
  for (let h = 1; h <= 7; h++) {
    for (const p of parts) {
      if (!p.hari_berlaku.includes(String(h))) continue;
      const kids = cari(tgl, h, p.id);
      sel.push({ hari: h, shift_part_id: p.id, karyawan_ids: kids, nama: kids.map((k) => namaK.get(k) || `#${k}`) });
    }
  }
  const cab = await db.queryOne('SELECT absensi_aktif FROM cabang WHERE id = ?', [cabangId]);
  return { cabang_id: cabangId, absensi_aktif: cab ? Number(cab.absensi_aktif) : 0, maks_per_sel: MAKS_PER_SEL, tanggal: tgl, hari: NAMA_HARI.slice(1), parts, sel, karyawan: kry };
}

async function aturJadwal(user, input = {}) {
  const cabangId = cabangDari(user, input.cabang_id);
  const hari = Number(input.hari);
  const partId = Number(input.shift_part_id);
  // terima karyawan_ids [..] (baru) atau karyawan_id tunggal (lama)
  let ids = Array.isArray(input.karyawan_ids) ? input.karyawan_ids : (input.karyawan_id ? [input.karyawan_id] : []);
  ids = ids.map(Number).filter((x) => x > 0);
  if (new Set(ids).size !== ids.length) throw badRequest('Karyawan yang sama dipilih lebih dari sekali');
  if (ids.length > MAKS_PER_SEL) throw badRequest(`Maksimal ${MAKS_PER_SEL} karyawan per part`);
  if (!(hari >= 1 && hari <= 7)) throw badRequest('Hari tidak valid');
  const part = await db.queryOne(`SELECT * FROM shift_part WHERE id = ? AND cabang_id = ? AND status = 'aktif'`, [partId, cabangId]);
  if (!part) throw notFound('Part shift tidak ditemukan');
  if (!String(part.hari_berlaku).includes(String(hari))) throw badRequest(`Part ${part.kode} tidak berlaku di hari ${NAMA_HARI[hari]}`);
  if (ids.length) {
    const ks = await db.query(`SELECT id FROM karyawan WHERE cabang_id = ? AND status = 'aktif' AND id IN (${ids.map(() => '?').join(',')})`, [cabangId, ...ids]);
    if (ks.length !== ids.length) throw badRequest('Ada karyawan bukan dari cabang ini / nonaktif');
  }
  const mulai = String(input.berlaku_mulai || '').match(/^\d{4}-\d{2}-\d{2}$/) ? input.berlaku_mulai : today();
  await db.transaction(async (conn) => {
    // versi sel bertanggal `mulai` ditulis ulang utuh (semua slot)
    await conn.execute('DELETE FROM jadwal_shift WHERE cabang_id = ? AND hari = ? AND shift_part_id = ? AND berlaku_mulai = ?', [cabangId, hari, partId, mulai]);
    const isi = ids.length ? ids : [null]; // sel dikosongkan = 1 baris tanpa karyawan
    for (let i = 0; i < isi.length; i++) {
      await conn.execute(
        `INSERT INTO jadwal_shift (cabang_id, hari, shift_part_id, slot, karyawan_id, berlaku_mulai, dibuat_oleh) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cabangId, hari, partId, i + 1, isi[i], mulai, user.id]);
    }
  });
  return { hari, shift_part_id: partId, karyawan_ids: ids, berlaku_mulai: mulai };
}

/**
 * Akhir jadwal yang relevan untuk 1 sesi absen (Perubahan #30), dalam ms.
 * = selesai part paling akhir di tanggal masuk (dan part lintas malam hari
 *   sebelumnya) yang (a) dijadwalkan untuk karyawan ini, ATAU (b) ia tutupi
 *   saat masih di outlet (gantikan orang). null = tidak ada jadwal sama sekali.
 */
async function akhirJadwalSesi(sesi, cache = {}) {
  const cabangId = Number(sesi.cabang_id);
  if (!cache[cabangId]) {
    cache[cabangId] = { parts: await daftarPart(cabangId), cari: pencariJadwal(await semuaJadwal(cabangId, today())) };
  }
  const { parts, cari } = cache[cabangId];
  const kid = Number(sesi.karyawan_id);
  const masuk = ms(sesi.jam_masuk);
  const terlihat = ms(sesi.terakhir_di_outlet_at || sesi.jam_masuk);
  const tglMasuk = String(sesi.jam_masuk).slice(0, 10);
  let akhir = null;
  for (const tgl of [tambahHari(tglMasuk, -1), tglMasuk]) {
    const h = hariIso(tgl);
    for (const p of parts) {
      if (!p.hari_berlaku.includes(String(h))) continue;
      const mulai = ms(`${tgl} 00:00:00`) + menitDariJam(p.jam_mulai) * 60000;
      const selesai = mulai + p.durasi_menit * 60000;
      if (selesai <= masuk - 60 * 60000) continue;           // sudah lewat jauh sebelum masuk
      const milikSendiri = cari(tgl, h, p.id).includes(kid) && tgl === tglMasuk;
      const ditutupi = Math.min(terlihat, selesai) - Math.max(masuk, mulai) >= 30 * 60000; // ikut jaga >= 30 mnt
      if (milikSendiri || ditutupi) akhir = akhir === null ? selesai : Math.max(akhir, selesai);
    }
  }
  return akhir;
}

// ---------------------------------------------------------------------------
// rekap absensi per shift / part
// ---------------------------------------------------------------------------
async function rekap({ cabangId, dari, sampai, karyawanId = null }) {
  const sekarang = ms(now());
  const batasAktif = sekarang - MAKS_SESI_JAM * 3600 * 1000;
  const parts = await daftarPart(cabangId);
  const cari = pencariJadwal(await semuaJadwal(cabangId, sampai));
  const sesiRows = await db.query(
    `SELECT a.id, a.karyawan_id, a.tanggal, a.jam_masuk, a.jam_pulang, a.lembur_ganti_shift, a.pulang_lembur, a.pulang_dikoreksi, a.pulang_otomatis,
            (SELECT k.status FROM absensi_koreksi k WHERE k.absensi_id = a.id ORDER BY k.id DESC LIMIT 1) AS koreksi_status
       FROM absensi a
      WHERE a.cabang_id = ? AND a.tanggal BETWEEN ? AND ?
      ORDER BY a.jam_masuk`,
    [cabangId, tambahHari(dari, -1), sampai]);

  // rentang kerja tiap sesi (ms)
  const sesi = sesiRows.map((s) => {
    const m = ms(s.jam_masuk);
    let p = null; let status = 'selesai';
    if (s.jam_pulang) p = ms(s.jam_pulang);
    else if (m >= batasAktif) { p = sekarang; status = 'aktif'; }
    else status = 'lupa_pulang';
    return { ...s, karyawan_id: Number(s.karyawan_id), _m: m, _p: p, status_sesi: status,
      durasi_menit: p ? Math.max(0, Math.round((p - m) / 60000)) : null, part: [] };
  });
  const sesiPer = new Map();
  for (const s of sesi) {
    if (!sesiPer.has(s.karyawan_id)) sesiPer.set(s.karyawan_id, []);
    sesiPer.get(s.karyawan_id).push(s);
  }

  const kry = await karyawanCabang(cabangId);
  const orang = new Map(); // id -> objek rekap
  const shiftList = [...new Set(parts.map((p) => p.shift))].sort((a, b) => a - b);
  const baru = (id, nama) => {
    const o = { karyawan_id: id, nama, shift: {}, detail: [], sesi: [], jam_kerja_menit: 0, hari_masuk: 0,
      lembur_ganti_shift: 0, pulang_lembur: 0, lupa_pulang: 0, pulang_otomatis: 0 };
    for (const sh of shiftList) o.shift[sh] = { dijadwalkan: 0, hadir: 0, telat: 0, tidak_hadir: 0, luar_jadwal: 0, part: {} };
    orang.set(id, o);
    return o;
  };
  for (const k of kry) baru(Number(k.id), k.nama);
  const ambil = (id) => orang.get(id) || baru(id, `#${id}`);

  const akhirTgl = sampai < today() ? sampai : today();
  for (let tgl = dari; tgl <= akhirTgl; tgl = tambahHari(tgl, 1)) {
    const h = hariIso(tgl);
    for (const p of parts) {
      if (!p.hari_berlaku.includes(String(h))) continue;
      const mulai = ms(`${tgl} 00:00:00`) + menitDariJam(p.jam_mulai) * 60000;
      const selesai = mulai + p.durasi_menit * 60000;
      if (mulai > sekarang) continue;            // belum mulai
      const lewat = selesai <= sekarang;
      const terjadwal = cari(tgl, h, p.id);
      const perlu = p.durasi_menit * AMBANG_HADIR;
      const hadirSiapa = new Map(); // kid -> {menit, datang}
      for (const [kid, list] of sesiPer) {
        let menit = 0; let datang = null; const ikut = [];
        for (const s of list) {
          if (!s._p) continue;
          const o = Math.min(s._p, selesai) - Math.max(s._m, mulai);
          if (o > 0) {
            menit += o / 60000;
            datang = datang === null ? s._m : Math.min(datang, s._m);
            ikut.push(s);
          }
        }
        if (menit > 0) hadirSiapa.set(kid, { menit, datang });
        // part dicatat di sesi hanya kalau memenuhi ambang hadir
        if (menit >= perlu) for (const s of ikut) if (!s.part.includes(p.kode)) s.part.push(p.kode);
      }
      const catat = (kid, status, extra = {}) => {
        const o = ambil(kid);
        const sh = o.shift[p.shift];
        const pp = sh.part[p.kode] || (sh.part[p.kode] = { nama: p.nama, dijadwalkan: 0, hadir: 0 });
        // part yang masih berjalan (belum memenuhi ambang) belum dihitung di jadwal
        if (status !== 'luar_jadwal' && status !== 'berjalan') { sh.dijadwalkan += 1; pp.dijadwalkan += 1; }
        if (status === 'hadir' || status === 'telat' || status === 'luar_jadwal') pp.hadir += 1;
        if (status === 'hadir') sh.hadir += 1;
        if (status === 'telat') { sh.hadir += 1; sh.telat += 1; }
        if (status === 'tidak_hadir') sh.tidak_hadir += 1;
        if (status === 'luar_jadwal') sh.luar_jadwal += 1;
        o.detail.push({ tanggal: tgl, hari: NAMA_HARI[h], shift: p.shift, kode: p.kode, nama_part: p.nama,
          jam: `${p.jam_mulai}–${p.jam_selesai}`, terjadwal: status !== 'luar_jadwal', status, ...extra });
      };
      const tidakHadir = [];
      for (const kidJ of terjadwal) {
        const x = hadirSiapa.get(kidJ);
        if (x && x.menit >= perlu) {
          const telatMenit = Math.round((x.datang - mulai) / 60000);
          if (telatMenit > TOLERANSI_TELAT_MENIT) catat(kidJ, 'telat', { menit_telat: telatMenit });
          else catat(kidJ, 'hadir');
        } else if (lewat) { catat(kidJ, 'tidak_hadir', { menit_hadir: x ? Math.round(x.menit) : 0 }); tidakHadir.push(kidJ); }
        else catat(kidJ, 'berjalan');
      }
      for (const [kid, x] of hadirSiapa) {
        if (terjadwal.includes(kid) || x.menit < perlu) continue;
        catat(kid, 'luar_jadwal', { menggantikan: tidakHadir.length ? tidakHadir : null });
      }
    }
  }

  // sesi & total per orang (sesi yang dimulai di periode)
  for (const s of sesi) {
    const tgl = String(s.tanggal).slice(0, 10);
    if (tgl < dari || tgl > sampai) continue;
    const o = ambil(s.karyawan_id);
    o.sesi.push({
      id: s.id, tanggal: tgl, jam_masuk: s.jam_masuk, jam_pulang: s.jam_pulang, durasi_menit: s.durasi_menit,
      status_sesi: s.status_sesi, part: s.part, lembur_ganti_shift: Number(s.lembur_ganti_shift), pulang_lembur: Number(s.pulang_lembur),
      pulang_dikoreksi: Number(s.pulang_dikoreksi), pulang_otomatis: Number(s.pulang_otomatis || 0), koreksi_status: s.koreksi_status,
    });
    if (s.durasi_menit) o.jam_kerja_menit += s.durasi_menit;
    if (Number(s.lembur_ganti_shift)) o.lembur_ganti_shift += 1;
    if (Number(s.pulang_lembur)) o.pulang_lembur += 1;
    if (s.status_sesi === 'lupa_pulang') o.lupa_pulang += 1;
    if (Number(s.pulang_otomatis)) o.pulang_otomatis += 1;
  }
  // nama karyawan yang tidak ada di daftar kasir aktif
  const tanpaNama = [...orang.values()].filter((o) => o.nama.startsWith('#')).map((o) => o.karyawan_id);
  if (tanpaNama.length) {
    const ks = await db.query(`SELECT id, nama FROM karyawan WHERE id IN (${tanpaNama.map(() => '?').join(',')})`, tanpaNama);
    for (const k of ks) orang.get(Number(k.id)).nama = k.nama;
  }
  let hasil = [...orang.values()].map((o) => {
    o.hari_masuk = new Set(o.sesi.map((s) => s.tanggal)).size;
    o.sesi.sort((a, b) => String(b.jam_masuk).localeCompare(String(a.jam_masuk)));
    o.detail.sort((a, b) => (b.tanggal + b.kode).localeCompare(a.tanggal + a.kode));
    return o;
  });
  // sembunyikan karyawan tanpa jadwal & tanpa absen
  hasil = hasil.filter((o) => o.sesi.length || o.detail.length);
  for (const o of hasil) for (const d of o.detail) {
    if (d.menggantikan) d.menggantikan_nama = d.menggantikan.map((k) => (orang.get(Number(k)) || {}).nama || `#${k}`).join(', ');
  }
  if (karyawanId) hasil = hasil.filter((o) => o.karyawan_id === Number(karyawanId));
  hasil.sort((a, b) => a.nama.localeCompare(b.nama));

  const shifts = shiftList.map((sh) => {
    const ps = parts.filter((p) => p.shift === sh);
    return { shift: sh, label: `Shift ${sh}`, parts: ps.map((p) => ({ kode: p.kode, nama: p.nama, jam: `${p.jam_mulai}–${p.jam_selesai}`, hari_berlaku: p.hari_berlaku })) };
  });
  return {
    periode: { dari, sampai }, aturan: { ambang_hadir_persen: AMBANG_HADIR * 100, toleransi_telat_menit: TOLERANSI_TELAT_MENIT },
    shift_diatur: parts.length > 0, shifts, per_karyawan: hasil,
  };
}

module.exports = {
  daftarPart, simpanPart, hapusPart, jadwal, aturJadwal, rekap, cabangDari, akhirJadwalSesi,
  _internal: { hariIso, tambahHari, durasiPart },
};
