/**
 * src/helpers/errors.js
 * =============================================================================
 * Error class terstruktur untuk seluruh app.
 * - AppError: error "yang diharapkan" (operational), punya statusCode + kode.
 * - Factory siap pakai: badRequest, unauthorized, forbidden, notFound,
 *   conflict, validation, tooMany, internal.
 *
 * Dipakai di service/controller:
 *   const { notFound } = require('../helpers/errors');
 *   if (!pelanggan) throw notFound('Pelanggan tidak ditemukan');
 *
 * errorHandler (middleware) akan baca statusCode/kode/details untuk bentuk response.
 * =============================================================================
 */

class AppError extends Error {
  /**
   * @param {string} message  pesan untuk user
   * @param {number} statusCode  HTTP status (default 500)
   * @param {string} code  kode mesin (mis. 'NOT_FOUND') untuk frontend
   * @param {*} details  detail tambahan (mis. error validasi per field)
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // menandai error yang sudah ditangani, bukan bug
    Error.captureStackTrace(this, this.constructor);
  }
}

// --- Factory ringkas ---
const badRequest   = (msg = 'Permintaan tidak valid', details = null) => new AppError(msg, 400, 'BAD_REQUEST', details);
const unauthorized = (msg = 'Tidak terautentikasi')                  => new AppError(msg, 401, 'UNAUTHORIZED');
const forbidden    = (msg = 'Tidak punya akses')                     => new AppError(msg, 403, 'FORBIDDEN');
const notFound     = (msg = 'Data tidak ditemukan')                  => new AppError(msg, 404, 'NOT_FOUND');
const conflict     = (msg = 'Konflik data', details = null)          => new AppError(msg, 409, 'CONFLICT', details);
const validation   = (msg = 'Validasi gagal', details = null)        => new AppError(msg, 422, 'VALIDATION_ERROR', details);
const tooMany      = (msg = 'Terlalu banyak permintaan')             => new AppError(msg, 429, 'TOO_MANY_REQUESTS');
const internal     = (msg = 'Terjadi kesalahan server')              => new AppError(msg, 500, 'INTERNAL_ERROR');

module.exports = {
  AppError,
  badRequest, unauthorized, forbidden, notFound,
  conflict, validation, tooMany, internal,
};
