/**
 * src/controllers/auth.controller.js
 * =============================================================================
 * Controller autentikasi. Tipis: ambil input, panggil service, balas pakai response helper.
 * Error dilempar ke errorHandler via next(err).
 * =============================================================================
 */

const authService = require('../services/auth.service');
const { ok } = require('../helpers/response');

/** POST /api/auth/login  body: { username, password } */
async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    const result = await authService.login(username, password);
    return ok(res, result, 'Login berhasil');
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/me  (perlu token; req.user diisi middleware auth) */
async function me(req, res, next) {
  try {
    const profile = await authService.getProfile(req.user.id);
    return ok(res, profile, 'Profil');
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/ganti-password  body: { password_lama, password_baru } (Perubahan #82) */
async function gantiPassword(req, res, next) {
  try {
    const b = req.body || {};
    const result = await authService.gantiPassword(req.user.id, b.password_lama, b.password_baru);
    return ok(res, result, 'Password berhasil diganti');
  } catch (err) {
    next(err);
  }
}

module.exports = { login, me, gantiPassword };
