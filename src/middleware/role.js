/**
 * src/middleware/role.js
 * =============================================================================
 * Guard role. Dipasang SETELAH middleware auth.
 *   requireRole('owner', 'manager')  -> hanya role itu yang lolos.
 * Owner diasumsikan punya akses lintas-cabang (cek cabang dilakukan di service bila perlu).
 * Lempar 403 kalau role tidak diizinkan.
 * =============================================================================
 */

const { forbidden, unauthorized } = require('../helpers/errors');

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized('Belum login'));
    if (!allowed.includes(req.user.role)) {
      return next(forbidden('Role tidak diizinkan untuk aksi ini'));
    }
    next();
  };
}

module.exports = requireRole;
