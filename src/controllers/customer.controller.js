/**
 * src/controllers/customer.controller.js
 * =============================================================================
 * Endpoint publik customer (tanpa token). cabang_id & telepon dari query/body.
 * Submit order reuse transaksiService.createOrder dgn sumber_pesan='customer_app'
 * dan kasir_id null (customer pesan sendiri).
 * =============================================================================
 */

const customerService = require('../services/customer.service');
const transaksiService = require('../services/transaksi.service');
const { ok, created } = require('../helpers/response');
const { badRequest } = require('../helpers/errors');

function requireCabang(req) {
  const cabangId = Number(req.query.cabang_id || (req.body && req.body.cabang_id));
  if (!cabangId) throw badRequest('cabang_id wajib diisi');
  return cabangId;
}

/** GET /api/customer/cabang */
async function listCabang(req, res, next) {
  try { return ok(res, await customerService.listCabang(), 'Daftar cabang'); }
  catch (e) { next(e); }
}

/** GET /api/customer/katalog?cabang_id= */
async function katalog(req, res, next) {
  try { return ok(res, await customerService.katalog(requireCabang(req)), 'Katalog'); }
  catch (e) { next(e); }
}

/** GET /api/customer/lookup?cabang_id=&telepon=&lat=&lng= */
async function lookup(req, res, next) {
  try {
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const lng = req.query.lng ? Number(req.query.lng) : null;
    const data = await customerService.lookup(requireCabang(req), req.query.telepon, { lat, lng });
    return ok(res, data, data.found ? 'Pelanggan ditemukan' : 'Pelanggan baru');
  } catch (e) { next(e); }
}

/** POST /api/customer/transaksi  body: { cabang_id, pelanggan:{telepon,nama,alamat}, ... } */
async function buatOrder(req, res, next) {
  try {
    const cabangId = requireCabang(req);
    const ctx = { cabangId, kasirId: null, cabangKode: req.body.cabang_kode || 'ZL01' };
    const input = { ...req.body, sumber_pesan: 'customer_app' };
    const data = await transaksiService.createOrder(input, ctx);
    return created(res, data, 'Pesanan dibuat, silakan ke kasir / tunggu konfirmasi');
  } catch (e) { next(e); }
}

/** GET /api/customer/riwayat?cabang_id=&telepon=&tab=aktif|selesai */
async function riwayat(req, res, next) {
  try {
    const data = await customerService.riwayat(requireCabang(req), req.query.telepon, req.query.tab || 'aktif');
    return ok(res, data, 'Riwayat pesanan');
  } catch (e) { next(e); }
}

/** GET /api/customer/transaksi/:id?cabang_id=&telepon= */
async function detail(req, res, next) {
  try {
    const data = await customerService.detailMilik(requireCabang(req), req.query.telepon, Number(req.params.id));
    return ok(res, data, 'Detail pesanan');
  } catch (e) { next(e); }
}

/** GET /api/customer/mesin?cabang_id=&tipe=washer|dryer */
async function mesinList(req, res, next) {
  try {
    const data = await customerService.daftarMesin(requireCabang(req), req.query.tipe);
    return ok(res, data, 'Daftar mesin tersedia');
  } catch (e) { next(e); }
}

/**
 * GET /api/customer/mesin-status?cabang_id=
 * Ringkasan idle/terpakai + estimasi menit ketersediaan (washer & dryer),
 * dipakai di menu "Data Saya" biar customer tidak numpuk antrian di outlet.
 */
async function mesinStatus(req, res, next) {
  try {
    const data = await customerService.statusMesin(requireCabang(req));
    return ok(res, data, 'Status mesin outlet');
  } catch (e) { next(e); }
}

/** GET /api/customer/promo-tersedia?cabang_id=&telepon= -> jenis promo yang bisa dipakai sekarang */
async function promoTersedia(req, res, next) {
  try {
    const data = await customerService.promoTersedia(requireCabang(req), req.query.telepon);
    return ok(res, data, 'Promo tersedia');
  } catch (e) { next(e); }
}

/**
 * POST /api/customer/transaksi/:id/mesin?cabang_id=  body: { telepon, mesin_id? }
 * Wewenang customer: pilih mesin / mulai / selesai (cuci & kering), setelah kasir
 * konfirmasi bayar. Server yang menentukan tahap berikutnya, customer cuma kirim
 * mesin_id kalau tahapnya "pilih mesin".
 */
async function aksiMesin(req, res, next) {
  try {
    const cabangId = requireCabang(req);
    const data = await customerService.aksiMesinProses(cabangId, req.body.telepon, Number(req.params.id), {
      mesin_id: req.body.mesin_id || null,
    });
    return ok(res, data, 'Proses pesanan diperbarui');
  } catch (e) { next(e); }
}

async function tukarPoin(req, res, next) {
  try {
    const data = await transaksiService.tukarPoin(Number(req.params.id), req.body);
    return ok(res, data, 'Poin berhasil ditukar');
  } catch (e) { next(e); }
}

async function reservePoin(req, res, next) {
  try {
    const data = await transaksiService.reservePoin(Number(req.params.id), req.body);
    return ok(res, data, 'Poin direservasi');
  } catch (e) { next(e); }
}

/** GET /api/customer/tagihan-qris?cabang_id=&telepon= -> daftar transaksi belum lunas (buat checkbox pilih). */
async function tagihanQris(req, res, next) {
  try {
    const data = await customerService.tagihanQris(requireCabang(req), req.query.telepon);
    return ok(res, data, 'Daftar tagihan belum lunas');
  } catch (e) { next(e); }
}

/** POST /api/customer/pembayaran-qris  body: { cabang_id, telepon, transaksi_ids:[] } -> generate QR dinamis. */
async function buatPembayaranQris(req, res, next) {
  try {
    const cabangId = requireCabang(req);
    const data = await customerService.buatPembayaranQris(cabangId, req.body.telepon, req.body.transaksi_ids);
    return created(res, data, 'QR pembayaran dibuat, silakan scan');
  } catch (e) { next(e); }
}

/** GET /api/customer/pembayaran-qris/:id?cabang_id=&telepon= -> polling status bayar. */
async function statusPembayaranQris(req, res, next) {
  try {
    const data = await customerService.statusPembayaranQris(requireCabang(req), req.query.telepon, Number(req.params.id));
    return ok(res, data, 'Status pembayaran');
  } catch (e) { next(e); }
}

/** POST /api/customer/bayar-semua  body: { cabang_id, telepon } -> tombol "Bayar Semua" di Pesanan Aktif, gabung tagihan metode QRIS belum lunas + kode_bayar 4 digit buat kiosk (tagihan metode cash TIDAK ikut, lihat data.cash_transaksi). */
async function bayarSemuaQris(req, res, next) {
  try {
    const cabangId = requireCabang(req);
    const data = await customerService.bayarSemuaQris(cabangId, req.body.telepon);
    const pesan = data.semuaCash
      ? 'Semua tagihan kamu metode cash -- bayar langsung ke kasir'
      : 'QR pembayaran dibuat, tunjukkan kode bayar di tablet toko';
    return created(res, data, pesan);
  } catch (e) { next(e); }
}

module.exports = {
  listCabang, katalog, lookup, buatOrder, riwayat, detail, tukarPoin, reservePoin, mesinList, mesinStatus, promoTersedia, aksiMesin,
  tagihanQris, buatPembayaranQris, bayarSemuaQris, statusPembayaranQris,
};
