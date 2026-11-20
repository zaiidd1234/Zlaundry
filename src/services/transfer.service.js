/**
 * src/services/transfer.service.js
 * =============================================================================
 * Proses SETOR kasir -> management. Dalam 1 transaksi DB:
 *   1. Ambil transaksi lunas belum_setor (FIFO).
 *   2. Hitung saldo gopay & cash. Karena setoran lewat gopay (QRIS), cash
 *      dikonversi dulu ke gopay (catat 2 baris kas_kecil 'konversi').
 *   3. Pilih transaksi UTUH yang akumulasinya <= saldo gopay (transfer-calc).
 *   4. net = total_pendapatan - total_reimburse (reimburse data historis = 0).
 *   5. Buat header transfer (id_transfer ZL01-TF-YYYYMMDD-seq).
 *   6. Stempel transaksi -> sudah_setor; stempel kas_kecil pendapatan -> transfer_id.
 *   7. Baris kas_kecil 'setor' (gopay keluar) bertimestamp 23:59:59.
 *   8. Posting kas_besar ringkas per COA (sumber 'setor_penjualan'), tanggal 23:59:59.
 *
 * preview(): hitung tanpa menulis (buat layar konfirmasi kasir).
 * =============================================================================
 */

const db = require('../config/database');
const transaksiModel = require('../models/transaksi.model');
const kasKecilModel = require('../models/kas-kecil.model');
const kasBesarModel = require('../models/kas-besar.model');
const transferModel = require('../models/transfer.model');
const cabangModel = require('../models/cabang.model');
const { generateIdTransfer } = require('../helpers/invoice');
const { pilihTransaksiUtuh, hitungNet, hitungSetoran, round2 } = require('../helpers/transfer-calc');
const { today, now } = require('../helpers/date');
const { badRequest, conflict } = require('../helpers/errors');

const COA_GOPAY = Number(process.env.COA_SALDO_GOPAY) || 4; // 1-102 Saldo Gopay
const SETOR_MAX_PER_TRANSFER = Number(process.env.SETOR_MAX_PER_TRANSFER) || 500000; // cap per transfer (patokan: NET)
const MODAL_FLOAT_GOPAY = Number(process.env.MODAL_FLOAT_GOPAY) || 1000000; // float gopay yang selalu disisihkan

/**
 * Stempel waktu setor:
 * - Setor NORMAL (hari ini, `ymd === today()`): pakai jam REAL saat kasir
 *   klik tombol setor -- biar "Rekap Setoran" bisa nunjukin waktu yang
 *   sebenarnya, bukan 23:59:59 semua (penting kalau kasir setor >1x sehari,
 *   supaya urutannya kebaca jelas).
 * - Setor BACKDATE (ymd tanggal lampau, lihat ALLOW_BACKDATE): tetap pakai
 *   23:59:59 (keputusan awal) -- karena waktu ASLI kasir klik tombolnya
 *   (hari ini) tidak relevan buat entri yang sengaja ditanggalkan mundur ke
 *   hari lain; 23:59:59 dipakai sebagai penanda "akhir hari itu" yang netral.
 */
function waktuSetor(ymd) {
  if (ymd === today()) {
    return `${ymd} ${now().slice(11)}`; // jam:menit:detik asli sekarang
  }
  return `${ymd} 23:59:59`;
}

/**
 * Hitung rencana setor (tanpa tulis). Return ringkasan.
 */
async function preview(cabangId) {
  const belum = await transaksiModel.findBelumSetor(cabangId);
  const saldoGopay = await kasKecilModel.saldoAkun(cabangId, 'gopay');
  const saldoCash = await kasKecilModel.saldoAkun(cabangId, 'cash');
  const saldoGabungan = round2(saldoGopay + saldoCash);

  // belanja belum di-reimburse (diambil semua untuk net-off)
  const belanja = await kasKecilModel.belanjaBelumReimburse(cabangId);
  const totalReimburse = round2(belanja.reduce((s, b) => s + (Number(b.nominal) || 0), 0));

  // plafon: uang riil yang boleh keluar = saldo - modal float (float selalu disisihkan)
  const plafonSaldo = round2(Math.max(0, saldoGabungan - MODAL_FLOAT_GOPAY));

  // estimasi awal batch FIFO tanpa loyalty (untuk ambil id transaksi dulu)
  const hPre = hitungSetoran(belum, totalReimburse, plafonSaldo, SETOR_MAX_PER_TRANSFER);

  // biaya loyalty dari transaksi batch awal — dihitung sebelum net final
  const loyaltyItemsPre = await kasKecilModel.loyaltyBelumSetor(cabangId, hPre.dipilih.map((t) => t.id));
  const totalLoyaltyPre = round2(loyaltyItemsPre.reduce((s, b) => s + (Number(b.nominal) || 0), 0));

  // hitung ulang FIFO dengan loyalty masuk ke perhitungan net: net = pendapatan - reimburse - loyalty
  const h = hitungSetoran(belum, totalReimburse, plafonSaldo, SETOR_MAX_PER_TRANSFER, totalLoyaltyPre);

  // ambil loyalty final dari batch yang sudah pasti
  const loyaltyItems = await kasKecilModel.loyaltyBelumSetor(cabangId, h.dipilih.map((t) => t.id));
  const totalLoyalty = round2(loyaltyItems.reduce((s, b) => s + (Number(b.nominal) || 0), 0));

  const totalBelum = round2(belum.reduce((s, t) => s + (Number(t.total) || 0), 0));
  const sisaSetelah = round2(totalBelum - h.totalPendapatan);

  return {
    jumlah_belum_setor: belum.length,
    saldo_gopay: saldoGopay,
    saldo_cash: saldoCash,
    saldo_gabungan: saldoGabungan,
    modal_float: MODAL_FLOAT_GOPAY,
    plafon_setor: plafonSaldo,
    cap_per_transfer: SETOR_MAX_PER_TRANSFER,
    transaksi_dipilih: h.dipilih.map((t) => ({ id: t.id, no_invoice: t.no_invoice, total: t.total })),
    total_pendapatan: h.totalPendapatan,
    belanja_reimburse: belanja.map((b) => ({ id: b.id, coa_id: b.coa_id, nominal: b.nominal, keterangan: b.keterangan })),
    total_reimburse: h.totalReimburse,
    jumlah_belanja: belanja.length,
    loyalty_items: loyaltyItems,
    total_loyalty: totalLoyalty,
    nominal_transfer: h.net,        // net = pendapatan - reimburse - loyalty (boleh negatif)
    arah: h.arah,                   // 'kasir_ke_management' | 'management_ke_kasir'
    cukup: true,                    // tidak pernah blocking lagi
    total_belum_setor: totalBelum,
    sisa_setelah_setor: sisaSetelah,
    ada_sisa: sisaSetelah > 0,
  };
}

/**
 * Eksekusi setor.
 * @param {object} ctx { cabangId, kasirId, cabangKode }
 * @param {object} input { bukti_url? }
 */
async function setor(ctx, input = {}) {
  const { cabangId, kasirId } = ctx;
  // backdate: kalau input.tanggal diisi & ALLOW_BACKDATE on, pakai tanggal itu (jam 23:59:59)
  let ymd = today();
  if (input.tanggal && String(process.env.ALLOW_BACKDATE || '').toLowerCase() === 'true') {
    const m = String(input.tanggal).match(/^(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] <= today()) ymd = m[1]; // tolak masa depan
  }
  const tglSetor = waktuSetor(ymd);

  return db.transaction(async (conn) => {
    // 1) transaksi belum setor (FIFO)
    const belum = await transaksiModel.findBelumSetor(cabangId, conn);
    if (belum.length === 0) throw conflict('Tidak ada transaksi yang perlu disetor');

    // 2) saldo gopay & cash
    const saldoGopay = await kasKecilModel.saldoAkun(cabangId, 'gopay', conn);
    const saldoCash = await kasKecilModel.saldoAkun(cabangId, 'cash', conn);
    const saldoGabungan = round2(saldoGopay + saldoCash);

    // 3) belanja belum reimburse (diambil semua) + plafon (saldo - float)
    const belanja = await kasKecilModel.belanjaBelumReimburse(cabangId, conn);
    const totalReimburse = round2(belanja.reduce((s, b) => s + (Number(b.nominal) || 0), 0));
    const plafonSaldo = round2(Math.max(0, saldoGabungan - MODAL_FLOAT_GOPAY));

    // 4) estimasi batch awal untuk hitung loyalty, lalu hitung ulang dengan loyalty
    const hPre = hitungSetoran(belum, totalReimburse, plafonSaldo, SETOR_MAX_PER_TRANSFER);
    const loyaltyPre = await kasKecilModel.loyaltyBelumSetor(cabangId, hPre.dipilih.map((t) => t.id), conn);
    const totalLoyaltyPre = round2(loyaltyPre.reduce((s, b) => s + (Number(b.nominal) || 0), 0));

    // hitung ulang FIFO dengan loyalty: net = pendapatan - reimburse - loyalty (boleh negatif)
    const h = hitungSetoran(belum, totalReimburse, plafonSaldo, SETOR_MAX_PER_TRANSFER, totalLoyaltyPre);
    if (h.dipilih.length === 0 && totalReimburse === 0) {
      throw conflict('Tidak ada pendapatan maupun reimburse yang perlu disetor');
    }

    const totalPendapatan = h.totalPendapatan;
    const net = h.net;
    const arah = h.arah; // 'kasir_ke_management' | 'management_ke_kasir'

    // 4b) saldo gopay harus cukup untuk pengeluaran 'setor' (= totalPendapatan).
    //     reimburse masuk lagi setelahnya (independen dari arah net keseluruhan).
    if (saldoGopay < totalPendapatan) {
      const perluKonversi = round2(totalPendapatan - saldoGopay);
      await kasKecilModel.insert({
        cabang_id: cabangId, tanggal: tglSetor, akun: 'cash', jenis: 'keluar',
        jenis_mutasi: 'konversi', coa_id: COA_GOPAY, nominal: perluKonversi,
        karyawan_id: kasirId, keterangan: 'Konversi cash->gopay untuk setor',
      }, conn);
      await kasKecilModel.insert({
        cabang_id: cabangId, tanggal: tglSetor, akun: 'gopay', jenis: 'masuk',
        jenis_mutasi: 'konversi', coa_id: COA_GOPAY, nominal: perluKonversi,
        karyawan_id: kasirId, keterangan: 'Konversi cash->gopay untuk setor',
      }, conn);
    }

    // 5) header transfer
    // sama seperti no_invoice: kode cabang WAJIB dari DB, bukan dari ctx.cabangKode
    // (yang selalu undefined karena JWT tidak menyertakan cabang_kode) -> supaya
    // id_transfer tidak bentrok antar cabang.
    const cabangRow = await cabangModel.findById(cabangId);
    if (!cabangRow) throw badRequest('Cabang tidak ditemukan');
    const idTransfer = await generateIdTransfer(conn, cabangId, cabangRow.kode);
    const transferId = await transferModel.create(conn, {
      cabang_id: cabangId, tanggal: tglSetor, id_transfer: idTransfer, arah,
      nominal_transfer: net, total_pendapatan: totalPendapatan, total_reimburse: totalReimburse,
      saldo_gopay_snapshot: saldoGabungan, jumlah_transaksi: h.dipilih.length,
      bukti_url: input.bukti_url || null, karyawan_id: kasirId,
    });

    const ids = h.dipilih.map((t) => t.id);
    const belanjaIds = belanja.map((b) => b.id);

    // 6) stempel transaksi + kas_kecil pendapatan; stempel belanja yg di-reimburse
    await transaksiModel.stempelSetor(conn, transferId, ids);
    await kasKecilModel.stempelPendapatan(conn, transferId, ids);
    if (belanjaIds.length) await kasKecilModel.stempelBelanja(conn, transferId, belanjaIds);

    // 7) kas_kecil granular: setor keluar (= pendapatan) + reimburse masuk (= belanja)
    await kasKecilModel.insert({
      cabang_id: cabangId, tanggal: tglSetor, akun: 'gopay', jenis: 'keluar',
      jenis_mutasi: 'setor', coa_id: COA_GOPAY, transfer_id: transferId,
      nominal: totalPendapatan, karyawan_id: kasirId, keterangan: `Setor pendapatan ${idTransfer}`,
    }, conn);
    if (totalReimburse > 0) {
      await kasKecilModel.insert({
        cabang_id: cabangId, tanggal: tglSetor, akun: 'gopay', jenis: 'masuk',
        jenis_mutasi: 'reimburse', coa_id: COA_GOPAY, transfer_id: transferId,
        nominal: totalReimburse, karyawan_id: kasirId, keterangan: `Reimburse belanja ${idTransfer}`,
      }, conn);
    }

    // 8) kas_besar per COA: pendapatan masuk + beban (reimburse) keluar + biaya loyalty keluar
    await kasBesarModel.postingPendapatanDariTransfer(conn, {
      transferId, tanggal: tglSetor, cabangId, kasirId, idTransfer,
    });
    if (totalReimburse > 0) {
      await kasBesarModel.postingBebanDariTransfer(conn, {
        transferId, tanggal: tglSetor, cabangId, kasirId, idTransfer,
      });
    }
    // loyalty: posting ke kas besar kalau ada biaya_loyalty di transaksi yang disetor
    await kasBesarModel.postingLoyaltyDariTransfer(conn, {
      transferId, tanggal: tglSetor, cabangId, kasirId, idTransfer,
    });

    return {
      id_transfer: idTransfer,
      transfer_id: transferId,
      jumlah_transaksi: h.dipilih.length,
      total_pendapatan: totalPendapatan,
      total_reimburse: totalReimburse,
      nominal_transfer: net,
      transaksi: h.dipilih.map((t) => ({ id: t.id, no_invoice: t.no_invoice, total: t.total })),
    };
  });
}

async function riwayat(cabangId, range) { return transferModel.findByCabang(cabangId, range || {}); }

module.exports = { preview, setor, riwayat };
