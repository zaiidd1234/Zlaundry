/**
 * src/services/iot-tuya.service.js
 * =============================================================================
 * Provider: Tuya Cloud Open API
 * Server region: Singapore → TUYA_BASE_URL=https://openapi.tuyaeu.com
 *
 * Wiring mesin:
 *   SW1 (switch_1) → tombol ON/OFF power mesin
 *   SW2 (switch_2) → tombol Start/Pause mesin
 *   Setiap trigger = pulse 1 detik (relay ON → delay → relay OFF via Tuya inching)
 *
 * Flow per aksi:
 *   mulai (washer/dryer) : SW1 pulse → delay 1.5s → SW2 pulse
 *   selesai (dryer)      : SW1 pulse (power OFF)
 *   selesai (washer)     : tidak perlu (alarm berbunyi sendiri)
 *   force_off            : SW1 pulse
 *
 * .env yang diperlukan:
 *   TUYA_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxx
 *   TUYA_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
 *   TUYA_BASE_URL=https://openapi.tuyaeu.com   (Singapore)
 * =============================================================================
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const logger = require('../config/logger');
const { badRequest } = require('../helpers/errors');

const CLIENT_ID = () => process.env.TUYA_CLIENT_ID;
const SECRET    = () => process.env.TUYA_CLIENT_SECRET;
const BASE_URL  = () => (process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com').replace(/\/$/, '');

const TOKEN_FILE = process.env.TUYA_TOKEN_FILE
  || path.join(process.cwd(), '.tuya_token_cache.json');

const PULSE_MS       = 1000;   // durasi relay ON setiap pulse (ms)
const SW1_TO_SW2_MS  = 1500;   // jeda antara SW1 dan SW2 saat mulai (ms)
const DRYER_SW1_TO_SW2_MS = 3000; // Perubahan #21: pengering butuh waktu nyala sebelum Start

/* ── Cache ─────────────────────────────────────────────────── */
function readCache() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')); }
  catch (_) { return null; }
}
function writeCache(data) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  } catch (e) { logger.warn('Gagal tulis Tuya token cache', { error: e.message }); }
}
function isCacheValid(c) {
  if (!c || !c.access_token) return false;
  return (c.expire_at || 0) - 60 > Math.floor(Date.now() / 1000);
}

/* ── Signing ────────────────────────────────────────────────── */
function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function hmac256upper(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}
function makeHeaders(urlPath, method = 'GET', body = '', accessToken = '') {
  const t         = String(Date.now());
  const bodyHash  = sha256hex(body);
  const signStr   = CLIENT_ID() + accessToken + t
    + [method, bodyHash, '', urlPath].join('\n');
  const sign = hmac256upper(SECRET(), signStr);
  return {
    'client_id'   : CLIENT_ID(),
    'access_token': accessToken,
    't'           : t,
    'sign'        : sign,
    'sign_method' : 'HMAC-SHA256',
    'Content-Type': 'application/json',
  };
}

/* ── Auth ───────────────────────────────────────────────────── */
async function fetchToken() {
  if (!CLIENT_ID() || !SECRET())
    throw new Error('TUYA_CLIENT_ID / TUYA_CLIENT_SECRET belum diset di .env');

  const urlPath = '/v1.0/token?grant_type=1';
  const resp    = await fetch(`${BASE_URL()}${urlPath}`, {
    method : 'GET',
    headers: makeHeaders(urlPath, 'GET', '', ''),
  });
  if (!resp.ok) throw new Error(`Tuya fetchToken gagal: HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(`Tuya token error: ${data.msg || data.code}`);

  const { access_token, expire_time } = data.result;
  const cache = {
    access_token,
    expire_at: Math.floor(Date.now() / 1000) + (Number(expire_time) || 7200),
    saved_at : new Date().toISOString(),
  };
  writeCache(cache);
  logger.info('Tuya token OK', { expire_at: new Date(cache.expire_at * 1000).toISOString() });
  return access_token;
}

async function getToken() {
  const cache = readCache();
  if (isCacheValid(cache)) return cache.access_token;
  return fetchToken();
}

/* ── Low-level: kirim 1 DP ke 1 device ─────────────────────── */
async function _sendDP(deviceId, dpCode, dpValue, token) {
  const urlPath = `/v1.0/devices/${deviceId}/commands`;
  const bodyStr = JSON.stringify({ commands: [{ code: dpCode, value: dpValue }] });
  const resp    = await fetch(`${BASE_URL()}${urlPath}`, {
    method : 'POST',
    headers: makeHeaders(urlPath, 'POST', bodyStr, token),
    body   : bodyStr,
  });
  if (!resp.ok) throw new Error(`Tuya _sendDP HTTP ${resp.status}`);
  const data = await resp.json();

  // Token expired
  if (!data.success && (data.code === 1010 || data.code === 1004)) {
    logger.warn('Tuya token expired di _sendDP, refresh...', { code: data.code });
    throw { tuyaTokenExpired: true };
  }
  if (!data.success) {
    // Perubahan #21: dulu cuma warning -> iot_log tetap "sukses" walau perintah ditolak
    logger.warn('Tuya DP gagal', { code: data.code, msg: data.msg, deviceId, dpCode, dpValue });
    throw new Error(`Tuya menolak perintah ${dpCode}=${dpValue}: ${data.msg || data.code}`);
  }
  logger.info('Tuya DP OK', { deviceId, dpCode, dpValue });
  return data;
}

/** Kirim 1 DP, coba ulang 1x kalau gagal (bukan token expired -- itu ditangani caller). */
async function _sendDPUlang(deviceId, dpCode, dpValue, token) {
  try {
    return await _sendDP(deviceId, dpCode, dpValue, token);
  } catch (e) {
    if (e && e.tuyaTokenExpired) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return _sendDP(deviceId, dpCode, dpValue, token);
  }
}

/* ── Pulse relay via ON → delay → OFF ──────────────────────── */
/**
 * Kirim switch_N = true, tunggu PULSE_MS, lalu switch_N = false.
 * swIndex: 0=SW1 (switch_1), 1=SW2 (switch_2)
 */
async function pulseRelay(deviceId, swIndex) {
  const dpCode = `switch_${swIndex + 1}`;
  logger.info('Tuya pulse relay ON', { deviceId, dpCode, duration_ms: PULSE_MS });

  let token = await getToken();
  try {
    // ON
    await _sendDPUlang(deviceId, dpCode, true, token);
    // Tahan PULSE_MS
    await new Promise(r => setTimeout(r, PULSE_MS));
    // OFF
    await _sendDPUlang(deviceId, dpCode, false, token);
    logger.info('Tuya pulse relay OFF', { deviceId, dpCode });
  } catch (err) {
    if (err && err.tuyaTokenExpired) {
      token = await fetchToken();
      await _sendDP(deviceId, dpCode, true, token);
      await new Promise(r => setTimeout(r, PULSE_MS));
      await _sendDP(deviceId, dpCode, false, token);
    } else throw err;
  }
}

/* ── Aksi tingkat tinggi ────────────────────────────────────── */

/**
 * Nyalakan mesin: sw1 pulse → delay → sw2 pulse
 * @param {string} deviceId
 * @param {number} sw1 - index SW power (0=washer, 2=dryer)
 * @param {number} sw2 - index SW start (1=washer, 3=dryer)
 */
async function mulaiMesin(deviceId, sw1, sw2) {
  logger.info('Tuya mulaiMesin', { deviceId, sw1, sw2 });
  await pulseRelay(deviceId, sw1);
  await new Promise(r => setTimeout(r, SW1_TO_SW2_MS));
  await pulseRelay(deviceId, sw2);
}

/**
 * Nyalakan dryer. Auto-OFF + auto-ubah status "selesai_kering" saat durasi habis
 * SEKARANG ditangani di services/transaksi.service.js (scheduleDryerAutoComplete),
 * BUKAN di sini -- supaya saat timer reach, status transaksi ikut ke-update juga,
 * bukan cuma matiin device doang.
 */
async function mulaiDryer(deviceId, sw1, sw2, durasiMenit) {
  logger.info('Tuya mulaiDryer', { deviceId, sw1, sw2, durasiMenit });
  await pulseRelay(deviceId, sw1);
  await new Promise(r => setTimeout(r, DRYER_SW1_TO_SW2_MS));
  await pulseRelay(deviceId, sw2);
}

/**
 * Matikan mesin: sw1 pulse (power OFF)
 */
async function matikanMesin(deviceId, sw1) {
  logger.info('Tuya matikanMesin', { deviceId, sw1 });
  await pulseRelay(deviceId, sw1 !== undefined ? sw1 : 0);
}

/* ── Cek status relay ───────────────────────────────────────── */
async function getStatus(deviceId) {
  const token   = await getToken();
  const urlPath = `/v1.0/devices/${deviceId}/status`;
  const resp    = await fetch(`${BASE_URL()}${urlPath}`, {
    headers: makeHeaders(urlPath, 'GET', '', token),
  });
  if (!resp.ok) throw new Error(`Tuya getStatus HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Set state exaust fan (switch_1) + VERIFIKASI beneran kekirim, retry sampai
 * maxRetry kali kalau device belum konfirmasi status yang diminta (misal
 * delay jaringan, device sempat gak respon). BEDA dari washer/dryer yang
 * cuma pulse tombol start (gak ada makna "status akhir" yang bisa dicek) --
 * exaust fan device ini switch persisten, jadi statusnya BENERAN bisa
 * dipastikan lewat getStatus().
 */
async function setExaustFanVerified(deviceId, targetOn, maxRetry = 3) {
  const token = await getToken();
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      await _sendDP(deviceId, 'switch_1', targetOn, token);
      // kasih jeda buat device proses & update status-nya sebelum dicek ulang
      await new Promise((r) => setTimeout(r, 1500));
      const status = await getStatus(deviceId);
      const dp = Array.isArray(status.result) ? status.result.find((d) => d.code === 'switch_1') : null;
      const current = dp ? dp.value : null;
      if (current === targetOn) {
        logger.info('Tuya exaust fan status terverifikasi', { deviceId, targetOn, attempt });
        return { success: true, attempt };
      }
      logger.warn('Tuya exaust fan status belum sesuai, retry...', { deviceId, targetOn, current, attempt });
    } catch (e) {
      lastErr = e;
      logger.warn('Tuya exaust fan trigger error, retry...', { deviceId, targetOn, attempt, err: e.message });
    }
  }
  throw new Error(lastErr ? lastErr.message : `Exaust fan tidak konfirmasi status "${targetOn}" setelah ${maxRetry}x percobaan`);
}

/* ── Interface publik ───────────────────────────────────────── */
async function trigger(mesin, commandKey) {
  // Jika iot_trigger=local, delegasi ke Tuya LAN service
  if (mesin.iot_trigger === 'local') {
    const localSvc = require('./iot-tuya-local.service');
    return localSvc.trigger(mesin, commandKey);
  }

  // Cloud mode
  const deviceId = mesin.tuya_device_id;
  if (!deviceId)
    throw badRequest(`Mesin ${mesin.kode_mesin} belum punya Tuya Device ID`);

  // Exaust fan: relay simpel ON/OFF PERSISTEN, DIVERIFIKASI + retry sampai 3x
  // (beda dari washer/dryer yang cuma pulse tombol, gak ada status persisten
  // yang bisa dicek). Otomatis di-trigger transaksi.service.js saat dryer
  // pertama nyala / terakhir mati.
  if (mesin.tipe === 'exaust_fan') {
    if (commandKey === 'on')  return setExaustFanVerified(deviceId, true);
    if (commandKey === 'off') return setExaustFanVerified(deviceId, false);
    throw badRequest(`Command "${commandKey}" tidak dikenal untuk exaust fan`);
  }

  // Switch index berdasarkan tipe mesin
  // washer: SW1(idx0) + SW2(idx1) | dryer: SW3(idx2) + SW4(idx3)
  const isWasher = mesin.tipe === 'washer';
  const sw1 = isWasher ? 0 : 2;
  const sw2 = isWasher ? 1 : 3;

  switch (commandKey) {
    case 'Autorun':
      return mulaiMesin(deviceId, sw1, sw2);

    case 'selesai':
    case 'force_off':
      return matikanMesin(deviceId, sw1);

    case 'on_off':
      return pulseRelay(deviceId, sw1);

    case 'start_pause':
      return pulseRelay(deviceId, sw2);

    default: {
      // Terima SEMUA durasi kering (dry5, dry20, dry33, dst) -- bukan cuma 15/30/45.
      // Angkanya di sini sekarang cuma buat log, waktu nyala aslinya dihandle timer
      // di transaksi.service.js (scheduleDryerAutoComplete), jadi bebas mau berapa aja.
      const m = /^dry(\d+)$/.exec(commandKey);
      if (m) return mulaiDryer(deviceId, sw1, sw2, Number(m[1]));
      throw badRequest(`Command "${commandKey}" tidak dikenal untuk provider Tuya`);
    }
  }
}

function parseCommand(mesin) {
  // Tuya tidak pakai kolom command — kembalikan daftar key yang didukung
  return { Autorun: 'pulse', dry15: 'pulse', dry30: 'pulse', dry45: 'pulse',
           selesai: 'pulse', force_off: 'pulse', on_off: 'pulse', start_pause: 'pulse' };
}

function availableCommands(mesin) {
  // Baca dari kolom command di tabel mesin (sama seperti hallo provider)
  if (!mesin || !mesin.command) return [];
  const cmd = typeof mesin.command === 'object' ? mesin.command : JSON.parse(mesin.command);
  return Object.keys(cmd);
}

/**
 * Cek status REAL exaust fan (DP switch_1) ke Tuya, bandingin ke target ON/OFF
 * yang udah disimpulkan dari DB (lihat orkestrasi fan di transaksi.service.js:
 * hitung dulu dari jumlah dryer aktif -> simpulkan seharusnya ON/OFF -> BARU
 * cek status real di sini -- kalau udah sesuai, caller skip trigger, gak perlu
 * kirim command yang device-nya udah di posisi situ).
 * @returns {Promise<boolean|null>} true = status real sudah sesuai target (skip
 *   trigger), false = belum sesuai (perlu trigger), null = gagal dicek/unknown
 *   (fail-safe -- caller HARUS tetap trigger kalau null, jangan nganggep aman).
 */
async function statusFanSudahSesuai(deviceId, targetOn) {
  try {
    const status = await getStatus(deviceId);
    const dp = Array.isArray(status.result) ? status.result.find((d) => d.code === 'switch_1') : null;
    if (!dp) return null;
    return dp.value === targetOn;
  } catch (e) {
    logger.warn('Cek status real exaust fan gagal (anggap unknown, tetap lanjut trigger)', { deviceId, targetOn, err: e.message });
    return null;
  }
}

module.exports = {
  trigger, parseCommand, availableCommands,
  mulaiMesin, matikanMesin, pulseRelay,
  getToken, fetchToken, getStatus, setExaustFanVerified, statusFanSudahSesuai,
};
