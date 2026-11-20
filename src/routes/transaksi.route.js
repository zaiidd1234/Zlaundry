/**
 * src/routes/transaksi.route.js
 * =============================================================================
 * Rute transaksi (perlu login staff: kasir/operator/owner/manager).
 *   POST /api/transaksi            buat order
 *   POST /api/transaksi/:id/bayar  bayar
 *   GET  /api/transaksi/:id        detail
 * =============================================================================
 */

const express = require('express');
const ctrl = require('../controllers/transaksi.controller');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const validate = require('../middleware/validate');
const { createOrderSchema, bayarSchema, idParamSchema, pindahStatusSchema, gantiMesinSchema } = require('../validations/transaksi.validation');

const router = express.Router();

router.use(auth);

// Yang boleh transaksi: kasir, operator, owner (manager umumnya read; sesuaikan bila perlu)
const bisaTransaksi = requireRole('kasir', 'operator', 'manager', 'owner'); // Perubahan #28: manager boleh kerja di app kasir

router.post('/', bisaTransaksi, validate(createOrderSchema), ctrl.create);
router.get('/', ctrl.list);
router.get('/riwayat', ctrl.riwayat);
router.get('/rekap-terjual', ctrl.rekapTerjual); // Perubahan #62
router.get('/antrian', ctrl.antrian);
router.post('/:id/bayar', bisaTransaksi, validate(idParamSchema, 'params'), validate(bayarSchema), ctrl.bayar);
router.post('/:id/tukar-poin', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.tukarPoin);
router.post('/:id/reserve-poin', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.reservePoin);
router.post('/:id/ganti-pelanggan', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.gantiPelanggan);
router.post('/:id/status', bisaTransaksi, validate(idParamSchema, 'params'), validate(pindahStatusSchema), ctrl.pindahStatus);
router.post('/:id/posisi-manual', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.setPosisiManual);
router.post('/:id/ganti-mesin', bisaTransaksi, validate(idParamSchema, 'params'), validate(gantiMesinSchema), ctrl.gantiMesin);
router.post('/:id/restart-proses', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.restartProses);
router.get('/:id/ubah-pesanan', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.ubahInfo);
router.post('/:id/ubah-pesanan/pratinjau', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.ubahPratinjau);
router.post('/:id/ubah-pesanan', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.ubahSimpan);
router.post('/:id/resume-kering', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.resumeKering);
router.post('/:id/selesai-cuci', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.selesaiCuci);
router.post('/:id/onoff-mesin', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.onOffMesin);
router.post('/:id/bayar-saat-ambil', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.bayarSaatAmbil);
router.post('/:id/start-alarm', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.startSetelahAlarm);
router.post('/:id/sudah-diambil', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.sudahDiambilLangsung);
router.get('/:id', validate(idParamSchema, 'params'), ctrl.detail);
router.delete('/:id', bisaTransaksi, validate(idParamSchema, 'params'), ctrl.batal);
// Perubahan #48 / #49: wewenang OWNER -- hapus transaksi (termasuk lunas) & hold antrian
const hanyaOwner = requireRole('owner');
router.post('/:id/hapus-owner', hanyaOwner, validate(idParamSchema, 'params'), async (req, res, next) => {
  try { res.json({ success: true, message: 'Transaksi dihapus', data: await require('../services/transaksi-hapus.service').hapus(Number(req.params.id), { alasan: (req.body || {}).alasan, karyawanId: req.user.id }) }); } catch (e) { next(e); }
});
router.post('/:id/tahan', hanyaOwner, validate(idParamSchema, 'params'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = await require('../services/antrian-mesin.service').tahanTransaksi(Number(req.params.id), { tahan: b.tahan !== false, alasan: b.alasan, karyawanId: req.user.id });
    res.json({ success: true, message: data.ditahan ? 'Pesanan ditahan' : 'Hold dilepas', data });
  } catch (e) { next(e); }
});

module.exports = router;
