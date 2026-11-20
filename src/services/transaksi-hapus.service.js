/**
 * src/services/transaksi-hapus.service.js
 * =============================================================================
 * Perubahan #48 -- OWNER menghapus transaksi (termasuk yang sudah bayar).
 * Kasus: customer dobel input, kasir terlanjur konfirmasi bayar semua.
 *
 * Aturan (keputusan owner 1 Nov 2026):
 *  - Hanya role owner, alasan wajib, snapshot disimpan di transaksi_hapus_log.
 *  - Ditolak kalau mesin sudah pernah dipakai untuk transaksi ini.
 *  - Lunas BELUM disetor: semua efek dibalik -- baris kas kecil transaksi
 *    dihapus, poin & frekuensi pelanggan dikurangi (poin yang ditukar
 *    dikembalikan), stok barang dikembalikan, keranjang dibebaskan, antrian
 *    dirapikan, jatah cuci (#39) kembali (FK cascade).
 *  - SUDAH disetor: uangnya sudah di Kas Besar -> dicatat KOREKSI di Kas Besar
 *    bertanggal hari hapus: pendapatan 'setor_penjualan' NEGATIF per COA
 *    (laporan laba-rugi & saldo otomatis berkurang) + pembalikan biaya
 *    loyalty/promo bila ada. Baris kas kecil tetap (sudah keluar lewat
 *    setoran), referensinya ke transaksi dilepas.
 *  - Kios-K lunas (#84): + pembalikan biaya MDR Winpay & dana di Saldo Winpay
 *    (net kas besar fisik 0); ditolak bila dana sudah ditarik (saldo kurang).
 * =============================================================================
 */
const db = require('../config/database');
const logger = require('../config/logger');
const { now } = require('../helpers/date');
const { poinTercatat } = require('../helpers/poin');
const { badRequest, conflict, notFound } = require('../helpers/errors');
const transaksiModel = require('../models/transaksi.model');
const detailModel = require('../models/detail-transaksi.model');
const barangModel = require('../models/barang.model');
const keranjangModel = require('../models/keranjang.model');
const stokMutasiModel = require('../models/stok-mutasi.model');
const kasBesarModel = require('../models/kas-besar.model');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function hapus(transaksiId, { alasan, karyawanId }) {
  const ket = String(alasan || '').trim();
  if (!ket) throw badRequest('Alasan wajib diisi');
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  const pernah = await db.queryOne('SELECT COUNT(*) AS n FROM mesin_usage WHERE transaksi_id = ?', [transaksiId]);
  if (Number(pernah.n) > 0) throw conflict('Mesin sudah pernah dipakai untuk transaksi ini, tidak bisa dihapus');
  // Perubahan #83/#84: Kios-K lunas boleh dihapus owner -> selain koreksi pendapatan,
  // biaya MDR & dana di Saldo Winpay ikut dibalik (lihat langkah 3b). Ditolak kalau
  // dananya sudah ditarik ke kas besar sehingga Saldo Winpay tidak cukup.
  const kioskLunas = header.status_bayar === 'lunas' && header.metode_bayar === 'kiosk';
  let winpayBalik = null;
  if (kioskLunas && header.transfer_id) {
    const r = await db.queryOne(
      `SELECT COALESCE(SUM(CASE WHEN sumber='winpay_mdr' THEN nominal ELSE 0 END),0) AS mdr,
              COALESCE(SUM(CASE WHEN sumber='winpay_titip' THEN nominal ELSE 0 END),0) AS titip
         FROM kas_besar WHERE transfer_id = ? AND jenis = 'keluar' AND sumber IN ('winpay_mdr','winpay_titip')`, [header.transfer_id]);
    winpayBalik = { mdr: round2(r.mdr), titip: round2(r.titip) };
    if (winpayBalik.titip > 0) {
      const { saldo } = await require('./kas-winpay.service').hitungSaldo(header.cabang_id);
      if (winpayBalik.titip > saldo + 0.009) {
        throw conflict(`Dana Kios-K transaksi ini (Rp${winpayBalik.titip.toLocaleString('id-ID')}) melebihi Saldo Winpay sekarang (Rp${saldo.toLocaleString('id-ID')}) karena sudah ditarik ke kas besar. Tidak bisa dihapus.`);
      }
    }
  }

  const items = await detailModel.findByTransaksi(transaksiId);
  const [riwayat, kas, jatah, statusRow] = await Promise.all([
    db.query('SELECT status_id, karyawan_id, waktu, keterangan FROM transaksi_status_log WHERE transaksi_id = ? ORDER BY id', [transaksiId]),
    db.query('SELECT id, akun, jenis, jenis_mutasi, coa_id, nominal, transfer_id, tanggal FROM kas_kecil WHERE ref_transaksi_id = ?', [transaksiId]),
    db.queryOne('SELECT nominal FROM jatah_cuci_pakai WHERE transaksi_id = ?', [transaksiId]).catch(() => null),
    header.status_terakhir_id ? db.queryOne('SELECT kode FROM status_master WHERE id = ?', [header.status_terakhir_id]) : null,
  ]);
  const lunas = header.status_bayar === 'lunas';
  const bsa = !!Number(header.bayar_saat_ambil);
  const sudahSetor = lunas && header.status_setor && header.status_setor !== 'belum_setor';

  try { await require('./pembayaran-qris.service').batalkanSesiPendingUntukTransaksi(transaksiId); }
  catch (e) { logger.error('Gagal cancel QRIS pending saat hapus transaksi (lanjut)', { transaksiId, err: e.message }); }

  const tanggal = now();
  let koreksi = 0;
  await db.transaction(async (conn) => {
    const [lock] = await conn.execute('SELECT id FROM transaksi WHERE id = ? FOR UPDATE', [transaksiId]);
    if (!lock[0]) throw conflict('Transaksi sudah dihapus');

    // 1) stok barang: kembali kalau sudah dipotong (lunas / bayar saat ambil)
    if (lunas || bsa) {
      for (const it of items) {
        if (it.item_tipe !== 'barang' || !it.barang_id) continue;
        const stok = await barangModel.getStokLocked(conn, it.barang_id);
        if (stok == null) continue;
        const sesudah = Number(stok) + (Number(it.qty) || 0);
        await stokMutasiModel.create({
          barang_id: it.barang_id, cabang_id: header.cabang_id, jenis: 'masuk', qty: Number(it.qty) || 0,
          ref_tipe: 'penyesuaian', ref_id: null, stok_sebelum: Number(stok), stok_sesudah: sesudah,
          karyawan_id: karyawanId, waktu: tanggal, keterangan: `Hapus transaksi ${header.no_invoice} (owner)`,
        }, conn);
        await barangModel.setStok(conn, it.barang_id, sesudah);
      }
    }

    // 2) poin & frekuensi pelanggan
    if (lunas && header.pelanggan_id) {
      const poinDapat = jatah ? 0 : poinTercatat({ total: header.total, poin_didapat: await transaksiModel.getPoinDidapat(transaksiId, conn) }); // #83
      const poinBalik = Number(header.poin_dipakai) || 0; // poin yang ditukar dikembalikan
      const tgl = String(header.tanggal_bayar || header.tanggal).slice(0, 10);
      const [lain] = await conn.execute(
        'SELECT 1 FROM transaksi WHERE pelanggan_id = ? AND DATE(tanggal) = ? AND id <> ? LIMIT 1', [header.pelanggan_id, tgl, transaksiId]);
      await conn.execute(
        `UPDATE pelanggan SET point = GREATEST(0, point - ? + ?), frekuensi_kedatangan = GREATEST(0, frekuensi_kedatangan - ?) WHERE id = ?`,
        [poinDapat, poinBalik, lain.length ? 0 : 1, header.pelanggan_id]);
    }

    // 3) kas
    if (sudahSetor) {
      // pendapatan per COA (masuk - keluar) + biaya loyalty/promo per COA
      const per = new Map(); const loy = new Map();
      for (const k of kas) {
        if (k.jenis_mutasi === 'pendapatan') per.set(k.coa_id, round2((per.get(k.coa_id) || 0) + (k.jenis === 'masuk' ? 1 : -1) * Number(k.nominal)));
        if (k.jenis_mutasi === 'biaya_loyalty' && k.transfer_id) loy.set(k.coa_id, round2((loy.get(k.coa_id) || 0) + Number(k.nominal)));
      }
      for (const [coa, n] of per) {
        if (!n) continue;
        await kasBesarModel.insert({
          tanggal, jenis: 'masuk', coa_id: coa, nominal: -n, sumber: 'setor_penjualan', ref_cabang_id: header.cabang_id,
          karyawan_id: karyawanId, keterangan: `Koreksi hapus transaksi ${header.no_invoice} (owner): ${ket}`.slice(0, 255),
        }, conn);
        koreksi = round2(koreksi + n);
      }
      for (const [coa, n] of loy) {
        if (!n) continue;
        await kasBesarModel.insert({
          tanggal, jenis: 'keluar', coa_id: coa, nominal: -n, sumber: 'biaya_loyalty', ref_cabang_id: header.cabang_id,
          karyawan_id: karyawanId, keterangan: `Koreksi biaya promo, hapus transaksi ${header.no_invoice} (owner)`.slice(0, 255),
        }, conn);
        koreksi = round2(koreksi - n);
      }
      // 3b) Kios-K (#84): balik biaya MDR & dana di Saldo Winpay (nominal negatif, sumber sama)
      if (winpayBalik) {
        const ketW = `hapus transaksi ${header.no_invoice} (owner)`;
        if (winpayBalik.mdr) {
          await kasBesarModel.insert({
            tanggal, jenis: 'keluar', coa_id: (await db.queryOne(`SELECT id FROM coa WHERE kode='6-107' LIMIT 1`) || {}).id || null,
            nominal: -winpayBalik.mdr, sumber: 'winpay_mdr', ref_cabang_id: header.cabang_id,
            karyawan_id: karyawanId, keterangan: `Koreksi biaya MDR Winpay, ${ketW}`.slice(0, 255),
          }, conn);
          koreksi = round2(koreksi - winpayBalik.mdr);
        }
        if (winpayBalik.titip) {
          await kasBesarModel.insert({
            tanggal, jenis: 'keluar', coa_id: (await db.queryOne(`SELECT id FROM coa WHERE kode='1-103' LIMIT 1`) || {}).id || null,
            nominal: -winpayBalik.titip, sumber: 'winpay_titip', ref_cabang_id: header.cabang_id,
            karyawan_id: karyawanId, keterangan: `Koreksi dana Kios-K di Winpay, ${ketW}`.slice(0, 255),
          }, conn);
          koreksi = round2(koreksi - winpayBalik.titip);
        }
      }
      await conn.execute(
        `UPDATE kas_kecil SET ref_transaksi_id = NULL, ref_detail_transaksi_id = NULL,
                keterangan = LEFT(CONCAT(COALESCE(keterangan,''), ' [transaksi dihapus owner]'), 255)
          WHERE ref_transaksi_id = ?`, [transaksiId]);
    } else {
      await conn.execute('DELETE FROM kas_kecil WHERE ref_transaksi_id = ?', [transaksiId]);
    }

    // 4) keranjang & baris turunan (urutan aman terhadap FK)
    if (header.keranjang_id) await keranjangModel.bebaskan(header.keranjang_id, conn, transaksiId);
    await conn.execute('DELETE FROM pembayaran_qris_transaksi WHERE transaksi_id = ?', [transaksiId]);
    await conn.execute('UPDATE kas_kecil SET ref_detail_transaksi_id = NULL WHERE ref_detail_transaksi_id IN (SELECT id FROM detail_transaksi WHERE transaksi_id = ?)', [transaksiId]);
    await conn.execute('DELETE FROM transaksi_status_log WHERE transaksi_id = ?', [transaksiId]);
    await conn.execute('DELETE FROM detail_transaksi WHERE transaksi_id = ?', [transaksiId]);
    await conn.execute('DELETE FROM transaksi WHERE id = ?', [transaksiId]);

    // 5) jejak
    await conn.execute(
      `INSERT INTO transaksi_hapus_log (transaksi_id, cabang_id, no_invoice, pelanggan_id, total, status_bayar, sudah_setor, koreksi_kas_besar, alasan, karyawan_id, snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [transaksiId, header.cabang_id, header.no_invoice, header.pelanggan_id || null, Number(header.total) || 0,
        header.status_bayar, sudahSetor ? 1 : 0, koreksi, ket.slice(0, 255), karyawanId,
        JSON.stringify({ header, status: statusRow && statusRow.kode, items, riwayat, kas, jatah })]);
  });

  await require('./antrian-mesin.service').refresh(header.cabang_id);
  return {
    id: Number(transaksiId), no_invoice: header.no_invoice, dihapus: true, lunas, sudah_setor: !!sudahSetor,
    koreksi_kas_besar: koreksi,
  };
}

module.exports = { hapus };
