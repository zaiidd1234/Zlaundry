/**
 * src/middleware/errorHandler.js
 * =============================================================================
 * Penanganan error terpusat.
 *
 * Export:
 *   notFoundHandler  -> untuk route yang tidak match (404), dipasang setelah semua route.
 *   errorHandler     -> error handler Express (4 argumen), dipasang PALING AKHIR.
 *
 * Perilaku:
 *   - AppError (operational)        -> pakai statusCode/code/details-nya, log level warn.
 *   - Error MySQL umum (mis. dup)   -> diterjemahkan ke pesan yang ramah.
 *   - Error tak terduga (bug)       -> 500, log level error + stack; pesan disembunyikan di production.
 * =============================================================================
 */

const logger = require('../config/logger');
const { AppError } = require('../helpers/errors');
const { fail } = require('../helpers/response');

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

/** Route tidak ditemukan -> lempar 404 ke errorHandler. */
function notFoundHandler(req, res, next) {
  next(new AppError(`Rute tidak ditemukan: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
}

/** Terjemahkan beberapa error MySQL/MariaDB umum jadi AppError yang ramah. */
function mapDbError(err) {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return new AppError('Data sudah ada (duplikat).', 409, 'DUPLICATE', isDev ? err.sqlMessage : null);
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_NO_REFERENCED_ROW':
      return new AppError('Referensi data tidak valid (foreign key).', 400, 'FK_INVALID', isDev ? err.sqlMessage : null);
    case 'ER_ROW_IS_REFERENCED_2':
    case 'ER_ROW_IS_REFERENCED':
      return new AppError('Data tidak bisa dihapus karena masih dipakai.', 409, 'FK_IN_USE', isDev ? err.sqlMessage : null);
    case 'ER_BAD_NULL_ERROR':
      return new AppError('Ada kolom wajib yang kosong.', 400, 'NULL_NOT_ALLOWED', isDev ? err.sqlMessage : null);
    case 'ER_DATA_TOO_LONG':
      return new AppError('Data terlalu panjang untuk kolomnya.', 400, 'DATA_TOO_LONG', isDev ? err.sqlMessage : null);
    default:
      return null; // bukan error DB yang kita kenal
  }
}

/** Error handler Express (harus punya 4 argumen). */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let appErr = err;

  // Bukan AppError? coba terjemahkan dari error DB, kalau tidak -> internal 500.
  if (!(err instanceof AppError)) {
    appErr = mapDbError(err) || new AppError(
      isDev ? err.message : 'Terjadi kesalahan server',
      500,
      'INTERNAL_ERROR'
    );
  }

  // Logging: operational (4xx) cukup warn; selain itu error + stack.
  const logMeta = {
    method: req.method,
    url: req.originalUrl,
    code: appErr.code,
    status: appErr.statusCode,
    userId: req.user ? req.user.id : undefined,
  };
  if (appErr.statusCode >= 500) {
    logger.error(err.stack || err.message, logMeta);
  } else {
    logger.warn(appErr.message, logMeta);
  }

  const details = appErr.details || (isDev && appErr.statusCode >= 500 ? { stack: err.stack } : null);

  return fail(res, {
    statusCode: appErr.statusCode || 500,
    message: appErr.message,
    code: appErr.code || 'INTERNAL_ERROR',
    details,
  });
}

module.exports = { notFoundHandler, errorHandler };
