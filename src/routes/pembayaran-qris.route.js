/**
 * src/routes/pembayaran-qris.route.js
 * =============================================================================
 * Rute kasir (perlu login) buat generate QRIS dinamis via Winpay.
 *   GET  /api/pembayaran-qris/tagihan?pelanggan_id=   daftar tagihan belum lunas
 *   POST /api/pembayaran-qris   body:{pelanggan_id,transaksi_ids[]}  generate QR
 *   GET  /api/pembayaran-qris/:id   polling status bayar
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/pembayaran-qris.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const validate = require('../middleware/validate');
const { generateQrisSchema } = require('../validations/pembayaran-qris.validation');

const router = express.Router();

router.use(auth);
const bisaTransaksi = requireRole('kasir', 'operator', 'manager', 'owner'); // Perubahan #28: manager boleh kerja di app kasir

router.get('/tagihan', bisaTransaksi, ctrl.tagihan);
router.post('/', bisaTransaksi, validate(generateQrisSchema), ctrl.generate);
router.get('/:id', bisaTransaksi, ctrl.status);

module.exports = router;
