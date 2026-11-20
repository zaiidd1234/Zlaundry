/**
 * src/routes/transfer.route.js
 * =============================================================================
 * Rute setoran (perlu login). Setor: kasir/owner. Riwayat: + manager.
 *   GET  /api/transfer/preview
 *   POST /api/transfer
 *   GET  /api/transfer
 *   POST /api/transfer/:id/bukti   (multipart field 'bukti')
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/transfer.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const upload = require('../config/multer');

const router = express.Router();
router.use(auth);

const bisaSetor = requireRole('kasir', 'manager', 'owner'); // Perubahan #28

router.get('/preview', bisaSetor, ctrl.preview);
router.post('/', bisaSetor, ctrl.setor);
router.get('/', requireRole('kasir', 'manager', 'owner'), ctrl.riwayat);
router.post('/:id/bukti', bisaSetor, upload.single('bukti'), ctrl.uploadBukti);

module.exports = router;
