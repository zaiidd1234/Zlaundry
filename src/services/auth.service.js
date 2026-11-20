/**
 * src/services/auth.service.js
 * =============================================================================
 * Logika autentikasi staff.
 * - login(username, password): cek user, verifikasi bcrypt, cek status aktif,
 *   terbitkan JWT. Return { token, user } (user tanpa password_hash).
 * - getProfile(id): ambil data karyawan untuk GET /auth/me.
 *
 * Catatan keamanan: pesan error login dibuat samar ("username atau password salah")
 * supaya tidak membocorkan apakah username ada atau tidak.
 * =============================================================================
 */

const bcrypt = require('bcryptjs');
const karyawanModel = require('../models/karyawan.model');
const jwtUtil = require('../config/jwt');
const { unauthorized, forbidden, notFound, badRequest } = require('../helpers/errors');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

/** Buang field sensitif sebelum dikirim ke client. */
function toPublic(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row; // eslint-disable-line no-unused-vars
  return safe;
}

async function login(username, password) {
  const user = await karyawanModel.findForAuth(username);

  // Samakan respons baik username tidak ada maupun password salah.
  if (!user) throw unauthorized('Username atau password salah');

  const cocok = await bcrypt.compare(password, user.password_hash || '');
  if (!cocok) throw unauthorized('Username atau password salah');

  if (user.status !== 'aktif') throw forbidden('Akun nonaktif, hubungi admin');

  const token = jwtUtil.sign({
    sub: user.id,
    role: user.role,
    cabang_id: user.cabang_id,
    ms: Date.now(), // #82: waktu terbit (ms) untuk cek password diganti
  });

  return {
    token, expiresIn: jwtUtil.EXPIRES_IN, user: toPublic(user),
    app: { allow_backdate: String(process.env.ALLOW_BACKDATE || '').toLowerCase() === 'true' },
  };
}

async function getProfile(id) {
  const user = await karyawanModel.findById(id);
  if (!user) throw notFound('Karyawan tidak ditemukan');
  return user; // findById sudah tanpa password_hash
}

/**
 * Perubahan #82: ganti password sendiri (semua role staff yang login).
 * Cek password lama, min. 6 karakter, harus beda. Setelah ganti, token di
 * perangkat lain ditolak (password_diubah_at); perangkat ini dapat token baru.
 */
async function gantiPassword(userId, passwordLama, passwordBaru) {
  const lama = String(passwordLama || '');
  const baru = String(passwordBaru || '');
  if (!lama) throw badRequest('Password lama wajib diisi');
  if (baru.length < 6) throw badRequest('Password baru minimal 6 karakter');
  if (baru.length > 255) throw badRequest('Password baru terlalu panjang');
  const hash = await karyawanModel.passwordHashById(userId);
  if (!hash) throw notFound('Akun tidak ditemukan');
  if (!(await bcrypt.compare(lama, hash))) throw badRequest('Password lama salah');
  if (lama === baru) throw badRequest('Password baru harus beda dengan password lama');
  await karyawanModel.setPassword(userId, await bcrypt.hash(baru, BCRYPT_ROUNDS));
  const user = await karyawanModel.findById(userId);
  const token = jwtUtil.sign({ sub: user.id, role: user.role, cabang_id: user.cabang_id, ms: Date.now() });
  return { token, expiresIn: jwtUtil.EXPIRES_IN };
}

module.exports = { login, getProfile, gantiPassword };
