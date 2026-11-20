/**
 * src/controllers/transaksi.controller.js
 * =============================================================================
 * Controller transaksi. cabangId & kasirId diambil dari req.user (staff login).
 * Owner boleh override cabang via ?cabang_id=.
 * =============================================================================
 */

const transaksiService = require('../services/transaksi.service');
const { ok, created } = require('../helpers/response');

function ctxFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && req.body && req.body.cabang_id) cabangId = Number(req.body.cabang_id);
  return { cabangId, kasirId: req.user.id, role: req.user.role, cabangKode: req.user.cabang_kode || 'ZL01' };
}

/** POST /api/transaksi  -> buat order (status awal menunggu_bayar). */
async function create(req, res, next) {
  try {
    const data = await transaksiService.createOrder(req.body, ctxFrom(req));
    return created(res, data, 'Order dibuat, menunggu pembayaran');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/bayar -> tandai lunas + posting kas/stok/poin. */
async function bayar(req, res, next) {
  try {
    const data = await transaksiService.bayar(Number(req.params.id), req.body, { kasirId: req.user.id });
    return ok(res, data, 'Pembayaran berhasil');
  } catch (e) { next(e); }
}

/** GET /api/transaksi/:id -> detail transaksi (header + items + riwayat). */
async function detail(req, res, next) {
  try {
    const data = await transaksiService.getDetail(Number(req.params.id));
    return ok(res, data, 'Detail transaksi');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/status -> pindah status (maju). body: { status?, mesin_id?, keterangan? } */
async function pindahStatus(req, res, next) {
  try {
    const data = await transaksiService.pindahStatus(Number(req.params.id), req.body, { userId: req.user.id, role: req.user.role });
    return ok(res, data, 'Status diperbarui');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/ganti-mesin body:{tipe:'cuci'|'kering', mesin_id} -- kasir switch alokasi mesin (belum jalan) dari kartu Pesanan */
async function gantiMesin(req, res, next) {
  try {
    const data = await transaksiService.gantiMesin(Number(req.params.id), req.body, { userId: req.user.id });
    return ok(res, data, 'Alokasi mesin diperbarui');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/restart-proses  body: { alasan } -- kasir restart mesin yang gagal trigger fisik */
async function restartProses(req, res, next) {
  try {
    const data = await transaksiService.restartProses(Number(req.params.id), {
      alasan: req.body.alasan, karyawanId: req.user.id, mode: req.body.mode || null,
    });
    return ok(res, data, 'Proses berhasil di-restart');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/resume-kering -- dryer pause (pintu dibuka) -> Start lagi, durasi lanjut. */
async function resumeKering(req, res, next) {
  try {
    const data = await transaksiService.resumeKering(Number(req.params.id), { karyawanId: req.user.id });
    return ok(res, data, 'Mesin kering dilanjutkan');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/bayar-saat-ambil -- Perubahan #13: proses dulu, bayar saat ambil (kasir). */
async function bayarSaatAmbil(req, res, next) {
  try {
    const data = await transaksiService.prosesBayarSaatAmbil(Number(req.params.id), { kasirId: req.user.id, cabangId: req.user.role === 'owner' ? null : req.user.cabang_id });
    return ok(res, data, 'Pesanan diproses, bayar saat ambil');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/onoff-mesin -- Perubahan #21: pulse tombol power mesin yang sedang jalan. */
async function onOffMesin(req, res, next) {
  try {
    const data = await transaksiService.onOffMesin(Number(req.params.id), { karyawanId: req.user.id });
    return ok(res, data, `Tombol power ${data.kode_mesin} ditekan`);
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/selesai-cuci -- Perubahan #11: selesai cuci dari popup mesin (aktif menit ke-30). */
async function selesaiCuci(req, res, next) {
  try {
    const data = await transaksiService.selesaiCuciPopup(Number(req.params.id), { karyawanId: req.user.id });
    return ok(res, data, 'Cuci diselesaikan');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/start-alarm  body: { jenis: '4c_4e'|'dc_de' } -- kasir "Lanjut Start" setelah benerin alarm 4C/4E (keran) atau dC/dE (pintu), mesin TIDAK pernah mati jadi tidak perlu full restart */
async function startSetelahAlarm(req, res, next) {
  try {
    const data = await transaksiService.startSetelahAlarm(Number(req.params.id), {
      jenis: req.body.jenis, karyawanId: req.user.id,
    });
    return ok(res, data, 'Sinyal start terkirim');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/sudah-diambil -- kasir jalankan semua sisa step sekaligus sampai "sudah_diambil" (customer nunggu di outlet) */
async function sudahDiambilLangsung(req, res, next) {
  try {
    const data = await transaksiService.selesaikanSekaligus(Number(req.params.id), { userId: req.user.id, role: req.user.role });
    return ok(res, data, data.sampai_sudah_diambil ? 'Transaksi selesai (sudah diambil)' : 'Transaksi diproses sebagian');
  } catch (e) { next(e); }
}

/** GET /api/transaksi -> list transaksi kasir (?tab=&q=&cabang_id=) */
async function list(req, res, next) {
  try {
    let cabangId = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
    const data = await transaksiService.list(cabangId, {
      tab: req.query.tab || 'semua',
      sub: ['cuci', 'kering'].includes(req.query.sub) ? req.query.sub : null,
      q: req.query.q || null,
    });
    return ok(res, data, 'Daftar transaksi');
  } catch (e) { next(e); }
}

/** GET /api/transaksi/antrian?tipe=washer|dryer -> daftar antrian mesin (FIFO), buat kasir manuver manual. */
async function antrian(req, res, next) {
  try {
    let cabangId = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
    const tipe = req.query.tipe === 'dryer' ? 'dryer' : 'washer';
    const data = await transaksiService.daftarAntrian(cabangId, tipe);
    return ok(res, data, 'Daftar antrian');
  } catch (e) { next(e); }
}

/** GET /api/transaksi/riwayat -> semua transaksi hari ini + search + filter baru/lama + pagination */
async function riwayat(req, res, next) {
  try {
    let cabangId = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
    const data = await transaksiService.riwayat(cabangId, {
      ymd: req.query.tanggal || null,
      q: req.query.q || null,
      pelanggan: req.query.pelanggan || 'semua',  // semua | baru | lama
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0,
    });
    return ok(res, data, 'Riwayat transaksi');
  } catch (e) { next(e); }
}

/** Perubahan #62: GET /api/transaksi/rekap-terjual?tanggal=YYYY-MM-DD */
async function rekapTerjual(req, res, next) {
  try {
    let cabangId = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
    return ok(res, await transaksiService.rekapTerjual(cabangId, req.query.tanggal || null), 'Rekap terjual');
  } catch (e) { next(e); }
}

/** DELETE /api/transaksi/:id -> batal pesan (hanya belum bayar) */
async function batal(req, res, next) {
  try {
    const data = await transaksiService.batalPesan(Number(req.params.id), { cabangId: req.user.cabang_id, kasirId: req.user.id });
    return ok(res, data, 'Pesanan dibatalkan');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/tukar-poin -> potong poin dari total. */
async function tukarPoin(req, res, next) {
  try {
    const data = await transaksiService.tukarPoin(Number(req.params.id), req.body);
    return ok(res, data, 'Poin berhasil ditukar');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/reserve-poin -> update diskon/total saja, belum potong point. */
async function reservePoin(req, res, next) {
  try {
    const data = await transaksiService.reservePoin(Number(req.params.id), req.body);
    return ok(res, data, 'Poin direservasi');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/ganti-pelanggan -> koreksi salah input nama pelanggan saat pesan. */
async function gantiPelanggan(req, res, next) {
  try {
    const ctx = { cabangId: req.user.cabang_id, kasirId: req.user.id };
    const data = await transaksiService.gantiPelanggan(Number(req.params.id), req.body, ctx);
    return ok(res, data, 'Pelanggan berhasil diganti');
  } catch (e) { next(e); }
}

/**
 * POST /api/transaksi/:id/posisi-manual  body: { posisi: 'mesin'|'keranjang' }
 * Kasir update lokasi fisik cucian secara manual -- kasus pelanggan gak
 * kunjung ambil, mesin dikosongin paksa & cucian dipindah ke keranjang.
 * Balikin juga link WA terbaru (pakai lokasi yang sudah diperbarui) biar
 * kasir bisa langsung kabari pelanggan.
 */
async function setPosisiManual(req, res, next) {
  try {
    const data = await transaksiService.setPosisiManual(Number(req.params.id), req.body.posisi, { userId: req.user.id });
    return ok(res, data, 'Posisi cucian diperbarui');
  } catch (e) { next(e); }
}

module.exports = {
  rekapTerjual, onOffMesin, bayarSaatAmbil, selesaiCuci, ubahInfo, ubahPratinjau, ubahSimpan, resumeKering, create, bayar, tukarPoin, reservePoin, detail, pindahStatus, gantiMesin, restartProses, startSetelahAlarm, sudahDiambilLangsung, list, antrian, riwayat, batal, gantiPelanggan, setPosisiManual };

/* ---- Perubahan #6: ubah pesanan (tambah/kurangi layanan) ---- */
const ubahPesananService = require('../services/ubah-pesanan.service');

/** GET /api/transaksi/:id/ubah-pesanan -- item sekarang (+bisa hapus) & katalog (+bisa tambah) */
async function ubahInfo(req, res, next) {
  try {
    const data = await ubahPesananService.info(Number(req.params.id), { cabangId: req.user.role === 'owner' ? null : req.user.cabang_id });
    return ok(res, data, 'Info ubah pesanan');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/ubah-pesanan/pratinjau  body: { tambah:[{layanan_id,qty?}], hapus:[detail_id] } */
async function ubahPratinjau(req, res, next) {
  try {
    const data = await ubahPesananService.pratinjau(Number(req.params.id), req.body || {}, { cabangId: req.user.role === 'owner' ? null : req.user.cabang_id });
    return ok(res, data, 'Pratinjau ubah pesanan');
  } catch (e) { next(e); }
}

/** POST /api/transaksi/:id/ubah-pesanan  body: { tambah, hapus, alasan, metode, konfirmasi_uang, alamat_antar? } */
async function ubahSimpan(req, res, next) {
  try {
    const data = await ubahPesananService.simpan(Number(req.params.id), req.body || {}, {
      cabangId: req.user.role === 'owner' ? null : req.user.cabang_id, kasirId: req.user.id,
    });
    return ok(res, data, 'Pesanan diubah');
  } catch (e) { next(e); }
}
