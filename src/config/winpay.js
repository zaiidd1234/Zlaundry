/**
 * src/config/winpay.js
 * =============================================================================
 * Config + helper signing buat integrasi Winpay QRIS (SNAP API, skema
 * "Asymmetric Without Get Token" -- tiap request ditandatangani langsung
 * pakai private key kita, gak perlu ambil access token dulu).
 *
 * ENV yang WAJIB diisi di .env (belum diisi sekarang, nunggu owner kasih
 * credential dari akun Winpay-nya):
 *   WINPAY_BASE_URL       - base URL API Winpay (sandbox atau production)
 *   WINPAY_PARTNER_ID     - Partner ID / merchant ID dari Winpay
 *   WINPAY_PRIVATE_KEY    - private key KITA (PEM, dipakai buat nandatangani
 *                           request YANG KITA KIRIM ke Winpay). Simpan PEM
 *                           dengan newline di-escape "\n" di .env, nanti
 *                           di-decode di sini.
 *   WINPAY_PUBLIC_KEY     - public key WINPAY (PEM, dipakai buat validasi
 *                           signature callback/notify YANG MASUK dari Winpay)
 *   WINPAY_CHANNEL_ID     - isi header CHANNEL-ID (bebas, default 95221) [#78]
 *   PEM boleh ditulis multi-baris di dalam "..." (dotenv 16) atau satu
 *   baris dengan "\n".
 *   WINPAY_CALLBACK_URL   - (opsional, buat dokumentasi/registrasi ke Winpay)
 *
 * Kalau salah satu env di atas belum diisi, semua fungsi di winpay.service.js
 * bakal gagal dengan pesan jelas ("Winpay belum dikonfigurasi") -- bukan
 * error mentah -- jadi fitur QRIS dinamis otomatis "nonaktif" sampai
 * credential-nya dipasang, tanpa bikin bagian lain aplikasi ikut error.
 * =============================================================================
 */

const crypto = require('crypto');
const logger = require('./logger');

const WINPAY_BASE_URL = (process.env.WINPAY_BASE_URL || '').trim().replace(/\/+$/, '');
const WINPAY_PARTNER_ID = (process.env.WINPAY_PARTNER_ID || '').trim();
// #78: header CHANNEL-ID wajib di SNAP; Winpay membebaskan isinya.
const WINPAY_CHANNEL_ID = (process.env.WINPAY_CHANNEL_ID || '95221').trim();
const WINPAY_PRIVATE_KEY = (process.env.WINPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const WINPAY_PUBLIC_KEY = (process.env.WINPAY_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim();
const WINPAY_TIMEOUT_MS = parseInt(process.env.WINPAY_TIMEOUT_MS, 10) || 15000;

/**
 * #78: syarat dipisah.
 *  - isConfigured()          -> cukup buat KIRIM request (generate/query/cancel QR):
 *                               base URL + partner ID + private key KITA.
 *  - isCallbackConfigured()  -> buat MENERIMA callback: public key WINPAY.
 * Jadi tes generate QR di sandbox bisa jalan walau public key Winpay belum ada;
 * callback tetap ditolak selama public key Winpay kosong.
 */
function isConfigured() {
  return !!(WINPAY_BASE_URL && WINPAY_PARTNER_ID && WINPAY_PRIVATE_KEY);
}
function isCallbackConfigured() {
  return !!WINPAY_PUBLIC_KEY;
}

function assertConfigured() {
  if (!isConfigured()) {
    const { AppError } = require('../helpers/errors');
    const err = new AppError('QRIS online belum siap (konfigurasi Winpay di server belum lengkap). Silakan bayar di kasir.', 503, 'WINPAY_BELUM_DIKONFIGURASI');
    err.isWinpayConfigError = true;
    throw err;
  }
}

/** Ringkasan konfigurasi TANPA membocorkan rahasia (dipakai skrip tes). */
function ringkasanKonfigurasi() {
  const infoKey = (pem, jenis) => {
    if (!pem) return { ada: false };
    try {
      const k = jenis === 'private' ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
      const d = k.asymmetricKeyDetails || {};
      return { ada: true, valid: true, tipe: k.asymmetricKeyType, bit: d.modulusLength || null };
    } catch (e) {
      return { ada: true, valid: false, error: e.message };
    }
  };
  const pid = WINPAY_PARTNER_ID;
  return {
    base_url: WINPAY_BASE_URL || null,
    partner_id: pid ? (pid.length > 6 ? pid.slice(0, 3) + '***' + pid.slice(-3) : '***') : null,
    channel_id: WINPAY_CHANNEL_ID,
    private_key: infoKey(WINPAY_PRIVATE_KEY, 'private'),
    public_key_winpay: infoKey(WINPAY_PUBLIC_KEY, 'public'),
    siap_kirim: isConfigured(),
    siap_callback: isCallbackConfigured(),
  };
}

/** ISO8601 timestamp dengan offset, format yang dipakai SNAP (mis. 2026-09-23T14:00:00+07:00). */
function timestampNow() {
  return isoOffset(new Date());
}

/** Format tanggal apa saja ke ISO8601 + offset tanpa milidetik (dipakai validityPeriod). */
function isoOffset(d) {
  // Selalu WIB (+07:00) apa pun zona waktu server hosting.
  const w = new Date(d.getTime() + 7 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}+07:00`;
}

function sha256HexLower(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex').toLowerCase();
}

/** Minify JSON persis kayak yang dikirim (JSON.stringify tanpa spasi tambahan). */
function minify(bodyObj) {
  return JSON.stringify(bodyObj || {});
}

/**
 * Signature buat REQUEST YANG KITA KIRIM ke Winpay (skema "Asymmetric
 * Without Get Token"): SHA256withRSA pakai private key kita, base64.
 *   stringToSign = HTTPMethod:EndpointUrl:Lowercase(HexEncode(SHA256(minify(body)))):Timestamp
 */
function signRequest({ method, endpointUrl, body, timestamp }) {
  assertConfigured();
  const bodyHash = sha256HexLower(minify(body));
  const stringToSign = `${method.toUpperCase()}:${endpointUrl}:${bodyHash}:${timestamp}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(stringToSign, 'utf8');
  signer.end();
  return signer.sign(WINPAY_PRIVATE_KEY, 'base64');
}

/**
 * Validasi signature CALLBACK YANG MASUK dari Winpay, pakai public key
 * Winpay. Rumusnya sama kayak signRequest, cuma verify bukan sign.
 *
 * PENTING: hash body HARUS dari bytes MENTAH persis yang dikirim Winpay
 * (req.rawBody, lihat app.js), bukan hasil JSON.stringify ulang dari
 * req.body yang sudah di-parse -- urutan key JSON.parse->stringify bisa
 * beda dari aslinya dan bikin signature ketolak walau isinya sama. Kirim
 * `rawBody` (string) kalau ada; fallback ke `body` (object, di-minify) cuma
 * buat testing/kalau raw body gak kesimpen.
 */
function verifyCallbackSignature({ method, endpointUrl, endpointUrls, body, rawBody, timestamp, signature }) {
  if (!isCallbackConfigured()) {
    logger.warn('Public key Winpay (WINPAY_PUBLIC_KEY) belum diisi, callback ditolak (tidak bisa validasi signature)');
    return false;
  }
  // #78: docs Winpay tidak menyebut path persis yang ditandatangani untuk
  // callback & bentuk body-nya (mentah vs minify). Coba kombinasi yang masuk
  // akal; cukup SATU yang cocok (tetap aman: tanpa private key Winpay, tidak
  // ada kombinasi yang bisa lolos).
  const paths = [...new Set([].concat(endpointUrls || [], endpointUrl || []).filter(Boolean))];
  const bodies = [];
  if (rawBody != null) bodies.push(rawBody);
  try {
    const parsed = rawBody != null ? JSON.parse(rawBody) : body;
    bodies.push(minify(parsed));
  } catch (e) { if (body) bodies.push(minify(body)); }
  const uniqBodies = [...new Set(bodies)];
  try {
    for (const p of paths) {
      for (const b of uniqBodies) {
        const stringToSign = `${String(method || 'POST').toUpperCase()}:${p}:${sha256HexLower(b)}:${timestamp}`;
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(stringToSign, 'utf8');
        verifier.end();
        if (verifier.verify(WINPAY_PUBLIC_KEY, signature, 'base64')) {
          logger.info('Winpay callback signature valid', { path: p, body: b === rawBody ? 'raw' : 'minify' });
          return true;
        }
      }
    }
    return false;
  } catch (e) {
    logger.error('Winpay verifyCallbackSignature error', { err: e.message });
    return false;
  }
}

module.exports = {
  WINPAY_BASE_URL, WINPAY_PARTNER_ID, WINPAY_CHANNEL_ID, WINPAY_TIMEOUT_MS,
  isConfigured, isCallbackConfigured, assertConfigured, ringkasanKonfigurasi,
  timestampNow, isoOffset, signRequest, verifyCallbackSignature,
};
