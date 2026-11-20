/**
 * src/routes/kas-besar.route.js
 * =============================================================================
 * Kas Besar. Semua perlu login + role manager/owner.
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/kas-besar.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');

const router = express.Router();
router.use(auth);
router.use(requireRole('manager', 'owner'));

router.get('/', ctrl.ringkas);
router.get('/winpay', ctrl.saldoWinpay);       // #83
router.post('/winpay/tarik', ctrl.tarikWinpay); // #83
router.get('/setoran', ctrl.setoran);
router.get('/kategori', ctrl.kategori);
router.get('/kategori-akrual', ctrl.kategoriAkrual);
router.get('/beban', ctrl.riwayatBeban);
router.post('/beban', ctrl.inputBeban);
router.post('/akrual', ctrl.inputAkrual);
router.get('/kategori-distribusi', ctrl.kategoriDistribusi);
router.post('/distribusi', ctrl.inputDistribusi);
router.get('/detail', ctrl.detail);
router.get('/export', ctrl.exportData);

module.exports = router;
