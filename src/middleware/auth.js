/**
 * src/middleware/auth.js
 * =============================================================================
 * Middleware autentikasi: baca header Authorization: Bearer <token>,
 * verifikasi JWT, isi req.user = { id, role, cabang_id }.
 * Lempar 401 kalau token tidak ada / invalid / expired.
 * =============================================================================
 */

const jwtUtil = require('../config/jwt');
const { unauthorized, AppError } = require('../helpers/errors');

// Perubahan #27: gerbang absensi -- role kasir wajib punya sesi absen masuk
// hari ini (belum absen pulang) untuk memakai API selain /auth & /absensi.
// Manager / owner / operator tidak kena gerbang ini. Cabang dengan
// absensi_aktif = 0 (Perubahan #29b) juga bebas.
const BEBAS_GERBANG = /^\/api\/(auth|absensi)(\/|$|\?)/;
function gerbangAbsen(req, next) {
  if (req.user.role !== 'kasir' || BEBAS_GERBANG.test(req.originalUrl || '')) return next();
  // require di sini (bukan di atas) supaya tidak ada siklus require saat start
  require('../services/absensi.service').bolehAkses(req.user)
    .then((boleh) => {
      if (boleh) return next();
      return next(new AppError('Absen masuk dulu untuk membuka menu kasir.', 403, 'ABSEN_WAJIB'));
    })
    .catch(next);
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Token tidak ditemukan'));
  }

  try {
    const payload = jwtUtil.verify(token);
    req.user = {
      id: payload.sub ?? payload.id,
      role: payload.role,
      cabang_id: payload.cabang_id,
    };
    // Perubahan #47: owner bekerja di cabang pilihan (app manager / kasir)
    // lewat header X-Cabang-Id. Role lain diabaikan (tetap cabang akunnya).
    const hc = Number(req.headers['x-cabang-id']);
    if (req.user.role === 'owner' && Number.isInteger(hc) && hc > 0) {
      req.user.cabang_asal = req.user.cabang_id;
      req.user.cabang_id = hc;
      req.user.cabang_dipilih = true;
    }
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token kedaluwarsa' : 'Token tidak valid';
    return next(unauthorized(msg));
  }
  return cekPasswordDiubah(req, iatToken(token))
    .then((masihBerlaku) => {
      if (!masihBerlaku) return next(new AppError('Password sudah diganti, silakan login ulang.', 401, 'PASSWORD_DIGANTI'));
      return gerbangAbsen(req, next);
    })
    .catch(next);
}

// Perubahan #82: token yang dibuat sebelum password diganti/direset ditolak.
// Cache singkat per user supaya tidak query DB tiap request.
const CACHE_MS = 15000;
const cachePw = new Map(); // id -> { ts, sampai }
// waktu terbit token (ms): klaim `ms` (token baru) atau iat*1000 (token lama)
function iatToken(token) {
  try {
    const p = jwtUtil.decode(token) || {};
    if (p.ms != null) return Number(p.ms);
    return p.iat != null ? Number(p.iat) * 1000 : null;
  } catch (e) { return null; }
}
async function cekPasswordDiubah(req, iat) {
  const id = Number(req.user.id);
  if (!id) return true;
  const now = Date.now();
  let c = cachePw.get(id);
  if (!c || c.sampai < now) {
    const ts = await require('../models/karyawan.model').passwordDiubahTs(id);
    c = { ts, sampai: now + CACHE_MS };
    cachePw.set(id, c);
    if (cachePw.size > 5000) cachePw.clear();
  }
  if (c.ts == null || iat == null) return true;
  return Number(iat) >= c.ts;
}
function lupakanCache(id) { cachePw.delete(Number(id)); }

module.exports = auth;
module.exports.lupakanCache = lupakanCache;
