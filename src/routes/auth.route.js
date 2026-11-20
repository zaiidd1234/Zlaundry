/**
 * src/routes/auth.route.js
 * =============================================================================
 * Rute autentikasi:
 *   POST /api/auth/login   (publik)        -> login, dapat token
 *   GET  /api/auth/me      (perlu token)   -> profil staff saat ini
 *   POST /api/auth/ganti-password (perlu token) -> ganti password sendiri (#82)
 * =============================================================================
 */

const express = require('express');
const authController = require('../controllers/auth.controller');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const { loginSchema } = require('../validations/auth.validation');

const router = express.Router();

router.post('/login', validate(loginSchema), authController.login);
router.get('/me', auth, authController.me);
router.post('/ganti-password', auth, authController.gantiPassword);

module.exports = router;
