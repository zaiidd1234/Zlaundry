/**
 * server.js
 * =============================================================================
 * Entry point aplikasi.
 * - Cek koneksi DB dulu sebelum listen (fail-fast kalau DB mati).
 * - Start HTTP server.
 * - Pulihkan timer auto-complete cuci/kering setelah start + cek ulang
 *   berkala tiap 2 menit (safety-net).
 * - Graceful shutdown (SIGINT/SIGTERM): tutup server + pool DB.
 * - Tangkap unhandledRejection / uncaughtException biar ke-log, bukan diam-diam mati.
 * =============================================================================
 */

require('dotenv').config();
const app = require('./src/app');
const db = require('./src/config/database');
const logger = require('./src/config/logger');
const transaksiService = require('./src/services/transaksi.service');

const PORT = Number(process.env.PORT) || 3000;

let server;

/**
 * Timer "selesai cuci / selesai kering otomatis" disimpan di memori proses.
 * Kalau aplikasi di-restart saat ada mesin yang sedang jalan, timernya hilang
 * -> status tidak pindah sendiri. Fungsi ini menjadwalkan ulang timer semua
 * sesi mesin yang masih jalan (yang waktunya sudah lewat langsung
 * diselesaikan), lalu mengecek ulang tiap 2 menit.
 */
function pulihkanTimer() {
  Promise.all([
    transaksiService.recoverDryerTimers(),
    transaksiService.recoverWasherTimers(),
  ]).catch((e) => logger.error('Pulihkan timer mesin gagal saat startup', { err: e.message }));
  transaksiService.mulaiSafetyNetAutoComplete();
  // Perubahan #30: tutup otomatis absen kasir yang lupa absen pulang
  require('./src/services/absensi.service').mulaiPenutupOtomatis();
}

async function start() {
  try {
    // Pastikan DB nyambung dulu
    await db.testConnection();
    logger.info('Koneksi database OK');

    server = app.listen(PORT, () => {
      logger.info(`Server jalan di port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
      pulihkanTimer();
    });
  } catch (err) {
    logger.error('Gagal start: tidak bisa konek database', { err: err.message });
    process.exit(1);
  }
}

// --- Graceful shutdown ---
async function shutdown(signal) {
  logger.info(`Diterima ${signal}, mematikan server...`);
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.close();
    logger.info('Server & koneksi DB ditutup. Bye.');
    process.exit(0);
  } catch (err) {
    logger.error('Error saat shutdown', { err: err.message });
    process.exit(1);
  }
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason: reason && reason.message ? reason.message : reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { err: err.message, stack: err.stack });
  // bug serius: matikan agar tidak jalan dalam keadaan tidak konsisten
  shutdown('uncaughtException');
});

start();
