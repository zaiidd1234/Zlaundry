/**
 * src/services/stok.service.js
 * =============================================================================
 * Operasi stok barang. Fase 4: kurangi stok saat barang terjual (di pembayaran).
 *
 * kurangiUntukTransaksi(conn, { transaksi, items, kasirId, tanggal }):
 *   untuk tiap item barang -> lock stok, catat stok_mutasi 'keluar' (penjualan),
 *   update stok_terkini. Lempar error kalau stok kurang.
 * =============================================================================
 */

const barangModel = require('../models/barang.model');
const stokMutasiModel = require('../models/stok-mutasi.model');
const { badRequest } = require('../helpers/errors');

async function kurangiUntukTransaksi(conn, { transaksi, items, kasirId, tanggal }) {
  for (const it of items) {
    if (it.item_tipe !== 'barang') continue;
    const qty = Number(it.qty);
    const sebelum = await barangModel.getStokLocked(conn, it.barang_id);
    if (sebelum === null) throw badRequest(`Barang id ${it.barang_id} tidak ditemukan`);
    if (sebelum < qty) throw badRequest(`Stok ${it.nama_item} tidak cukup (sisa ${sebelum}, butuh ${qty})`);

    const sesudah = sebelum - qty;
    await stokMutasiModel.create({
      barang_id: it.barang_id,
      cabang_id: transaksi.cabang_id,
      jenis: 'keluar',
      qty,
      ref_tipe: 'penjualan',
      ref_id: it.id,                 // detail_transaksi id
      stok_sebelum: sebelum,
      stok_sesudah: sesudah,
      karyawan_id: kasirId,
      waktu: tanggal,
      keterangan: `Penjualan ${transaksi.no_invoice}`,
    }, conn);
    await barangModel.setStok(conn, it.barang_id, sesudah);
  }
}

module.exports = { kurangiUntukTransaksi };
