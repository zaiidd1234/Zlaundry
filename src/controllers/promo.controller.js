/**
 * src/controllers/promo.controller.js
 * =============================================================================
 * Kelola promo cuci gratis -- disimpan sebagai baris layanan tersendiri
 * (is_promo=1, kategori='cuci'). "Nonaktifkan promo" = set status baris itu
 * jadi 'nonaktif' (reuse mekanisme aktif/nonaktif yang sudah ada di layanan).
 *   GET   /api/promo/pengaturan            -> daftar baris promo cabang ini (aktif & nonaktif)
 *   PATCH /api/promo/pengaturan            -> body: { jenis_promo, aktif } -> ubah status 1 baris
 * owner boleh override ?cabang_id= (mirip pola manager.controller.js/mesin.controller.js).
 * =============================================================================
 */

const layananModel = require('../models/layanan.model');
const { ok } = require('../helpers/response');
const { badRequest, notFound } = require('../helpers/errors');

const JENIS_VALID = ['gratis_cuci_pelanggan_baru', 'gratis_cuci_jumat_berkah'];

function cabangIdFrom(req) {
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    return Number(req.query.cabang_id || req.body.cabang_id);
  }
  return req.user.cabang_id;
}

function bentukRow(l) {
  const hariIni = new Date().toISOString().slice(0, 10);
  const mulaiOk = !l.tanggal_mulai || String(l.tanggal_mulai).slice(0, 10) <= hariIni;
  const selesaiOk = !l.tanggal_selesai || String(l.tanggal_selesai).slice(0, 10) >= hariIni;
  return {
    layanan_id: l.id,
    jenis_promo: l.jenis_promo,
    nama_paket: l.nama_paket,
    harga_normal: Number(l.harga),
    harga_promo: Number(l.harga_promo) || 0,
    aktif: l.status === 'aktif',
    tanggal_mulai: l.tanggal_mulai || null,
    tanggal_selesai: l.tanggal_selesai || null,
    // aktif betulan cuma kalau status='aktif' DAN hari ini masih dalam rentang
    // tanggal (kalau tanggal diisi). Dikirim terpisah dari `aktif` (status
    // mentah) supaya UI bisa kasih tau kalau kondisinya "aktif tapi expired".
    sedang_berjalan: l.status === 'aktif' && mulaiOk && selesaiOk,
  };
}

/** GET /api/promo/pengaturan?cabang_id= */
async function getPengaturan(req, res, next) {
  try {
    const rows = await layananModel.findAllPromoByCabang(cabangIdFrom(req));
    return ok(res, rows.map(bentukRow), 'Pengaturan promo');
  } catch (e) { next(e); }
}

/** PATCH /api/promo/pengaturan  body: { jenis_promo, aktif, cabang_id? (owner) } */
async function updatePengaturan(req, res, next) {
  try {
    const cabangId = cabangIdFrom(req);
    const { jenis_promo, aktif } = req.body || {};
    if (!JENIS_VALID.includes(jenis_promo)) throw badRequest('jenis_promo tidak valid');
    if (typeof aktif !== 'boolean') throw badRequest('aktif harus true/false');

    const rows = await layananModel.findAllPromoByCabang(cabangId);
    const target = rows.find((r) => r.jenis_promo === jenis_promo);
    if (!target) throw notFound(`Baris layanan promo '${jenis_promo}' belum di-setup untuk cabang ini`);

    await layananModel.setStatusPromo(target.id, aktif ? 'aktif' : 'nonaktif');

    const updatedRows = await layananModel.findAllPromoByCabang(cabangId);
    return ok(res, updatedRows.map(bentukRow), 'Pengaturan promo diperbarui');
  } catch (e) { next(e); }
}

module.exports = { getPengaturan, updatePengaturan };
