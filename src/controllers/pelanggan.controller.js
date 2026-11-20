/**
 * src/controllers/pelanggan.controller.js
 * =============================================================================
 * Controller pelanggan untuk layar kasir (Pesankan).
 * cabangId dari req.user; owner boleh override via ?cabang_id=.
 * =============================================================================
 */

const pelangganModel = require('../models/pelanggan.model');
const transaksiModel = require('../models/transaksi.model');
const { ok } = require('../helpers/response');
const { badRequest, notFound, conflict } = require('../helpers/errors');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    cabangId = Number(req.query.cabang_id || req.body.cabang_id);
  }
  // Perubahan #47: owner -> gabungan cabang (?cabang_ids=1,2)
  if (req.user.role === 'owner' && req.query.cabang_ids) {
    const ids = [...new Set(String(req.query.cabang_ids).split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (ids.length === 1) cabangId = ids[0]; else if (ids.length > 1) cabangId = ids;
  }
  return cabangId;
}
const cabangCocok = (cabangId, pc) => (Array.isArray(cabangId) ? cabangId.includes(Number(pc)) : Number(pc) === Number(cabangId));

function normalizeHp(hp) {
  let s = String(hp || '').replace(/[^\d]/g, '');
  if (s.startsWith('62')) s = '0' + s.slice(2);
  else if (s.startsWith('8')) s = '0' + s;
  else if (s && !s.startsWith('0')) s = '0' + s;
  return s;
}

/** GET /api/pelanggan/search?q= -> cari pelanggan by nama/telepon (untuk Pesankan) */
async function search(req, res, next) {
  try {
    let cabangId = req.user.cabang_id;
    if (req.user.role === 'owner' && req.query.cabang_id) cabangId = Number(req.query.cabang_id);
    const q = (req.query.q || '').trim();
    if (q.length < 2) return ok(res, [], 'Ketik minimal 2 karakter');
    const rows = await pelangganModel.search(cabangId, q, 20);
    const data = rows.map((p) => ({
      id: p.id,
      nama: p.nama,
      telepon: p.telepon,
      alamat: p.alamat,
      point: Number(p.point) || 0,
      kunjungan: Number(p.frekuensi_kedatangan) || 0,
      loyal: (Number(p.frekuensi_kedatangan) || 0) > 1,
    }));
    return ok(res, data, 'Hasil pencarian pelanggan');
  } catch (e) { next(e); }
}

/** GET /api/pelanggan -> list untuk manager (q, filter baru/loyal/lepas/durasi, pagination). */
async function index(req, res, next) {
  try {
    const cabangId = cabangFrom(req);
    const q = (req.query.q || '').trim();
    const filter = ['baru', 'loyal', 'lepas', 'durasi', 'point'].includes(req.query.filter) ? req.query.filter : 'semua';
    const durasi = filter === 'durasi' ? Math.max(1, Number(req.query.durasi) || 7) : null;
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const offset = Number(req.query.offset) || 0;
    const [rows, count] = await Promise.all([
      pelangganModel.listManager(cabangId, { q, filter, durasi, limit: limit + 1, offset }),
      pelangganModel.countManager(cabangId, { q }),
    ]);
    const adaLagi = rows.length > limit;
    const items = (adaLagi ? rows.slice(0, limit) : rows).map((p) => {
      const kedatangan = Number(p.kedatangan) || 0;
      return {
        id: p.id, nama: p.nama, telepon: p.telepon, alamat: p.alamat,
        point: Number(p.point) || 0, kunjungan: kedatangan,
        jml_transaksi: Number(p.jml_transaksi) || 0,
        kategori: p.kategori || null,
        baru: p.kategori === 'baru',
        loyal: p.kategori === 'loyal',
        lepas: p.kategori === 'lepas',
        last_transaksi: p.last_transaksi || null,
        avg_selang: p.avg_selang ? Number(p.avg_selang) : null,
      };
    });
    // Perubahan #17: nilai rupiah poin (poin x nilai_per_poin cabang)
    const cab = await require('../models/cabang.model').findById(Array.isArray(cabangId) ? cabangId[0] : cabangId).catch(() => null);
    const nilaiPerPoin = Number(cab && cab.nilai_per_poin) || 10;
    count.nilai_per_poin = nilaiPerPoin;
    count.nilai_point = Math.round(count.total_point * nilaiPerPoin);
    return ok(res, { items, ada_lagi: adaLagi, filter, durasi, q, count }, 'Daftar pelanggan');
  } catch (e) { next(e); }
}

/** GET /api/pelanggan/:id/riwayat -> riwayat transaksi pelanggan. */
async function riwayat(req, res, next) {
  try {
    const cabangId = cabangFrom(req);
    const p = await pelangganModel.findById(Number(req.params.id));
    if (!p) throw notFound('Pelanggan tidak ditemukan');
    if (cabangId && !cabangCocok(cabangId, p.cabang_id)) throw conflict('Pelanggan bukan dari cabang ini');
    const tab = ['aktif', 'selesai'].includes(req.query.tab) ? req.query.tab : 'semua';
    const trx = await transaksiModel.findByPelanggan(p.id, { tab, limit: 50 });
    return ok(res, {
      pelanggan: { id: p.id, nama: p.nama, telepon: p.telepon, alamat: p.alamat, point: Number(p.point) || 0, kunjungan: Number(p.frekuensi_kedatangan) || 0 },
      transaksi: trx,
    }, 'Riwayat pelanggan');
  } catch (e) { next(e); }
}

/** PATCH /api/pelanggan/:id -> edit nama/telepon/alamat. */
async function update(req, res, next) {
  try {
    const cabangId = cabangFrom(req);
    const id = Number(req.params.id);
    const p = await pelangganModel.findById(id);
    if (!p) throw notFound('Pelanggan tidak ditemukan');
    if (cabangId && !cabangCocok(cabangId, p.cabang_id)) throw conflict('Pelanggan bukan dari cabang ini');

    const nama = String(req.body.nama || '').trim();
    const telepon = normalizeHp(req.body.telepon);
    const alamat = req.body.alamat != null ? String(req.body.alamat).trim() : null;
    if (!nama) throw badRequest('Nama wajib diisi');
    if (!telepon || telepon.length < 8) throw badRequest('Nomor telepon tidak valid');
    if (await pelangganModel.teleponDipakai(p.cabang_id, telepon, id)) throw conflict('Telepon sudah dipakai pelanggan lain');

    await pelangganModel.update(id, { nama, telepon, alamat: alamat || null });
    return ok(res, await pelangganModel.findById(id), 'Pelanggan diperbarui');
  } catch (e) { next(e); }
}

/** Perubahan #60: GET /api/pelanggan/statistik-kunjungan -> per hari (rata), per jam, antre (mesin penuh). */
async function statistikKunjungan(req, res, next) {
  try {
    const data = await require('../services/statistik-kunjungan.service').statistik(cabangFrom(req));
    return ok(res, data, 'Statistik kunjungan 30 hari');
  } catch (e) { next(e); }
}

module.exports = { search, index, riwayat, update , frekuensi , forecast , forecastTahunan, statistikKunjungan };

async function frekuensi(req, res, next) {
  try {
    const data = await pelangganModel.distribusiFrekuensi(cabangFrom(req));
    return ok(res, data, 'Distribusi frekuensi kunjungan');
  } catch (e) { next(e); }
}

async function forecast(req, res, next) {
  try {
    const data = await pelangganModel.forecastOmzet(cabangFrom(req));
    return ok(res, data, 'Forecast omzet');
  } catch (e) { next(e); }
}

async function forecastTahunan(req, res, next) {
  try {
    const data = await pelangganModel.forecastTahunan(cabangFrom(req));
    return ok(res, data, 'Forecast omzet 12 bulan');
  } catch (e) { next(e); }
}
