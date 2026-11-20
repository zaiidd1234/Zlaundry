/**
 * src/config/jwt.js
 * =============================================================================
 * Helper JWT: sign & verify token akses staff.
 * Secret & masa berlaku dari .env (JWT_SECRET, JWT_EXPIRES_IN).
 *
 * Payload token yang kita pakai (minimal, tanpa data sensitif):
 *   { sub: <id karyawan>, role: <nama_role>, cabang_id: <id> }
 * =============================================================================
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!SECRET) {
  // fail-fast saat boot kalau secret belum diset (kecuali test)
  throw new Error('JWT_SECRET belum diset di .env');
}

/** Terbitkan token dari payload. */
function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

/** Verifikasi token; lempar error kalau invalid/expired. Return payload. */
function verify(token) {
  return jwt.verify(token, SECRET);
}

/** Baca payload tanpa verifikasi (dipakai setelah verify berhasil). */
function decode(token) {
  return jwt.decode(token);
}

module.exports = { sign, verify, decode, EXPIRES_IN };
