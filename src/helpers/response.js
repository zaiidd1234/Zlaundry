/**
 * src/helpers/response.js
 * =============================================================================
 * Format response JSON seragam untuk seluruh endpoint.
 *
 * Sukses:  { success: true, message, data, meta? }
 * Gagal :  { success: false, message, code, details? }  (dipakai errorHandler)
 *
 * Pemakaian di controller:
 *   const { ok, created } = require('../helpers/response');
 *   return ok(res, data, 'Berhasil');
 *   return created(res, data, 'Pelanggan dibuat');
 *   return ok(res, rows, 'Daftar transaksi', meta); // meta = paginasi
 * =============================================================================
 */

/** Response sukses generik. */
function success(res, { statusCode = 200, message = 'OK', data = null, meta = null }) {
  const body = { success: true, message };
  if (data !== null) body.data = data;
  if (meta !== null) body.meta = meta;
  return res.status(statusCode).json(body);
}

/** 200 OK */
const ok = (res, data = null, message = 'OK', meta = null) =>
  success(res, { statusCode: 200, message, data, meta });

/** 201 Created */
const created = (res, data = null, message = 'Data berhasil dibuat') =>
  success(res, { statusCode: 201, message, data });

/** 204 No Content (tanpa body) */
const noContent = (res) => res.status(204).send();

/** Response gagal (dipakai errorHandler; jarang dipanggil manual). */
function fail(res, { statusCode = 500, message = 'Error', code = 'INTERNAL_ERROR', details = null }) {
  const body = { success: false, message, code };
  if (details !== null) body.details = details;
  return res.status(statusCode).json(body);
}

module.exports = { success, ok, created, noContent, fail };
