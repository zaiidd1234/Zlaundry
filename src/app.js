/**
 * src/app.js
 * =============================================================================
 * Rakit Express app: middleware global, health-check, mount routes, 404, errorHandler.
 * Belum ada route bisnis (Fase 2+). Untuk sekarang baru /health & /api/health.
 *
 * Export: app (dipakai server.js untuk listen).
 * =============================================================================
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const logger = require('./config/logger');
const db = require('./config/database');
const { ok } = require('./helpers/response');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// --- Keamanan & util dasar ---
app.disable('x-powered-by');
app.set('trust proxy', 1); // di belakang reverse proxy (nginx)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
      // Winpay: gambar QR (qrUrl) diambil langsung dari server Winpay,
      // mis. https://sandbox-payment.winpay.id/scqr/get_image_qr?payid=...
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com',
        'https://winpay.id', 'https://*.winpay.id', 'https://*.bmstaging.id'],
      connectSrc: ["'self'", 'https://unpkg.com', 'https://router.project-osrm.org', 'https://nominatim.openstreetmap.org', 'https://cdnjs.cloudflare.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Header2 ini didesain buat deployment HTTPS -- di sini app disajikan HTTP
  // (Docker lokal / akses LAN via IP), jadi cuma bikin warning gak berguna di
  // console browser tanpa manfaat keamanan nyata. Matikan biar bersih.
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  hsts: false,
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(compression());
// verify: simpan raw body bytes ke req.rawBody -- dibutuhkan buat validasi
// signature callback Winpay (harus hash body PERSIS kayak yang Winpay
// kirim/hash, bukan hasil JSON.stringify ulang yang urutan key-nya bisa beda).
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// --- Request logger (morgan -> winston) ---
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: logger.stream }));

// --- Health check (tanpa auth) ---
// Liveness: proses hidup.
app.get('/health', (req, res) => ok(res, { uptime: process.uptime() }, 'OK'));

// Readiness: cek koneksi DB juga.
app.get('/api/health', async (req, res, next) => {
  try {
    await db.testConnection();
    return ok(res, { db: 'connected', uptime: process.uptime() }, 'Service siap');
  } catch (err) {
    next(err);
  }
});

// --- Mount routes bisnis ---
const routes = require('./routes');
app.use('/api', routes);

// --- Sajikan UI statik (public/customer, public/kasir, public/manager, public/owner) ---
const path = require('path');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// index.html tiap app: no-cache + penanda versi otomatis di app.js/config.js
// (HP langsung pakai tampilan terbaru setelah upload, tanpa hapus cache)
app.use(require('./middleware/versiAset').versiAset(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));
// helmet CSP default bisa blokir CDN (font-awesome/leaflet); UI ini statik sederhana,
// jadi izinkan resource eksternal yang dipakai. (atur lebih ketat saat produksi bila perlu)
app.get('/', (req, res) => res.redirect('/customer/'));

// --- 404 & error handler (PALING AKHIR) ---
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
