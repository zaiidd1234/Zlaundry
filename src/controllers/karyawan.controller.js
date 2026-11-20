/**
 * src/controllers/karyawan.controller.js
 * =============================================================================
 * Kelola karyawan oleh manager/owner (scope cabang dari token).
 *   GET    /api/karyawan            -> daftar (kasir/operator/kurir)
 *   POST   /api/karyawan            -> tambah { nama, username, role, password }
 *   PATCH  /api/karyawan/:id        -> edit { nama, role }
 *   PATCH  /api/karyawan/:id/status -> { status: aktif|nonaktif }
 *   POST   /api/karyawan/:id/reset-password -> { password }
 * =============================================================================
 */

const karyawanService = require('../services/karyawan.service');
const { ok, created } = require('../helpers/response');

function cabangFrom(req) {
  let cabangId = req.user.cabang_id;
  if (req.user.role === 'owner' && (req.query.cabang_id || (req.body && req.body.cabang_id))) {
    cabangId = Number(req.query.cabang_id || req.body.cabang_id);
  }
  return cabangId;
}

async function index(req, res, next) {
  try {
    return ok(res, await karyawanService.daftar(cabangFrom(req)), 'Daftar karyawan');
  } catch (e) { next(e); }
}

async function tambah(req, res, next) {
  try {
    const data = await karyawanService.tambah(cabangFrom(req), req.body || {});
    return created(res, data, 'Karyawan ditambahkan');
  } catch (e) { next(e); }
}

async function edit(req, res, next) {
  try {
    const body = req.body || {};
    if (req.user.role !== 'owner' && body.jatah_cuci_mingguan !== undefined && body.jatah_cuci_mingguan !== null && body.jatah_cuci_mingguan !== '') {
      const k = await require('../models/karyawan.model').findById(Number(req.params.id));
      if (k && Number(body.jatah_cuci_mingguan) !== Number(k.jatah_cuci_mingguan)) throw require('../helpers/errors').forbidden('Jatah cuci hanya bisa diubah owner');
    }
    const data = await karyawanService.edit(Number(req.params.id), cabangFrom(req), body, req.user.role);
    return ok(res, data, 'Karyawan diperbarui');
  } catch (e) { next(e); }
}

async function status(req, res, next) {
  try {
    const data = await karyawanService.ubahStatus(Number(req.params.id), cabangFrom(req), req.body.status);
    return ok(res, data, 'Status karyawan diubah');
  } catch (e) { next(e); }
}

async function resetPassword(req, res, next) {
  try {
    const data = await karyawanService.resetPassword(Number(req.params.id), cabangFrom(req), req.body.password);
    return ok(res, data, 'Password direset');
  } catch (e) { next(e); }
}

module.exports = { index, tambah, edit, status, resetPassword };
