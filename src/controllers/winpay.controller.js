/**
 * src/controllers/winpay.controller.js
 * =============================================================================
 * Webhook PUBLIK yang dipanggil server Winpay (BUKAN dari browser kita), jadi
 * TIDAK ada auth token biasa -- keamanannya dari validasi X-Signature pakai
 * public key Winpay (lihat src/config/winpay.js:verifyCallbackSignature).
 * =============================================================================
 */

const winpayConfig = require('../config/winpay');
const pembayaranQrisService = require('../services/pembayaran-qris.service');
const logger = require('../config/logger');

const ENDPOINT_NOTIFY = '/v1.0/qr/qr-mpm-notify';

/** POST /api/winpay/qr-mpm-notify */
async function notify(req, res) {
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];

  const valid = signature && timestamp && winpayConfig.verifyCallbackSignature({
    method: 'POST', endpointUrl: ENDPOINT_NOTIFY,
    // #78: coba juga path lengkap yang dipanggil Winpay (mis. /api/winpay/v1.0/qr/qr-mpm-notify)
    endpointUrls: [String(req.originalUrl || '').split('?')[0], '/api/winpay' + ENDPOINT_NOTIFY],
    rawBody: req.rawBody ? req.rawBody.toString('utf8') : undefined,
    body: req.body, timestamp, signature,
  });

  if (!valid) {
    logger.error('Winpay callback signature invalid/ditolak', {
      alasan: !winpayConfig.isCallbackConfigured() ? 'WINPAY_PUBLIC_KEY kosong' : (!signature || !timestamp ? 'header X-Signature/X-Timestamp kosong' : 'signature tidak cocok'),
      path: req.originalUrl, timestamp, partner: req.headers['x-partner-id'], body: req.body,
    });
    // Format response tetap ngikutin skema SNAP walau ditolak, biar Winpay
    // gak nganggep server kita error/gak paham -- cuma beda response code.
    return res.status(401).json({ responseCode: '4015200', responseMessage: 'Invalid signature' });
  }

  try {
    await pembayaranQrisService.prosesCallback(req.body);
    return res.status(200).json({ responseCode: '2005200', responseMessage: 'success' });
  } catch (e) {
    logger.error('Winpay callback processing error', { err: e.message, body: req.body });
    // Tetap 200 kalau errornya "sesi tidak ditemukan" dkk biar Winpay gak retry
    // terus buat referensi yang emang gak akan pernah ketemu di sisi kita;
    // untuk error lain (mis. DB down), balikin 500 biar Winpay retry.
    if (e.statusCode && e.statusCode < 500) {
      // docs: respons yg diharapkan persis {2005200, "success"} -- peringatan cukup di log
      logger.warn('Winpay callback diterima dengan peringatan', { err: e.message });
      return res.status(200).json({ responseCode: '2005200', responseMessage: 'success' });
    }
    return res.status(500).json({ responseCode: '5005200', responseMessage: 'Internal error' });
  }
}

module.exports = { notify };
