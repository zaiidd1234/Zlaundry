/**
 * src/routes/owner.route.js
 * =============================================================================
 * Perubahan #47 -- API app owner (role owner saja).
 *   GET    /api/owner/dashboard
 *   GET    /api/owner/cabang            PUT /api/owner/cabang/:id
 *   GET    /api/owner/investasi         ringkasan modal & benefit investor (#55)
 *   GET    /api/owner/user              POST /api/owner/user
 *   PATCH  /api/owner/user/:id          POST /api/owner/user/:id/reset-password
 *   DELETE /api/owner/user/:id          (permanen / nonaktif bila ada riwayat)
 *   GET    /api/owner/kas               ?dari&sampai&cabang_ids=1,2 (buku kas, pantau)
 * Performa & customer memakai endpoint manager yang sudah ada dengan
 * ?cabang_ids=1,2 (gabungan) -- lihat performa / pelanggan controller.
 * =============================================================================
 */
const express = require('express');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/role');
const svc = require('../services/owner.service');

const router = express.Router();
router.use(auth, requireRole('owner'));
const jawab = (fn, msg = 'OK') => async (req, res, next) => { try { res.json({ success: true, message: msg, data: await fn(req) }); } catch (e) { next(e); } };

router.get('/dashboard', jawab(() => svc.dashboard()));
router.get('/cabang', jawab(() => svc.daftarCabang()));
router.get('/investasi', jawab(() => svc.investasi())); // Perubahan #55
router.put('/cabang/:id', jawab((req) => svc.ubahCabang(Number(req.params.id), req.body || {}), 'Cabang disimpan'));
// Perubahan #83: saklar metode bayar per cabang { cash, qris, kiosk, poin }
router.put('/cabang/:id/metode-bayar', jawab((req) => require('../services/metode-bayar.service').ubah(Number(req.params.id), req.body || {}), 'Metode bayar disimpan'));
router.get('/user', jawab(() => svc.daftarUser()));
router.post('/user', jawab((req) => svc.tambahUser(req.body || {}), 'User ditambahkan'));
router.patch('/user/:id', jawab((req) => svc.ubahUser(Number(req.params.id), req.body || {}), 'User disimpan'));
router.post('/user/:id/reset-password', jawab((req) => svc.resetPassword(Number(req.params.id), (req.body || {}).password), 'Password direset'));
router.delete('/user/:id', jawab((req) => svc.hapusUser(Number(req.params.id))));
router.get('/kas', jawab((req) => require('../services/owner-kas.service').bukuKas(req.query || {})));

module.exports = router;
