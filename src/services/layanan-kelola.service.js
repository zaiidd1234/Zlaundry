/**
 * src/services/layanan-kelola.service.js
 * =============================================================================
 * Perubahan #58 -- Manager › Layanan & Barang › tab Layanan.
 *  - daftar(cabangId): semua layanan cabang (termasuk promo & nonaktif).
 *  - ubahStatus(id, cabangId, status): ON/OFF layanan. HANYA OWNER (dibuka
 *    lewat web manager dengan pilihan cabang). Manager hanya melihat.
 *  - Pengaman: minimal 1 Cuci reguler (bukan promo) & 1 Kering tetap aktif.
 *  - Efek: kasir & customer sudah hanya menampilkan layanan aktif -> layanan
 *    off hilang untuk pesanan BARU; pesanan yang sudah ada tidak berubah.
 *  Tidak ada log (keputusan owner 2 Nov 2026). Harga tidak diubah dari sini.
 * =============================================================================
 */
const db = require('../config/database');
const { badRequest, conflict, notFound } = require('../helpers/errors');

const KOLOM = `id, cabang_id, coa_id, nama_paket, deskripsi, kategori, satuan_hitung, harga, harga_promo, berat_maks, durasi_menit,
  pakai_mesin, is_promo, jenis_promo, tanggal_mulai, tanggal_selesai, status`;
const URUT = "FIELD(kategori,'cuci','kering','lipat','setrika_lipat','drop_off','antar','antar_jemput','jemput'), is_promo, COALESCE(berat_maks, 0), durasi_menit, harga, id";

async function daftar(cabangId) {
  return db.query(`SELECT ${KOLOM} FROM layanan WHERE cabang_id = ? ORDER BY ${URUT}`, [cabangId]);
}

async function ubahStatus(id, cabangId, status) {
  if (!['aktif', 'nonaktif'].includes(status)) throw badRequest('Status harus aktif / nonaktif');
  const l = await db.queryOne(`SELECT ${KOLOM} FROM layanan WHERE id = ?`, [id]);
  if (!l || Number(l.cabang_id) !== Number(cabangId)) throw notFound('Layanan tidak ditemukan di cabang ini');
  if (l.status === status) return l;
  if (status === 'nonaktif' && (l.kategori === 'kering' || (l.kategori === 'cuci' && !Number(l.is_promo)))) {
    const sisa = await db.queryOne(
      `SELECT COUNT(*) AS n FROM layanan WHERE cabang_id = ? AND kategori = ? AND status = 'aktif' AND id <> ?
         ${l.kategori === 'cuci' ? 'AND is_promo = 0' : ''}`, [cabangId, l.kategori, id]);
    if (!Number(sisa.n)) {
      throw conflict(l.kategori === 'cuci'
        ? 'Minimal 1 layanan Cuci reguler harus tetap aktif'
        : 'Minimal 1 layanan Kering harus tetap aktif');
    }
  }
  await db.query('UPDATE layanan SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
  return { ...l, status };
}

/* ---------------------------------------------------- Perubahan #59 */
// Tambah & edit layanan -- HANYA OWNER. Kategori & satuan dikunci setelah dibuat.
// Durasi Cuci & Kering yang sudah ada DIKUNCI (dipakai timer mesin & antrian otomatis);
// durasi hanya diisi saat tambah. Promo: hanya harga & deskripsi. Tidak ada hapus (cukup off).
const KATEGORI = {
  cuci: { satuan: 'per_load', mesin: 1, coa: '4-101', durasi: 'wajib' },
  kering: { satuan: 'per_load', mesin: 1, coa: '4-101', durasi: 'wajib' },
  drop_off: { satuan: 'per_load', mesin: 0, coa: '4-102' },
  lipat: { satuan: 'per_kg', mesin: 0, coa: '4-103' },
  setrika_lipat: { satuan: 'per_kg', mesin: 0, coa: '4-104' },
  antar: { satuan: 'per_km', mesin: 0, coa: '4-105', durasi: 'boleh' },
  antar_jemput: { satuan: 'per_km', mesin: 0, coa: '4-106', durasi: 'boleh' },
  jemput: { satuan: 'per_km', mesin: 0, coa: '4-106', durasi: 'boleh' }, // Perubahan #73
};
function angka(v, { label, min = 0, max = 1e9, bulat = false, kosong = false, ribuan = false }) {
  if ((v === '' || v === null || v === undefined) && kosong) return null;
  let t = String(v ?? '').trim();
  if (ribuan) t = t.replace(/\./g, ''); // "10.000" -> 10000 (harga)
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} tidak valid`);
  return bulat ? Math.round(n) : n;
}
function teks(v, { label, max, wajib = false }) {
  const t = String(v ?? '').trim();
  if (wajib && !t) throw badRequest(`${label} wajib diisi`);
  if (t.length > max) throw badRequest(`${label} maksimal ${max} huruf`);
  return t || null;
}
async function cekNamaUnik(cabangId, nama, kecualiId = 0) {
  const ada = await db.queryOne('SELECT id FROM layanan WHERE cabang_id = ? AND LOWER(nama_paket) = LOWER(?) AND id <> ? LIMIT 1', [cabangId, nama, kecualiId]);
  if (ada) throw conflict('Nama layanan sudah dipakai di cabang ini');
}
async function tambah(cabangId, input = {}) {
  const k = String(input.kategori || '');
  const K = KATEGORI[k];
  if (!K) throw badRequest('Kategori layanan tidak valid');
  const nama = teks(input.nama_paket, { label: 'Nama layanan', max: 100, wajib: true });
  await cekNamaUnik(cabangId, nama);
  const harga = angka(input.harga, { label: 'Harga', max: 1e8, ribuan: true });
  const durasi = K.durasi ? angka(input.durasi_menit, { label: 'Durasi', min: 1, max: 600, bulat: true, kosong: K.durasi !== 'wajib' }) : null;
  const berat = k === 'cuci' ? angka(input.berat_maks, { label: 'Berat maks', min: 0.1, max: 200, kosong: true }) : null;
  const deskripsi = teks(input.deskripsi, { label: 'Deskripsi', max: 255 });
  const status = input.status === 'nonaktif' ? 'nonaktif' : 'aktif';
  // akun pendapatan: sama dengan layanan sekategori yang sudah ada, kalau belum ada -> kode COA standar
  const coa = await db.queryOne('SELECT coa_id FROM layanan WHERE kategori = ? AND coa_id IS NOT NULL GROUP BY coa_id ORDER BY COUNT(*) DESC LIMIT 1', [k])
    || await db.queryOne('SELECT id AS coa_id FROM coa WHERE kode = ? LIMIT 1', [K.coa]);
  const r = await db.query(
    `INSERT INTO layanan (cabang_id, coa_id, nama_paket, deskripsi, kategori, satuan_hitung, harga, berat_maks, durasi_menit, pakai_mesin, is_promo, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    [cabangId, coa ? coa.coa_id : null, nama, deskripsi, k, K.satuan, harga, berat, durasi, K.mesin, status]);
  return db.queryOne(`SELECT ${KOLOM} FROM layanan WHERE id = ?`, [r.insertId]);
}
async function ubah(id, cabangId, input = {}) {
  const l = await db.queryOne(`SELECT ${KOLOM} FROM layanan WHERE id = ?`, [id]);
  if (!l || Number(l.cabang_id) !== Number(cabangId)) throw notFound('Layanan tidak ditemukan di cabang ini');
  const promo = !!Number(l.is_promo);
  const K = KATEGORI[l.kategori] || {};
  const set = {};
  if (input.harga !== undefined) set.harga = angka(input.harga, { label: 'Harga', max: 1e8, ribuan: true });
  if (input.deskripsi !== undefined) set.deskripsi = teks(input.deskripsi, { label: 'Deskripsi', max: 255 });
  if (!promo) {
    if (input.nama_paket !== undefined) {
      set.nama_paket = teks(input.nama_paket, { label: 'Nama layanan', max: 100, wajib: true });
      await cekNamaUnik(cabangId, set.nama_paket, id);
    }
    if (input.berat_maks !== undefined && l.kategori === 'cuci') set.berat_maks = angka(input.berat_maks, { label: 'Berat maks', min: 0.1, max: 200, kosong: true });
    // durasi: Cuci & Kering dikunci (timer mesin); antar / antar jemput boleh
    if (input.durasi_menit !== undefined && K.durasi === 'boleh') set.durasi_menit = angka(input.durasi_menit, { label: 'Durasi', min: 1, max: 600, bulat: true, kosong: true });
    if (input.durasi_menit !== undefined && K.durasi === 'wajib' && Number(input.durasi_menit) !== Number(l.durasi_menit)) {
      throw badRequest('Durasi Cuci / Kering dikunci (dipakai timer mesin). Buat layanan baru kalau perlu durasi lain.');
    }
  }
  const kol = Object.keys(set);
  if (kol.length) await db.query(`UPDATE layanan SET ${kol.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`, [...kol.map((c) => set[c]), id]);
  return db.queryOne(`SELECT ${KOLOM} FROM layanan WHERE id = ?`, [id]);
}

module.exports = { daftar, ubahStatus, tambah, ubah, KATEGORI };
