/**
 * src/services/kas.service.js
 * =============================================================================
 * Operasi kas_kecil. Untuk Fase 4 baru: catat pendapatan saat transaksi dibayar.
 * (belanja_ops, konversi, setor menyusul di fase keuangan.)
 *
 * catatPendapatanTransaksi(conn, { transaksi, items, akun, metode, kasirId, tanggal }):
 *   insert 1 baris kas_kecil 'pendapatan' per item, coa diambil dari katalog
 *   (layanan/barang). Dipanggil dari dalam transaksi pembayaran.
 * =============================================================================
 */

const db = require('../config/database');
const kasKecilModel = require('../models/kas-kecil.model');
const layananModel = require('../models/layanan.model');
const barangModel = require('../models/barang.model');
const { today, now, resolveTanggal } = require('../helpers/date');
const { badRequest } = require('../helpers/errors');

const COA_OPEX_ROOT = Number(process.env.COA_OPEX_ROOT) || 7;
const COA_ADMIN_TOPUP = Number(process.env.COA_ADMIN_TOPUP_GOPAY) || 41; // COS: Admin Topup Gopay

/** Ambil coa_id untuk sebuah item (jasa -> layanan.coa_id, barang -> barang.coa_id).
 *  Khusus layanan mesin: pisahkan cuci (COA 55 = 4-101A) vs kering (COA 56 = 4-101B)
 *  agar laba rugi bisa split pendapatan washer dan dryer. */
async function coaItem(item) {
  if (item.item_tipe === 'jasa') {
    const L = await layananModel.findById(item.layanan_id);
    if (!L) return null;
    // Split mesin cuci vs kering
    if (L.kategori === 'cuci')   return 55; // 4-101A Jasa Mesin Cuci (Washer)
    if (L.kategori === 'kering') return 56; // 4-101B Jasa Mesin Kering (Dryer)
    return L.coa_id;
  }
  const B = await barangModel.findById(item.barang_id);
  return B ? B.coa_id : null;
}

async function catatPendapatanTransaksi(conn, { transaksi, items, akun, metode, kasirId, tanggal }) {
  for (const it of items) {
    const coa_id = await coaItem(it);
    await kasKecilModel.insert({
      cabang_id: transaksi.cabang_id,
      tanggal,
      akun,                          // cash | gopay (ikut metode bayar)
      jenis: 'masuk',
      jenis_mutasi: 'pendapatan',
      coa_id,
      ref_transaksi_id: transaksi.id,
      ref_detail_transaksi_id: it.id,
      qty: it.qty,
      harga_satuan: it.harga_satuan,
      nominal: it.subtotal,
      metode_asal: metode,
      karyawan_id: kasirId,
      keterangan: `${it.nama_item} - ${transaksi.no_invoice}`,
    }, conn);
  }
}

/* ---------- KAS KECIL (layar kasir) ---------- */

const LABEL_MUTASI = {
  modal: 'Modal', pendapatan: 'Pendapatan', konversi: 'Konversi',
  belanja_ops: 'Belanja Operasional', setor: 'Setoran', reimburse: 'Reimburse',
  biaya_loyalty: 'Biaya Loyalty/Promo',
};

/** Saldo + daftar mutasi hari ini (atau tanggal tertentu) + rekap per hari (bulan berjalan). */
async function ringkasKas(cabangId, ymd) {
  const tgl = ymd || today();
  const dari = `${tgl.slice(0, 7)}-01`;
  const [saldo, mutasiRows, rekapRows] = await Promise.all([
    kasKecilModel.saldo(cabangId),
    kasKecilModel.mutasiHarian(cabangId, tgl),
    kasKecilModel.rekapHarian(cabangId, dari, tgl),
  ]);
  const mutasi = mutasiRows.map((m) => ({
    id: m.id,
    tanggal: m.tanggal,
    akun: m.akun,
    jenis: m.jenis,
    jenis_mutasi: m.jenis_mutasi,
    jenis_label: LABEL_MUTASI[m.jenis_mutasi] || m.jenis_mutasi,
    nominal: Number(m.nominal) || 0,
    keterangan: m.keterangan,
  }));
  const rekap_harian = rekapRows.map((r) => ({
    tanggal   : String(r.tanggal).slice(0, 10),
    jml       : Number(r.jml)        || 0,
    masuk     : Number(r.masuk)      || 0,
    keluar    : Number(r.keluar)     || 0,
    pendapatan: Number(r.pendapatan) || 0,
    belanja   : Number(r.belanja)    || 0,
    reimburse : Number(r.reimburse)  || 0,
    setor     : Number(r.setor)      || 0,
    biaya_loyalty: Number(r.biaya_loyalty) || 0,
  }));
  return { tanggal: tgl, saldo, mutasi, rekap_harian };
}

/** Detail mutasi 1 tanggal (untuk expand card). */
async function mutasiTanggal(cabangId, ymd) {
  const rows = await kasKecilModel.mutasiHarian(cabangId, ymd);
  return rows.map((m) => ({
    id: m.id, tanggal: m.tanggal, akun: m.akun, jenis: m.jenis,
    jenis_mutasi: m.jenis_mutasi, jenis_label: LABEL_MUTASI[m.jenis_mutasi] || m.jenis_mutasi,
    nominal: Number(m.nominal) || 0, keterangan: m.keterangan,
    transfer_id: m.transfer_id || null,
  }));
}

/** Kategori beban operasional. Deteksi grup OPEX/Beban secara fleksibel. */
async function kategoriBeban() {
  // data-driven: COA yang boleh dipilih kasir saat catat belanja (kolom belanja_kasir=1)
  const rows = await db.query(
    `SELECT id, kode, nama, tipe, parent_id FROM coa WHERE belanja_kasir = 1 ORDER BY kode ASC`
  );
  return rows.map((c) => ({ id: c.id, kode: c.kode, nama: c.nama, tipe: c.tipe }));
}

/** Catat belanja operasional (uang keluar dari kas kecil). */
async function catatBelanja(cabangId, { akun, coa_id, nominal, keterangan, tanggal }, { kasirId }) {
  const ak = akun === 'gopay' ? 'gopay' : 'cash';
  const nom = Number(nominal) || 0;
  if (nom <= 0) throw badRequest('Nominal belanja harus lebih dari 0');
  if (!coa_id) throw badRequest('Kategori belanja wajib dipilih');

  // pastikan saldo cukup
  const saldoAk = await kasKecilModel.saldoAkun(cabangId, ak);
  if (nom > Number(saldoAk)) throw badRequest(`Saldo ${ak === 'gopay' ? 'Gopay' : 'Cash'} tidak cukup (tersedia ${saldoAk})`);

  const id = await kasKecilModel.insert({
    cabang_id: cabangId,
    tanggal: resolveTanggal(tanggal),
    akun: ak,
    jenis: 'keluar',
    jenis_mutasi: 'belanja_ops',
    coa_id: Number(coa_id),
    nominal: nom,
    karyawan_id: kasirId,
    keterangan: keterangan || null,
  });
  return { id };
}

/**
 * Top Up Gopay di Indomaret: cash dipakai untuk isi saldo gopay.
 * - pokok: pindah aset cash->gopay (jenis_mutasi='konversi', tanpa COA beban)
 * - admin (opsional): beban nyata -> COA Admin Topup Gopay (id41)
 * Total cash keluar = pokok + admin. Gopay masuk = pokok.
 */
async function topupGopay(cabangId, { pokok, admin = 0, keterangan, tanggal }, { kasirId }) {
  const nomPokok = Number(pokok) || 0;
  const nomAdmin = Number(admin) || 0;
  if (nomPokok <= 0) throw badRequest('Nominal topup harus lebih dari 0');
  if (nomAdmin < 0) throw badRequest('Biaya admin tidak boleh negatif');

  const totalCashKeluar = nomPokok + nomAdmin;
  const saldoCash = await kasKecilModel.saldoAkun(cabangId, 'cash');
  if (totalCashKeluar > Number(saldoCash)) {
    throw badRequest(`Saldo Cash tidak cukup (tersedia ${saldoCash}, butuh ${totalCashKeluar})`);
  }

  const tgl = resolveTanggal(tanggal);
  const ket = keterangan || 'Top Up Gopay di Indomaret';

  return db.transaction(async (conn) => {
    // 1) pokok: cash keluar (konversi, tanpa COA)
    await kasKecilModel.insert({
      cabang_id: cabangId, tanggal: tgl, akun: 'cash', jenis: 'keluar',
      jenis_mutasi: 'konversi', coa_id: null, nominal: nomPokok,
      karyawan_id: kasirId, keterangan: ket,
    }, conn);
    // 2) pokok: gopay masuk (konversi)
    await kasKecilModel.insert({
      cabang_id: cabangId, tanggal: tgl, akun: 'gopay', jenis: 'masuk',
      jenis_mutasi: 'konversi', coa_id: null, nominal: nomPokok,
      karyawan_id: kasirId, keterangan: ket,
    }, conn);
    // 3) admin (kalau ada): cash keluar -> beban COA admin topup
    if (nomAdmin > 0) {
      await kasKecilModel.insert({
        cabang_id: cabangId, tanggal: tgl, akun: 'cash', jenis: 'keluar',
        jenis_mutasi: 'belanja_ops', coa_id: COA_ADMIN_TOPUP, nominal: nomAdmin,
        karyawan_id: kasirId, keterangan: 'Biaya admin topup Gopay',
      }, conn);
    }
    return { pokok: nomPokok, admin: nomAdmin, total_cash_keluar: totalCashKeluar };
  });
}

module.exports = { coaItem, catatPendapatanTransaksi, ringkasKas, mutasiTanggal, kategoriBeban, catatBelanja, topupGopay };
