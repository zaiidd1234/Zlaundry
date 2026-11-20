/**
 * src/services/owner.service.js
 * =============================================================================
 * Perubahan #47 -- app OWNER (lintas cabang).
 *  - dashboard : omzet hari ini / minggu ini (Senin s/d hari ini) / bulan ini,
 *                laba bersih bulan ini (rumus = dashboard manager), per cabang +
 *                total; status semua mesin per cabang (hanya tampilan).
 *  - cabang    : daftar + ubah kolom yang diizinkan. Mode antrian mesin, winpay,
 *                MDR DIKUNCI (parameter produksi, tidak bisa diubah dari sini).
 *  - user      : kelola manager / kasir / operator / kurir semua cabang,
 *                termasuk jatah cuci (Perubahan #46: hanya owner).
 *                Hapus = permanen bila belum pernah dipakai; kalau sudah punya
 *                riwayat -> dinonaktifkan.
 * =============================================================================
 */

const bcrypt = require('bcryptjs');
const db = require('../config/database');
const transaksiModel = require('../models/transaksi.model');
const laporanService = require('./laporan.service');
const { today } = require('../helpers/date');
const { normalizeHp } = require('../helpers/phone');
const { badRequest, notFound, conflict, forbidden } = require('../helpers/errors');

const ROLE_USER = ['manager', 'kasir', 'operator', 'kurir'];
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

/* ------------------------------------------------------------------ util */
function tambahHari(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function rentang() {
  const ymd = today();
  const dow = (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; // Senin = 0
  const [y, m] = ymd.slice(0, 7).split('-').map(Number);
  const akhirBulan = `${ymd.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  return { ymd, senin: tambahHari(ymd, -dow), awalBulan: `${ymd.slice(0, 7)}-01`, akhirBulan };
}
function kodePendek(kode) {
  const t = String(kode || '').split('-').pop();
  const m = t.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : t;
}

async function daftarCabang({ semua = true } = {}) {
  return db.query(`SELECT * FROM cabang ${semua ? '' : "WHERE status = 'aktif'"} ORDER BY kode`);
}

/* ------------------------------------------------------------ dashboard */
async function dashboard() {
  const r = rentang();
  const cabang = await daftarCabang({ semua: false });
  const { papanMesin } = require('./dashboard.service');
  const per = await Promise.all(cabang.map(async (c) => {
    const [hari, minggu, bulan, laba, mesin] = await Promise.all([
      transaksiModel.ringkasHarian(c.id, r.ymd),
      transaksiModel.ringkasRange(c.id, r.senin, r.ymd),
      transaksiModel.ringkasRange(c.id, r.awalBulan, r.ymd),
      laporanService.labaRugi(c.id, { dari: r.awalBulan, sampai: r.akhirBulan }).catch(() => ({ laba_bersih: 0 })),
      papanMesin ? papanMesin(c.id).catch(() => []) : [],
    ]);
    const mesinRingkas = (mesin || []).filter((m) => m.tipe === 'washer' || m.tipe === 'dryer').map((m) => {
      const u = m.usage;
      const sisa = u && u.durasi_target != null && u.durasi_menit != null ? Math.max(0, u.durasi_target - u.durasi_menit) : null;
      return { id: m.id, kode: kodePendek(m.kode_mesin), tipe: m.tipe, status: m.status, sisa_menit: sisa, total_cycle: Number(m.total_cycle) || 0 };
    }).sort((a, b) => Number(a.kode.replace(/\D/g, '')) - Number(b.kode.replace(/\D/g, '')));
    return {
      cabang_id: c.id, kode: c.kode, nama: c.nama,
      target_omzet_bulanan: c.target_omzet_bulanan != null ? Number(c.target_omzet_bulanan) : null,
      hari_ini: hari, minggu_ini: minggu, bulan_ini: bulan,
      laba_bersih_bulan_ini: Number(laba.laba_bersih) || 0,
      mesin: mesinRingkas,
    };
  }));
  const jumlah = (f) => per.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  return {
    tanggal: r.ymd, minggu_mulai: r.senin, bulan_mulai: r.awalBulan,
    total: {
      hari_ini: jumlah((x) => x.hari_ini.omzet), minggu_ini: jumlah((x) => x.minggu_ini.omzet),
      bulan_ini: jumlah((x) => x.bulan_ini.omzet), laba_bersih_bulan_ini: jumlah((x) => x.laba_bersih_bulan_ini),
      target_omzet_bulanan: jumlah((x) => x.target_omzet_bulanan),
    },
    cabang: per,
  };
}

/* --------------------------------------------------------------- cabang */
const KOLOM_CABANG = {
  nama: { max: 100, wajib: true }, alamat: { max: 255 }, kota: { max: 50 }, provinsi: { max: 50 }, no_hp: { max: 20 },
  link_wa: { max: 255 }, link_gmap_review: { max: 255 }, link_ig: { max: 255 }, link_fb: { max: 255 }, link_tiktok: { max: 255 },
};
// Perubahan #83: mdr_winpay_persen (potongan Winpay) sekarang boleh diubah owner di form ini;
// winpay_aktif (Kios-K) diubah lewat saklar metode bayar (PUT /owner/cabang/:id/metode-bayar).
const KUNCI_CABANG = ['pemilihan_mesin', 'winpay_aktif'];

async function ubahCabang(id, input = {}) {
  const c = await db.queryOne('SELECT * FROM cabang WHERE id = ?', [id]);
  if (!c) throw notFound('Cabang tidak ditemukan');
  const kunci = KUNCI_CABANG.filter((k) => input[k] !== undefined && String(input[k]) !== String(c[k]));
  if (kunci.length) throw forbidden('Mode antrian mesin & saklar Kios-K tidak bisa diubah dari form ini (Kios-K: pakai switch Metode bayar)');
  const set = {};
  for (const [k, aturan] of Object.entries(KOLOM_CABANG)) {
    if (input[k] === undefined) continue;
    const v = String(input[k] == null ? '' : input[k]).trim();
    if (aturan.wajib && !v) throw badRequest(`${k} wajib diisi`);
    if (v.length > aturan.max) throw badRequest(`${k} maksimal ${aturan.max} huruf`);
    set[k] = v || null;
  }
  const angka = (k, { min = 0, max = 1e12, bulat = false, boleh_kosong = true } = {}) => {
    if (input[k] === undefined) return;
    if ((input[k] === '' || input[k] === null) && boleh_kosong) { set[k] = null; return; }
    const n = Number(String(input[k]).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${k} tidak valid`);
    set[k] = bulat ? Math.round(n) : n;
  };
  angka('latitude', { min: -90, max: 90 });
  angka('longitude', { min: -180, max: 180 });
  angka('radius_absen_m', { min: 10, max: 5000, bulat: true, boleh_kosong: false });
  angka('target_omzet_bulanan', { min: 0, max: 1e11 });
  angka('nilai_per_poin', { min: 0, max: 1e6, boleh_kosong: false });
  angka('modal_investasi', { min: 0, max: 1e12 }); // Perubahan #55
  angka('mdr_winpay_persen', { min: 0, max: 10 }); // Perubahan #83: potongan Winpay (Kios-K) %
  if (input.absensi_aktif !== undefined) set.absensi_aktif = Number(input.absensi_aktif) ? 1 : 0;
  if (input.status !== undefined) {
    if (!['aktif', 'nonaktif'].includes(input.status)) throw badRequest('Status cabang tidak valid');
    set.status = input.status;
  }
  const kol = Object.keys(set);
  if (kol.length) {
    await db.query(`UPDATE cabang SET ${kol.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...kol.map((k) => set[k]), id]);
  }
  return db.queryOne('SELECT * FROM cabang WHERE id = ?', [id]);
}

/* ----------------------------------------------------------------- user */
const KOLOM_USER = `k.id, k.cabang_id, k.nama, k.username, k.telepon, k.status, k.jatah_cuci_mingguan, k.created_at,
  r.nama_role AS role, c.kode AS cabang_kode, c.nama AS cabang_nama`;

async function daftarUser() {
  return db.query(
    `SELECT ${KOLOM_USER} FROM karyawan k JOIN role r ON r.id = k.role_id JOIN cabang c ON c.id = k.cabang_id
      WHERE r.nama_role <> 'owner' ORDER BY k.status, c.kode, FIELD(r.nama_role,'manager','kasir','operator','kurir'), k.nama`);
}
async function ambilUser(id) {
  const k = await db.queryOne(`SELECT ${KOLOM_USER} FROM karyawan k JOIN role r ON r.id = k.role_id JOIN cabang c ON c.id = k.cabang_id WHERE k.id = ?`, [id]);
  if (!k) throw notFound('User tidak ditemukan');
  if (k.role === 'owner') throw forbidden('Akun owner tidak dikelola di sini');
  return k;
}
async function roleId(role) {
  if (!ROLE_USER.includes(role)) throw badRequest(`Role harus salah satu: ${ROLE_USER.join(', ')}`);
  const r = await db.queryOne('SELECT id FROM role WHERE nama_role = ?', [role]);
  if (!r) throw badRequest('Role tidak dikenal');
  return r.id;
}
async function cekCabang(id) {
  const c = await db.queryOne('SELECT id FROM cabang WHERE id = ?', [id]);
  if (!c) throw badRequest('Cabang tidak valid');
  return Number(id);
}
function bacaHp(v) {
  if (v === undefined) return undefined;
  const hp = normalizeHp(v) || null;
  if (hp && !/^08\d{8,12}$/.test(hp)) throw badRequest('Nomor HP tidak valid (contoh 08123456789)');
  return hp;
}
function bacaJatah(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.round(Number(String(v).replace(/[^\d]/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw badRequest('Nominal jatah cuci tidak valid');
  return n;
}

async function tambahUser(input = {}) {
  const nama = String(input.nama || '').trim();
  const username = String(input.username || '').trim().toLowerCase();
  if (!nama) throw badRequest('Nama wajib diisi');
  if (!username || username.length < 3) throw badRequest('Username minimal 3 karakter');
  if (!/^[a-z0-9._]+$/.test(username)) throw badRequest('Username hanya boleh huruf kecil, angka, titik, underscore');
  if (!input.password || String(input.password).length < 6) throw badRequest('Password minimal 6 karakter');
  const rid = await roleId(String(input.role || ''));
  const cab = await cekCabang(input.cabang_id);
  if (await db.queryOne('SELECT id FROM karyawan WHERE username = ?', [username])) throw conflict('Username sudah dipakai');
  const hash = await bcrypt.hash(String(input.password), BCRYPT_ROUNDS);
  const jatah = bacaJatah(input.jatah_cuci_mingguan);
  const r = await db.query(
    `INSERT INTO karyawan (cabang_id, role_id, nama, telepon, username, password_hash, status, jatah_cuci_mingguan) VALUES (?,?,?,?,?,?, 'aktif', ?)`,
    [cab, rid, nama, bacaHp(input.telepon) || null, username, hash, jatah === undefined ? 20000 : jatah]);
  return ambilUser(r.insertId);
}

async function ubahUser(id, input = {}) {
  await ambilUser(id);
  const set = {};
  if (input.nama !== undefined) { const n = String(input.nama).trim(); if (!n) throw badRequest('Nama wajib diisi'); set.nama = n; }
  if (input.role !== undefined) set.role_id = await roleId(String(input.role));
  if (input.cabang_id !== undefined) set.cabang_id = await cekCabang(input.cabang_id);
  const hp = bacaHp(input.telepon); if (hp !== undefined) set.telepon = hp;
  const jatah = bacaJatah(input.jatah_cuci_mingguan); if (jatah !== undefined) set.jatah_cuci_mingguan = jatah;
  if (input.status !== undefined) {
    if (!['aktif', 'nonaktif'].includes(input.status)) throw badRequest('Status tidak valid');
    set.status = input.status;
  }
  const kol = Object.keys(set);
  if (kol.length) await db.query(`UPDATE karyawan SET ${kol.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...kol.map((k) => set[k]), id]);
  return ambilUser(id);
}

async function resetPassword(id, password) {
  await ambilUser(id);
  if (!password || String(password).length < 6) throw badRequest('Password minimal 6 karakter');
  await db.query('UPDATE karyawan SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(password), BCRYPT_ROUNDS), id]);
  await require('../models/karyawan.model').tandaiPasswordDiubah(Number(id)); // #82: keluar dari semua perangkat
  return { id: Number(id), ok: true };
}

/** Hapus permanen kalau belum pernah dipakai; kalau ada riwayat -> nonaktif. */
async function hapusUser(id) {
  const k = await ambilUser(id);
  const fks = await db.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.key_column_usage
      WHERE referenced_table_name = 'karyawan' AND referenced_column_name = 'id' AND table_schema = DATABASE()`);
  let riwayat = 0;
  for (const f of fks) {
    if (f.t === 'jadwal_shift') continue; // jadwal = pengaturan, ikut dihapus
    const r = await db.queryOne(`SELECT COUNT(*) AS n FROM \`${f.t}\` WHERE \`${f.c}\` = ?`, [id]);
    riwayat += Number(r.n) || 0;
  }
  if (riwayat > 0) {
    await db.query("UPDATE karyawan SET status = 'nonaktif' WHERE id = ?", [id]);
    return { id: Number(id), hasil: 'nonaktif', riwayat, nama: k.nama };
  }
  await db.transaction(async (conn) => {
    await conn.execute('DELETE FROM jadwal_shift WHERE karyawan_id = ?', [id]);
    await conn.execute('DELETE FROM karyawan WHERE id = ?', [id]);
  });
  return { id: Number(id), hasil: 'dihapus', nama: k.nama };
}

/* ------------------------------------------------ investasi (Perubahan #55) */
// Ringkasan per cabang dari Kas Besar sumber 'distribusi' (keluar):
//   2-201 Pengembalian Modal Investor, 2-202 Share Profit Investor, 2-203 Share Profit Operator.
// Rata-rata = 3 bulan terakhir yang ADA pembagian (per COA).
const COA_INV = { modal: '2-201', investor: '2-202', operator: '2-203' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
async function investasi() {
  const cabang = await db.query("SELECT id, kode, nama, status, modal_investasi FROM cabang ORDER BY kode");
  const rows = await db.query(
    `SELECT kb.ref_cabang_id AS cabang_id, c.kode AS coa, DATE_FORMAT(kb.tanggal, '%Y-%m') AS bulan, SUM(kb.nominal) AS nominal
       FROM kas_besar kb JOIN coa c ON c.id = kb.coa_id
      WHERE kb.sumber = 'distribusi' AND kb.jenis = 'keluar' AND c.kode IN (?, ?, ?)
      GROUP BY kb.ref_cabang_id, c.kode, bulan ORDER BY bulan`, [COA_INV.modal, COA_INV.investor, COA_INV.operator]);
  const seri = (cid, coa) => rows.filter((r) => Number(r.cabang_id) === Number(cid) && r.coa === coa && Number(r.nominal) !== 0)
    .map((r) => ({ bulan: r.bulan, nominal: r2(r.nominal) }));
  const ringkas = (s) => {
    const total = r2(s.reduce((a, x) => a + x.nominal, 0));
    const tiga = s.slice(-3);
    const rata = tiga.length ? r2(tiga.reduce((a, x) => a + x.nominal, 0) / tiga.length) : 0;
    return { total, rata3: rata, bulan_rata: tiga.map((x) => x.bulan), per_bulan: s };
  };
  const hasil = cabang.map((c) => {
    const modal = c.modal_investasi == null ? null : Number(c.modal_investasi);
    const m = ringkas(seri(c.id, COA_INV.modal));
    const inv = ringkas(seri(c.id, COA_INV.investor));
    const op = ringkas(seri(c.id, COA_INV.operator));
    const kurang = modal == null ? null : r2(Math.max(0, modal - m.total));
    return {
      cabang_id: c.id, kode: c.kode, nama: c.nama, status: c.status, modal,
      pengembalian: { ...m, kurang, persen: modal ? r2((m.total / modal) * 100) : null,
        perkiraan_bulan_lunas: kurang == null ? null : (kurang === 0 ? 0 : (m.rata3 > 0 ? Math.ceil(kurang / m.rata3) : null)) },
      investor: { ...inv, persen_bulan: modal && inv.rata3 ? r2((inv.rata3 / modal) * 100) : null,
        persen_tahun: modal && inv.rata3 ? r2((inv.rata3 / modal) * 1200) : null },
      operator: op,
    };
  });
  // baris total (gabungan semua cabang yang punya modal)
  const jum = (f) => r2(hasil.reduce((a, h) => a + (Number(f(h)) || 0), 0));
  const modalT = jum((h) => h.modal);
  const kembaliT = jum((h) => h.pengembalian.total); const rataKembaliT = jum((h) => h.pengembalian.rata3);
  const kurangT = jum((h) => h.pengembalian.kurang); const rataInvT = jum((h) => h.investor.rata3);
  const total = {
    modal: modalT, kembali: kembaliT, kurang: kurangT, persen: modalT ? r2((kembaliT / modalT) * 100) : null,
    perkiraan_bulan_lunas: kurangT === 0 ? 0 : (rataKembaliT > 0 ? Math.ceil(kurangT / rataKembaliT) : null),
    investor: jum((h) => h.investor.total), investor_rata3: rataInvT,
    persen_bulan: modalT && rataInvT ? r2((rataInvT / modalT) * 100) : null,
    persen_tahun: modalT && rataInvT ? r2((rataInvT / modalT) * 1200) : null,
    operator: jum((h) => h.operator.total),
  };
  return { cabang: hasil, total };
}

module.exports = {
  investasi,
  dashboard, daftarCabang, ubahCabang, KUNCI_CABANG,
  daftarUser, tambahUser, ubahUser, resetPassword, hapusUser, ROLE_USER,
};
