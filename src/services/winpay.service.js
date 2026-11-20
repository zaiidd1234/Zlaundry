/**
 * src/services/winpay.service.js
 * =============================================================================
 * Wrapper HTTP ke Winpay SNAP API buat QRIS dinamis:
 *   - generateQr()  -> POST /v1.0/qr/qr-mpm-generate
 *   - queryStatus() -> POST /v1.0/qr/qr-mpm-query
 *   - cancel()      -> POST /v1.0/qr/qr-mpm-cancel
 * Referensi: https://docs.winpay.id/payments/snap-api/qris
 *
 * Semua fungsi di sini best-effort dari sisi network (timeout, error jelas),
 * TAPI kalau Winpay belum dikonfigurasi (env kosong), langsung throw error
 * yang jelas ("Winpay belum dikonfigurasi") -- dilempar ke controller jadi
 * response 503, bukan bikin fitur lain ikut down.
 * =============================================================================
 */

const crypto = require('crypto');
const winpayConfig = require('../config/winpay');
const logger = require('../config/logger');
const { AppError } = require('../helpers/errors');

const EP_GENERATE = '/v1.0/qr/qr-mpm-generate';
const EP_QUERY = '/v1.0/qr/qr-mpm-query';
const EP_CANCEL = '/v1.0/qr/qr-mpm-cancel';

/**
 * X-EXTERNAL-ID: unik per hari, angka saja. Default 16 digit (ms + 3 acak).
 * Dulu 22 digit -> sandbox Winpay menjawab 4004700 (contoh docs: 10 digit).
 * Bisa diatur lewat env WINPAY_EXTERNAL_ID_LEN (10-36).
 */
function buatExternalId() {
  const len = Math.max(10, Math.min(36, Number(process.env.WINPAY_EXTERNAL_ID_LEN) || 16));
  let s = `${Date.now()}${crypto.randomInt(0, 1e9).toString().padStart(9, '0')}`;
  while (s.length < len) s += crypto.randomInt(0, 10);
  return s.slice(0, len);
}

/** Kode sukses SNAP: 3 digit pertama = HTTP 200 (mis. 2004700, 2005100, 2007700). */
function suksesSnap(data) {
  return data && typeof data.responseCode === 'string' && data.responseCode.startsWith('200');
}

/**
 * HTTP request ke Winpay dengan IPv4 dipaksa (default).
 * Server hosting punya IPv6 & Node memakainya kalau ada -> Winpay/Cloudflare
 * melihat IP v6 yang TIDAK ada di whitelist (whitelist diisi IPv4) -> 403.
 * WINPAY_IP_FAMILY=4 (default) | 6 | 0 (bebas). Bentuk hasil mirip fetch.
 */
function kirimHttp(url, { method = 'POST', headers = {}, body = '', signal } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  const fam = Number(process.env.WINPAY_IP_FAMILY != null && process.env.WINPAY_IP_FAMILY !== '' ? process.env.WINPAY_IP_FAMILY : 4);
  const buf = Buffer.from(body || '', 'utf8');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method,
      headers: { ...headers, 'Content-Length': buf.length },
      ...(fam === 4 || fam === 6 ? { family: fam } : {}),
      signal,
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const teks = Buffer.concat(parts).toString('utf8');
        resolve({
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
          text: async () => teks,
        });
      });
      res.on('error', reject);
    });
    req.on('error', (e) => reject(e.name === 'AbortError' || e.code === 'ABORT_ERR' ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : e));
    req.end(buf);
  });
}

/** WINPAY_HEADER_BESAR=1 -> nama header X-... ditulis huruf besar persis seperti docs (X-TIMESTAMP, dst). */
function hurufHeader(h) {
  if (process.env.WINPAY_HEADER_BESAR !== '1') return h;
  const o = {};
  for (const [k, v] of Object.entries(h)) o[/^(x-|channel-id)/i.test(k) ? k.toUpperCase() : k] = v;
  return o;
}

async function callWinpay(endpointUrl, body) {
  winpayConfig.assertConfigured();
  const timestamp = winpayConfig.timestampNow();
  const signature = winpayConfig.signRequest({ method: 'POST', endpointUrl, body, timestamp });
  const externalId = buatExternalId();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), winpayConfig.WINPAY_TIMEOUT_MS);
  try {
    if (process.env.WINPAY_DEBUG) {
      // tanpa rahasia: signature dipotong, private key tidak pernah dicetak
      console.log('  [debug] POST', winpayConfig.WINPAY_BASE_URL + endpointUrl);
      console.log('  [debug] X-Timestamp', timestamp, '| X-External-ID', externalId, '| CHANNEL-ID', winpayConfig.WINPAY_CHANNEL_ID, '| X-Signature', signature.slice(0, 12) + '…');
      console.log('  [debug] body', JSON.stringify(body));
    }
    const res = await kirimHttp(`${winpayConfig.WINPAY_BASE_URL}${endpointUrl}`, {
      method: 'POST',
      headers: hurufHeader({
        'Content-Type': 'application/json',
        // Cloudflare di depan API Winpay memblokir request tanpa User-Agent
        // "browser/aplikasi" yang jelas (default Node: "node") -> 403 HTML.
        Accept: 'application/json',
        'User-Agent': process.env.WINPAY_USER_AGENT || 'ZLaundry-POS/1.0 (+https://zlaundry.biz.id)',
        'X-Partner-ID': winpayConfig.WINPAY_PARTNER_ID,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-External-ID': externalId,
        'CHANNEL-ID': winpayConfig.WINPAY_CHANNEL_ID, // #78: wajib di SNAP
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const teks = await res.text();
    let data = {};
    try { data = teks ? JSON.parse(teks) : {}; } catch (e) { data = { raw: teks.slice(0, 500) }; }
    // #78: HTTP 200 belum tentu sukses -- cek juga responseCode SNAP.
    if (!res.ok || !suksesSnap(data)) {
      logger.error('Winpay API error', { endpointUrl, status: res.status, externalId, data });
      const kode = data.responseCode ? ` [${data.responseCode}]` : '';
      // #78: AppError 502 supaya pesan sampai ke kasir/pelanggan (bukan "Terjadi kesalahan server")
      // 401/403 tanpa responseCode SNAP = ditolak sebelum sampai API (IP / gateway)
      const cf = /cloudflare/i.test(teks);
      const ray = (teks.match(/Ray ID:\s*(?:<[^>]+>)?\s*([0-9a-f]+)/i) || [])[1] || res.headers.get('cf-ray') || null;
      const ipCf = (teks.match(/Your IP:[\s\S]{0,300}?(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,})/i) || [])[1] || null;
      if (cf) { data.cloudflare = { ray_id: ray, ip: ipCf }; }
      const saran = cf ? ` (diblokir Cloudflare Winpay${ray ? ', Ray ID ' + ray : ''}${ipCf ? ', IP ' + ipCf : ''} -- minta Winpay whitelist IP server)`
        : !data.responseCode && (res.status === 401 || res.status === 403)
          ? ' (akses ditolak Winpay -- cek IP whitelist server & URL sandbox/production)' : '';
      const err = new AppError(`Gagal menghubungi Winpay: ${data.responseMessage || 'HTTP ' + res.status}${kode}${saran}`, 502, 'WINPAY_ERROR');
      err.winpayResponse = data;
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      logger.error('Winpay API timeout', { endpointUrl });
      throw new AppError('Winpay tidak merespons (timeout). Coba lagi sebentar.', 504, 'WINPAY_TIMEOUT');
    }
    if (e instanceof AppError) throw e;
    logger.error('Winpay API gagal terhubung', { endpointUrl, err: e.message });
    throw new AppError('Tidak bisa terhubung ke Winpay. Coba lagi sebentar.', 502, 'WINPAY_KONEKSI');
  }
}

/**
 * Generate QRIS dinamis.
 * @param {object} p
 * @param {string} p.partnerReferenceNo - ID transaksi kita (unik), 5-50 char
 * @param {number} p.amount - nominal (Rupiah, bulat)
 * @param {number} [p.validityMinutes] - masa berlaku QR dalam menit (default 15)
 * @returns {Promise<{qrUrl, qrContent, contractId, expiredAt, raw}>}
 */
async function generateQr({ partnerReferenceNo, amount, validityMinutes = 15 }) {
  const expiredAt = new Date(Date.now() + validityMinutes * 60 * 1000);
  const body = {
    partnerReferenceNo,
    // format SNAP: "50000.00" (contoh docs Winpay); WINPAY_AMOUNT_BULAT=1 -> "50000"
    amount: { value: process.env.WINPAY_AMOUNT_BULAT === '1' ? String(Math.round(amount)) : Math.round(amount).toFixed(2), currency: 'IDR' },
    // #78: contoh docs "…+07:00"; tabel docs menulis "YYYY-MM-DDTHH:mm:ssZ" -> WINPAY_VALIDITY_UTC=1 kirim "…Z"
    validityPeriod: process.env.WINPAY_VALIDITY_UTC === '1' ? expiredAt.toISOString().slice(0, 19) + 'Z' : winpayConfig.isoOffset(expiredAt),
    additionalInfo: { isStatic: false },
  };
  const data = await callWinpay(EP_GENERATE, body);
  const info = data.additionalInfo || {};
  const exp = info.expiredAt || data.expiredAt;
  const expDate = exp ? new Date(exp) : null;
  return {
    qrUrl: data.qrUrl || null,
    qrContent: data.qrContent || null,
    contractId: info.contractId || data.contractId || null,
    // dari Winpay kalau ada & kebaca; kalau tidak, pakai hitungan kita
    expiredAt: expDate && !isNaN(expDate) ? expDate.toISOString() : expiredAt.toISOString(),
    raw: data,
  };
}

/** Cek status pembayaran ke Winpay (buat reconciliation / polling manual). */
async function queryStatus({ partnerReferenceNo, contractId }) {
  const body = {
    originalPartnerReferenceNo: partnerReferenceNo,
    serviceCode: '47',
    additionalInfo: { contractId },
  };
  return callWinpay(EP_QUERY, body);
}

/** Batalin QR yang belum dibayar (dipanggil pas kasir konfirmasi manual duluan). */
async function cancel({ partnerReferenceNo, contractId, reason }) {
  const body = {
    originalPartnerReferenceNo: partnerReferenceNo,
    reason: reason || 'Dibatalkan (dibayar manual / kadaluarsa)',
    additionalInfo: { contractId },
  };
  return callWinpay(EP_CANCEL, body);
}

module.exports = { generateQr, queryStatus, cancel, EP_GENERATE, EP_QUERY, EP_CANCEL };
