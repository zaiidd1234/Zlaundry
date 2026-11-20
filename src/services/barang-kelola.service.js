/**
 * src/services/barang-kelola.service.js
 * =============================================================================
 * Perubahan #40 -- Manager › Barang: kelola barang jualan per cabang.
 *  - daftar (aktif + nonaktif, laundry + cafe) + versi foto
 *  - tambah barang baru, ubah harga jual/beli, stok minimum, urutan, status
 *  - stok masuk  : stok_mutasi masuk / 'pembelian' (TIDAK ke Kas Besar)
 *  - stok opname : hitungan fisik, selisih jadi mutasi 'penyesuaian', alasan wajib
 *  - riwayat mutasi stok per barang
 * Foto tetap lewat /api/master/barang/:id/foto (barang-foto.service).
 * =============================================================================
 */

const db = require('../config/database');
const barangModel = require('../models/barang.model');
const stokMutasiModel = require('../models/stok-mutasi.model');
const fotoSvc = require('./barang-foto.service');
const { now } = require('../helpers/date');
const { badRequest, notFound, forbidden } = require('../helpers/errors');

const KATEGORI = ['laundry', 'cafe'];

function angka(v, { min = 0, max = 100000000, bulat = true, label = 'Angka' } = {}) {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} tidak valid`);
  return bulat ? Math.round(n) : n;
}

async function ambil(id, cabangId) {
  const b = await barangModel.findById(id);
  if (!b) throw notFound('Barang tidak ditemukan');
  if (cabangId && Number(b.cabang_id) !== Number(cabangId)) throw forbidden('Barang bukan milik cabang ini');
  return b;
}

function bentuk(b, versi) {
  const stok = Number(b.stok_terkini) || 0;
  const min = Number(b.stok_minimum) || 0;
  return {
    id: b.id, nama: b.nama, kategori: b.kategori || 'laundry', satuan: b.satuan, coa_id: b.coa_id,
    harga_jual: Number(b.harga_jual) || 0, harga_beli: Number(b.harga_beli) || 0,
    stok_terkini: stok, stok_minimum: min, menipis: b.status === 'aktif' && stok <= min,
    status: b.status, urutan: Number(b.urutan) || 0, foto_v: versi ? versi.get(Number(b.id)) || null : null,
  };
}

/** Akun penjualan barang (COA 4-2xx) untuk pilihan saat tambah barang. */
async function opsiCoa() {
  return db.query(`SELECT id, kode, nama FROM coa WHERE kode LIKE '4-2__%' ORDER BY kode`);
}

async function daftar(cabangId) {
  const [rows, versi, coa] = await Promise.all([
    barangModel.findByCabang(cabangId, { includeNonaktif: true }),
    fotoSvc.versiPerCabang(cabangId),
    opsiCoa().catch(() => []),
  ]);
  return { barang: rows.map((b) => bentuk(b, versi)), coa };
}

/** Akun penjualan default: yang paling sering dipakai barang sekategori di cabang ini. */
async function coaDefault(cabangId, kategori) {
  const r = await db.queryOne(
    `SELECT coa_id FROM barang WHERE cabang_id = ? AND kategori = ? GROUP BY coa_id ORDER BY COUNT(*) DESC LIMIT 1`, [cabangId, kategori]);
  if (r) return r.coa_id;
  const c = await db.queryOne(`SELECT id FROM coa WHERE kode = ? LIMIT 1`, [kategori === 'cafe' ? '4-205' : '4-201']);
  return c ? c.id : null;
}

function bacaInput(input, lama = {}) {
  const nama = String(input.nama ?? lama.nama ?? '').trim();
  if (!nama) throw badRequest('Nama barang wajib diisi');
  if (nama.length > 100) throw badRequest('Nama barang maksimal 100 huruf');
  const kategori = String(input.kategori ?? lama.kategori ?? 'laundry');
  if (!KATEGORI.includes(kategori)) throw badRequest('Kategori harus laundry / cafe');
  const satuan = String(input.satuan ?? lama.satuan ?? 'pcs').trim() || 'pcs';
  if (satuan.length > 20) throw badRequest('Satuan maksimal 20 huruf');
  const status = String(input.status ?? lama.status ?? 'aktif');
  if (!['aktif', 'nonaktif'].includes(status)) throw badRequest('Status tidak valid');
  return {
    nama, kategori, satuan, status,
    harga_jual: angka(input.harga_jual ?? lama.harga_jual, { label: 'Harga jual' }),
    harga_beli: angka(input.harga_beli ?? lama.harga_beli ?? 0, { label: 'Harga beli' }),
    stok_minimum: angka(input.stok_minimum ?? lama.stok_minimum ?? 0, { max: 1000000, label: 'Stok minimum' }),
    urutan: angka(input.urutan ?? lama.urutan ?? 100, { max: 100000, label: 'Urutan' }),
  };
}

async function tambah(cabangId, input = {}, karyawanId) {
  const d = bacaInput(input);
  let coaId = input.coa_id ? Number(input.coa_id) : await coaDefault(cabangId, d.kategori);
  if (input.coa_id) {
    const c = await db.queryOne(`SELECT id FROM coa WHERE id = ? AND kode LIKE '4-2__%'`, [coaId]);
    if (!c) throw badRequest('Akun penjualan tidak valid');
  }
  if (!coaId) throw badRequest('Akun penjualan belum ada, pilih akun penjualan');
  const stokAwal = angka(input.stok_awal ?? 0, { max: 1000000, label: 'Stok awal' });
  const id = await db.transaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO barang (cabang_id, coa_id, nama, kategori, urutan, satuan, harga_beli, harga_jual, stok_terkini, stok_minimum, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cabangId, coaId, d.nama, d.kategori, d.urutan, d.satuan, d.harga_beli, d.harga_jual, stokAwal, d.stok_minimum, d.status]);
    if (stokAwal > 0) {
      await stokMutasiModel.create({
        barang_id: r.insertId, cabang_id: cabangId, jenis: 'masuk', qty: stokAwal, ref_tipe: 'pembelian', ref_id: null,
        stok_sebelum: 0, stok_sesudah: stokAwal, karyawan_id: karyawanId, waktu: now(), keterangan: 'Stok awal (barang baru)',
      }, conn);
    }
    return r.insertId;
  });
  return bentuk(await barangModel.findById(id));
}

async function ubah(id, cabangId, input = {}) {
  const lama = await ambil(id, cabangId);
  const d = bacaInput(input, lama);
  await db.pool.execute(
    `UPDATE barang SET nama = ?, kategori = ?, satuan = ?, harga_jual = ?, harga_beli = ?, stok_minimum = ?, urutan = ?, status = ? WHERE id = ?`,
    [d.nama, d.kategori, d.satuan, d.harga_jual, d.harga_beli, d.stok_minimum, d.urutan, d.status, id]);
  const versi = await fotoSvc.versiPerCabang(lama.cabang_id);
  return bentuk(await barangModel.findById(id), versi);
}

async function stokMasuk(id, cabangId, input = {}, karyawanId) {
  const b = await ambil(id, cabangId);
  const qty = angka(input.qty, { min: 1, max: 1000000, label: 'Jumlah masuk' });
  const ket = String(input.keterangan || '').trim().slice(0, 200);
  await db.transaction(async (conn) => {
    const sebelum = await barangModel.getStokLocked(conn, id);
    const sesudah = sebelum + qty;
    await stokMutasiModel.create({
      barang_id: id, cabang_id: b.cabang_id, jenis: 'masuk', qty, ref_tipe: 'pembelian', ref_id: null,
      stok_sebelum: sebelum, stok_sesudah: sesudah, karyawan_id: karyawanId, waktu: now(),
      keterangan: `Stok masuk${ket ? `: ${ket}` : ''}`,
    }, conn);
    await barangModel.setStok(conn, id, sesudah);
  });
  return bentuk(await barangModel.findById(id), await fotoSvc.versiPerCabang(b.cabang_id));
}

async function opname(id, cabangId, input = {}, karyawanId) {
  const b = await ambil(id, cabangId);
  const fisik = angka(input.stok_fisik, { max: 1000000, label: 'Hitungan fisik' });
  const alasan = String(input.alasan || '').trim();
  if (!alasan) throw badRequest('Alasan stok opname wajib diisi');
  let selisih = 0;
  await db.transaction(async (conn) => {
    const sebelum = await barangModel.getStokLocked(conn, id);
    selisih = fisik - sebelum;
    if (selisih === 0) return;
    await stokMutasiModel.create({
      barang_id: id, cabang_id: b.cabang_id, jenis: selisih > 0 ? 'masuk' : 'keluar', qty: Math.abs(selisih),
      ref_tipe: 'penyesuaian', ref_id: null, stok_sebelum: sebelum, stok_sesudah: fisik, karyawan_id: karyawanId, waktu: now(),
      keterangan: `Opname ${sebelum}→${fisik}: ${alasan.slice(0, 200)}`,
    }, conn);
    await barangModel.setStok(conn, id, fisik);
  });
  const out = bentuk(await barangModel.findById(id), await fotoSvc.versiPerCabang(b.cabang_id));
  return { ...out, selisih };
}

async function mutasi(id, cabangId, limit = 50) {
  await ambil(id, cabangId);
  const rows = await db.query(
    `SELECT m.id, m.jenis, m.qty, m.ref_tipe, m.stok_sebelum, m.stok_sesudah, m.waktu, m.keterangan, k.nama AS karyawan
       FROM stok_mutasi m LEFT JOIN karyawan k ON k.id = m.karyawan_id
      WHERE m.barang_id = ? ORDER BY m.waktu DESC, m.id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`, [id]);
  return rows.map((r) => ({
    id: r.id, jenis: r.jenis, qty: Number(r.qty), ref_tipe: r.ref_tipe, sebelum: Number(r.stok_sebelum), sesudah: Number(r.stok_sesudah),
    waktu: r.waktu, keterangan: r.keterangan, karyawan: r.karyawan,
  }));
}

module.exports = { daftar, tambah, ubah, stokMasuk, opname, mutasi };
