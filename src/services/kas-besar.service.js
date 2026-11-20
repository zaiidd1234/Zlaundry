/**
 * src/services/kas-besar.service.js
 * =============================================================================
 * Kas Besar untuk MANAGER (scope 1 cabang):
 *   - ringkas(cabangId, range): saldo kas besar cabang + laba-rugi periode
 *   - setoran(cabangId, range): riwayat setoran masuk dari kasir (+bukti)
 *   - kategoriBeban(): COA yang boleh dipilih manager (belanja_manager=1)
 *   - inputBeban(cabangId, {coa_id, nominal, keterangan}): catat beban OPEX
 *     (kas_besar keluar, sumber 'opex')
 *   - riwayatBeban(cabangId, range): daftar beban OPEX
 * =============================================================================
 */

const db = require('../config/database');
const kasBesarModel = require('../models/kas-besar.model');
const laporanService = require('./laporan.service');
const { now, today, resolveTanggal } = require('../helpers/date');
const { badRequest } = require('../helpers/errors');

function defaultRange() {
  const t = today();
  return { dari: `${t.slice(0, 7)}-01`, sampai: t };
}

/** Saldo kas besar cabang + laba-rugi periode + daftar bulan tersedia. */
async function ringkas(cabangId, range = {}) {
  const r = { ...defaultRange(), ...range };
  const [saldoTotal, teralokasi, lr, bulanList, distribusi] = await Promise.all([
    kasBesarModel.saldoCabang(cabangId, { sampai: r.sampai }),
    kasBesarModel.saldoTeralokasi(cabangId, { sampai: r.sampai }),
    laporanService.labaRugi(cabangId, r),
    kasBesarModel.bulanTersedia(cabangId),
    kasBesarModel.distribusiLaba(cabangId, { dari: r.dari, sampai: r.sampai }),
  ]);
  const bebas = Math.round((saldoTotal - teralokasi) * 100) / 100;
  // Perubahan #83: dana Kios-K yang masih di Winpay (belum ditarik)
  const winpay = await require('./kas-winpay.service').hitungSaldo(cabangId).catch(() => null);
  const distArr = distribusi.map((d) => ({ coa_id: d.coa_id, kode: d.coa_kode, nama: d.coa_nama, nominal: Number(d.nominal) || 0 }));
  const totalDistribusi = distArr.reduce((s, d) => s + d.nominal, 0);
  return {
    saldo_kas_besar: saldoTotal,
    saldo_total: saldoTotal,
    saldo_teralokasi: teralokasi,
    saldo_bebas: bebas,
    saldo_winpay: winpay ? winpay.saldo : 0,
    periode: r,
    bulan_tersedia: bulanList,
    laba_rugi: {
      pendapatan: lr.pendapatan,
      hpp: lr.cogs,
      cos: lr.cos,
      opex: lr.opex,
      laba_kotor: lr.laba_kotor,
      laba_bersih: lr.laba_bersih,
      rincian: lr.rincian || null,
    },
    distribusi: { total: totalDistribusi, rincian: distArr, sisa_laba: Math.round((lr.laba_bersih - totalDistribusi) * 100) / 100 },
  };
}

/** Riwayat setoran masuk (dari kasir) dalam periode. */
async function setoran(cabangId, range = {}) {
  const r = { ...defaultRange(), ...range };
  const rows = await kasBesarModel.setoranMasuk(cabangId, { dari: r.dari, sampai: r.sampai, limit: 100 });
  return rows.map((s) => ({
    transfer_id: s.transfer_id,
    id_transfer: s.id_transfer,
    tanggal: s.tanggal,
    nominal_transfer: Number(s.nominal_transfer) || 0,
    total_pendapatan: Number(s.total_pendapatan) || 0,
    total_reimburse: Number(s.total_reimburse) || 0,
    jumlah_transaksi: Number(s.jumlah_transaksi) || 0,
    bukti_url: s.bukti_url || null,
  }));
}

/** COA yang boleh dipilih manager saat input beban (belanja_manager=1). */
async function kategoriBeban() {
  const rows = await db.query(
    `SELECT id, kode, nama, tipe FROM coa WHERE belanja_manager = 1 ORDER BY kode ASC`
  );
  return rows.map((c) => ({ id: c.id, kode: c.kode, nama: c.nama, tipe: c.tipe }));
}

/** Catat beban OPEX manager: kas_besar keluar, sumber 'opex'. */
async function inputBeban(cabangId, { coa_id, nominal, keterangan, bukti_url, tanggal }, { kasirId }) {
  const nom = Number(nominal);
  if (!coa_id) throw badRequest('Kategori beban wajib dipilih');
  if (!nom || nom <= 0) throw badRequest('Nominal harus lebih dari 0');
  // validasi coa termasuk yang boleh dikelola manager
  const ok = await db.queryOne(`SELECT id, nama FROM coa WHERE id = ? AND belanja_manager = 1 LIMIT 1`, [coa_id]);
  if (!ok) throw badRequest('Kategori beban tidak valid');

  const id = await kasBesarModel.insert({
    transfer_id: null, tanggal: resolveTanggal(tanggal), jenis: 'keluar', coa_id, nominal: nom,
    sumber: 'opex', ref_cabang_id: cabangId, bukti_url: bukti_url || null,
    karyawan_id: kasirId, keterangan: keterangan || ok.nama,
  });
  return { id, coa_id, nominal: nom, keterangan: keterangan || ok.nama };
}

/** Riwayat beban OPEX dalam periode. */
async function riwayatBeban(cabangId, range = {}) {
  const r = { ...defaultRange(), ...range };
  const rows = await kasBesarModel.bebanOpex(cabangId, { dari: r.dari, sampai: r.sampai, limit: 100 });
  return rows.map((b) => ({
    id: b.id, tanggal: b.tanggal, coa_id: b.coa_id,
    coa_kode: b.coa_kode, coa_nama: b.coa_nama,
    nominal: Number(b.nominal) || 0, keterangan: b.keterangan, bukti_url: b.bukti_url || null,
  }));
}

/** COA beban yang bisa diakrualkan (sewa, internet, dll yg belanja_manager=1 di grup OPEX/COS). */
async function kategoriAkrual() {
  const rows = await db.query(
    `SELECT id, kode, nama, tipe FROM coa
     WHERE belanja_manager = 1 AND tipe = 'beban' ORDER BY kode ASC`
  );
  return rows.map((c) => ({ id: c.id, kode: c.kode, nama: c.nama, tipe: c.tipe }));
}

/** Catat beban akrual: kas_besar keluar, sumber 'akrual', COA beban, tanggal akhir bulan dipilih. */
async function inputAkrual(cabangId, { coa_id, nominal, keterangan, bulan }, { kasirId }) {
  const nom = Number(nominal);
  if (!coa_id) throw badRequest('Kategori beban akrual wajib dipilih');
  if (!nom || nom <= 0) throw badRequest('Nominal harus lebih dari 0');
  const ok = await db.queryOne(`SELECT id, nama FROM coa WHERE id = ? AND tipe='beban' LIMIT 1`, [coa_id]);
  if (!ok) throw badRequest('Kategori akrual tidak valid');

  // tanggal akrual = akhir bulan dipilih (atau hari ini kalau tidak diisi)
  let tgl;
  if (/^\d{4}-\d{2}$/.test(String(bulan || ''))) {
    const [y, m] = bulan.split('-').map(Number);
    const akhir = new Date(Date.UTC(y, m, 0)).getUTCDate();
    tgl = `${bulan}-${String(akhir).padStart(2, '0')} 23:55:00`;
  } else {
    tgl = now();
  }

  const id = await kasBesarModel.insert({
    transfer_id: null, tanggal: tgl, jenis: 'keluar', coa_id, nominal: nom,
    sumber: 'akrual', ref_cabang_id: cabangId, bukti_url: null,
    karyawan_id: kasirId, keterangan: keterangan || `Akrual ${ok.nama}`,
  });
  return { id, coa_id, nominal: nom, akrual: true };
}

/** Detail record (untuk expand di UI). sisi: pendapatan|beban, opsional coaId. */
async function detailRecord(cabangId, { sisi, coaId, ...range }) {
  const r = { ...defaultRange(), ...range };
  const rows = await kasBesarModel.recordLabaRugi(cabangId, {
    dari: r.dari, sampai: r.sampai, sisi, coaId: coaId || null,
  });
  return rows.map((x) => ({
    id: x.id, tanggal: x.tanggal, coa_id: x.coa_id, coa_kode: x.coa_kode, coa_nama: x.coa_nama,
    nominal: Number(x.nominal) || 0, sumber: x.sumber, keterangan: x.keterangan, bukti_url: x.bukti_url || null,
  }));
}

/** Data lengkap untuk export Excel (2 sheet: laba-rugi + record mentah). */
async function dataExport(cabangId, range = {}) {
  const r = { ...defaultRange(), ...range };
  const [ringkasData, pendapatan, beban] = await Promise.all([
    ringkas(cabangId, r),
    kasBesarModel.recordLabaRugi(cabangId, { dari: r.dari, sampai: r.sampai, sisi: 'pendapatan' }),
    kasBesarModel.recordLabaRugi(cabangId, { dari: r.dari, sampai: r.sampai, sisi: 'beban' }),
  ]);
  return { ringkas: ringkasData, pendapatan, beban, periode: r };
}

/** COA kewajiban investasi untuk distribusi laba (id 12-15, di bawah Kewajiban Investasi). */
async function kategoriDistribusi() {
  const rows = await db.query(
    `SELECT id, kode, nama FROM coa
     WHERE tipe='kewajiban' AND belanja_manager = 1 ORDER BY kode ASC`
  );
  return rows.map((c) => ({ id: c.id, kode: c.kode, nama: c.nama }));
}

/** Catat distribusi laba: kas_besar keluar, sumber 'distribusi' (kurangi saldo total, bukan beban). */
async function inputDistribusi(cabangId, { coa_id, nominal, keterangan, bulan }, { kasirId }) {
  const nom = Number(nominal);
  if (!coa_id) throw badRequest('Akun distribusi wajib dipilih');
  if (!nom || nom <= 0) throw badRequest('Nominal harus lebih dari 0');
  const ok = await db.queryOne(`SELECT id, nama FROM coa WHERE id = ? AND tipe='kewajiban' LIMIT 1`, [coa_id]);
  if (!ok) throw badRequest('Akun distribusi tidak valid');

  let tgl;
  if (/^\d{4}-\d{2}$/.test(String(bulan || ''))) {
    const [y, m] = bulan.split('-').map(Number);
    const akhir = new Date(Date.UTC(y, m, 0)).getUTCDate();
    tgl = `${bulan}-${String(akhir).padStart(2, '0')} 23:50:00`;
  } else { tgl = now(); }

  const id = await kasBesarModel.insert({
    transfer_id: null, tanggal: tgl, jenis: 'keluar', coa_id, nominal: nom,
    sumber: 'distribusi', ref_cabang_id: cabangId, bukti_url: null,
    karyawan_id: kasirId, keterangan: keterangan || `Distribusi ${ok.nama}`,
  });
  return { id, coa_id, nominal: nom, distribusi: true };
}

module.exports = { ringkas, setoran, kategoriBeban, inputBeban, riwayatBeban, kategoriAkrual, inputAkrual, detailRecord, dataExport, kategoriDistribusi, inputDistribusi };
