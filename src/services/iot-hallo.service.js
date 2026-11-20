/**
 * src/services/iot-hallo.service.js
 * =============================================================================
 * Provider: HalloLaundry (provider default lama)
 *
 * Flow:
 *   1. POST /api/v2/auth/user     -> JWT, di-cache ke file
 *   2. getValidToken()            -> pakai cache sampai expired, else login ulang
 *   3. sendCommand(sn, code)      -> POST .../send-command/{sn}/{commandCode}
 *   4. trigger(mesin, key)        -> resolve token dari mesin.command[key], lalu sendCommand
 *
 * .env yang diperlukan:
 *   IOT_PROVIDER=hallo
 *   PLATFORM_BASE_URL=https://...
 *   PLATFORM_FRONTEND_URL=https://...
 *   PLATFORM_USER=xxx
 *   PLATFORM_PASSWORD=xxx
 * =============================================================================
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../config/logger');
const { badRequest } = require('../helpers/errors');

const BASE_URL      = process.env.PLATFORM_BASE_URL;
const FRONTEND_URL  = process.env.PLATFORM_FRONTEND_URL;
const USER          = process.env.PLATFORM_USER;
const PASSWORD      = process.env.PLATFORM_PASSWORD;
const TOKEN_FILE    = process.env.IOT_TOKEN_FILE
  || path.join(process.cwd(), '.iot_token_cache.json');

function baseHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: FRONTEND_URL,
    Referer: `${FRONTEND_URL}/`,
    'User-Agent': 'ZLaundry-Server/1.0',
    ...extra,
  };
}

function decodeJwtExp(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const seg    = parts[1];
    const padded = seg.padEnd(seg.length + ((4 - (seg.length % 4)) % 4), '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
    return payload.exp || null;
  } catch (e) { return null; }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')); }
  catch (e) { return null; }
}
function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(cache, null, 2));
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  } catch (e) { logger.warn('Gagal tulis cache token Hallo', { error: e.message }); }
}
function isTokenValid(cache) {
  if (!cache || !cache.token) return false;
  if (!cache.exp) return true;
  return cache.exp - 60 > Math.floor(Date.now() / 1000);
}

async function login() {
  if (!USER || !PASSWORD) throw new Error('PLATFORM_USER / PLATFORM_PASSWORD belum diset di .env');
  const resp = await fetch(`${BASE_URL}/api/v2/auth/user`, {
    method : 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body   : JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login HalloLaundry gagal: HTTP ${resp.status}`);
  const data  = await resp.json();
  const token = data.record || data.token || data.access_token
    || (data.data && (data.data.token || data.data.access_token));
  if (!token) throw new Error('Token tidak ditemukan di response login Hallo');
  const exp = decodeJwtExp(token);
  writeCache({ token, exp, saved_at: new Date().toISOString() });
  logger.info('HalloLaundry login OK', { exp: exp ? new Date(exp * 1000).toISOString() : 'unknown' });
  return token;
}

async function getValidToken() {
  const cache = readCache();
  if (isTokenValid(cache)) return cache.token;
  return login();
}

async function sendCommand(sn, commandCode) {
  if (!sn)          throw new Error('SN mesin kosong');
  if (!commandCode) throw new Error('Kode command kosong');

  const doSend = async (token) => fetch(
    `${BASE_URL}/api/v2/iot/machines/commands/send-command/`
    + `${encodeURIComponent(sn)}/${encodeURIComponent(commandCode)}`,
    { method: 'POST', headers: baseHeaders({ Authorization: `Bearer ${token}` }) }
  );

  let token = await getValidToken();
  let resp  = await doSend(token);
  if (resp.status === 401) {
    logger.warn('Token HalloLaundry ditolak (401), login ulang');
    token = await login();
    resp  = await doSend(token);
  }
  // Perubahan #21: server HalloLaundry kadang 5xx sesaat (503/522) -> coba ulang 2x
  for (let i = 0; i < 2 && resp.status >= 500; i++) {
    logger.warn('HalloLaundry 5xx, coba ulang', { sn, commandCode, status: resp.status, percobaan: i + 2 });
    await new Promise((r) => setTimeout(r, 1500));
    resp = await doSend(token);
  }
  if (!resp.ok) throw new Error(`Kirim command HalloLaundry gagal: HTTP ${resp.status}`);
  let body = null;
  try { body = await resp.json(); } catch (_) {}
  logger.info('HalloLaundry command terkirim', { sn, commandCode });
  return body;
}

function parseCommand(command) {
  if (!command) return {};
  if (typeof command === 'object') return command;
  try { return JSON.parse(command); } catch (e) { return {}; }
}

async function trigger(mesin, commandKey) {
  const cmd   = parseCommand(mesin.command);
  const token = cmd[commandKey];
  if (!token)    throw badRequest(`Command "${commandKey}" tidak tersedia di mesin ${mesin.kode_mesin}`);
  if (!mesin.sn) throw badRequest(`Mesin ${mesin.kode_mesin} belum punya SN`);
  return sendCommand(mesin.sn, token);
}

function availableCommands(mesin) {
  return Object.keys(parseCommand(mesin.command));
}

module.exports = { login, getValidToken, sendCommand, trigger, parseCommand, availableCommands };
