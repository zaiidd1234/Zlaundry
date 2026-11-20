/**
 * src/routes/kas.route.js
 * =============================================================================
 * Kas Kecil (perlu login).
 *   GET  /api/kas            -> saldo + mutasi
 *   GET  /api/kas/kategori   -> kategori beban
 *   POST /api/kas/belanja    -> catat belanja
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/kas.controller');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);
router.get('/', ctrl.ringkas);
router.get('/mutasi', ctrl.mutasiTanggal);
router.get('/reimburse/:transferId', ctrl.belanjaReimburse);
 router.get('/kategori', ctrl.kategori);
router.post('/belanja', ctrl.belanja);
router.post('/topup', ctrl.topup);
router.get('/setoran', ctrl.setoran);

module.exports = router;
