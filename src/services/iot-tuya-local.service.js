/**
 * src/services/iot-tuya-local.service.js
 * =============================================================================
 * Tuya LAN Protocol v3.3 — kontrol device langsung via jaringan lokal
 * tanpa melalui Tuya Cloud. Lebih cepat (~50ms vs ~500ms cloud).
 *
 * Protokol:
 *   - TCP port 6668
 *   - Prefix 20 bytes header + payload AES-128-ECB encrypted
 *   - Key: iot_local_key dari DB (32 char hex atau 16 char raw)
 *
 * Kolom DB yang dibutuhkan:
 *   mesin.iot_local_ip  = IP lokal device (mis. 192.168.1.100)
 *   mesin.iot_local_key = Local key dari Tuya IoT Console (16 char)
 * =============================================================================
 */

const net    = require('net');
const crypto = require('crypto');
const logger = require('../config/logger');
const { badRequest } = require('../helpers/errors');

const PORT       = 6668;
const TIMEOUT_MS = 5000;

/* ── Tuya LAN Protocol v3.3 ────────────────────────────────── */

const PREFIX   = Buffer.from('000055aa', 'hex');
const SUFFIX   = Buffer.from('0000aa55', 'hex');
const VERSION  = Buffer.from('332e330000000000000000000000', 'hex'); // "3.3" padded

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function aesEcbEncrypt(key16, data) {
  // Key harus 16 bytes
  const keyBuf = Buffer.isBuffer(key16) ? key16 : Buffer.from(key16, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Build Tuya LAN v3.3 packet.
 * @param {string} localKey  - 16-char local key
 * @param {number} seqno     - sequence number
 * @param {number} cmd       - command code (7 = control)
 * @param {object} payload   - JSON payload
 */
function buildPacket(localKey, seqno, cmd, payload) {
  const keyBuf     = Buffer.from(localKey.substring(0, 16), 'utf8');
  const payloadStr = JSON.stringify(payload);
  const encrypted  = aesEcbEncrypt(keyBuf, Buffer.from(payloadStr, 'utf8'));

  // Header: PREFIX(4) + seqno(4) + cmd(4) + len(4) + VERSION(14) + encrypted + CRC(4) + SUFFIX(4)
  const dataLen = VERSION.length + encrypted.length + 8; // +8 for CRC+SUFFIX
  const header  = Buffer.alloc(16);
  PREFIX.copy(header, 0);
  header.writeUInt32BE(seqno, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(VERSION.length + encrypted.length + 4, 12); // len before CRC

  const body    = Buffer.concat([header, VERSION, encrypted]);
  const crcVal  = crc32(body);
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([body, crcBuf, SUFFIX]);
}

/**
 * Kirim packet ke device via TCP dan tunggu response.
 */
function sendPacket(ip, packet) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let responded = false;

    sock.setTimeout(TIMEOUT_MS);
    sock.connect(PORT, ip, () => {
      sock.write(packet);
    });
    sock.on('data', (data) => {
      responded = true;
      sock.destroy();
      resolve(data);
    });
    sock.on('timeout', () => {
      sock.destroy();
      if (!responded) reject(new Error(`Tuya LAN timeout ke ${ip}`));
    });
    sock.on('error', (err) => {
      if (!responded) reject(new Error(`Tuya LAN error: ${err.message}`));
    });
    sock.on('close', () => {
      if (!responded) reject(new Error(`Tuya LAN connection closed tanpa response dari ${ip}`));
    });
  });
}

let _seqno = 1;

/**
 * Kirim command DP ke device via LAN.
 * @param {string} ip        - IP lokal device
 * @param {string} localKey  - local key 16 char
 * @param {object} dps       - { "1": true } atau { "1": false }
 */
async function sendDPs(ip, localKey, dps) {
  const payload = {
    devId: '',       // tidak wajib untuk LAN
    uid  : '',
    t    : String(Math.floor(Date.now() / 1000)),
    dps,
  };

  const packet = buildPacket(localKey, _seqno++, 7, payload);
  logger.info('Tuya LAN sendDPs', { ip, dps });

  try {
    const resp = await sendPacket(ip, packet);
    logger.info('Tuya LAN response OK', { ip, bytes: resp.length });
    return { success: true };
  } catch (e) {
    logger.error('Tuya LAN sendDPs gagal', { ip, err: e.message });
    throw e;
  }
}

/* ── Pulse relay ────────────────────────────────────────────── */

const PULSE_MS      = 1000;
const SW1_TO_SW2_MS = 1500;

// DP mapping: index 0=SW1(dp1), 1=SW2(dp2), 2=SW3(dp3), 3=SW4(dp4)
function dpIndex(swIndex) { return String(swIndex + 1); }

async function pulseRelay(ip, localKey, swIndex) {
  const dp = dpIndex(swIndex);
  logger.info('Tuya LAN pulse', { ip, dp, duration_ms: PULSE_MS });
  await sendDPs(ip, localKey, { [dp]: true });
  await new Promise(r => setTimeout(r, PULSE_MS));
  await sendDPs(ip, localKey, { [dp]: false });
}

async function mulaiMesin(ip, localKey, sw1, sw2) {
  await pulseRelay(ip, localKey, sw1);
  await new Promise(r => setTimeout(r, SW1_TO_SW2_MS));
  await pulseRelay(ip, localKey, sw2);
}

/**
 * Nyalakan dryer (LAN). Auto-OFF + auto-ubah status ditangani di
 * services/transaksi.service.js (scheduleDryerAutoComplete), bukan di sini.
 */
async function mulaiDryer(ip, localKey, sw1, sw2, durasiMenit) {
  await mulaiMesin(ip, localKey, sw1, sw2);
}

async function matikanMesin(ip, localKey, sw1) {
  await pulseRelay(ip, localKey, sw1);
}

/* ── Interface publik ───────────────────────────────────────── */
async function trigger(mesin, commandKey) {
  const ip       = mesin.iot_local_ip;
  const localKey = mesin.iot_local_key;
  if (!ip)       throw badRequest(`Mesin ${mesin.kode_mesin} belum punya IP lokal`);
  if (!localKey) throw badRequest(`Mesin ${mesin.kode_mesin} belum punya local key`);

  // Exaust fan: relay simpel ON/OFF PERSISTEN (beda dari washer/dryer yang pulse).
  if (mesin.tipe === 'exaust_fan') {
    if (commandKey === 'on')  return sendDPs(ip, localKey, { '1': true });
    if (commandKey === 'off') return sendDPs(ip, localKey, { '1': false });
    throw badRequest(`Command "${commandKey}" tidak dikenal untuk exaust fan`);
  }

  // Switch index berdasarkan tipe mesin
  const isWasher = mesin.tipe === 'washer';
  const sw1 = isWasher ? 0 : 2;   // washer=SW1(idx0), dryer=SW3(idx2)
  const sw2 = isWasher ? 1 : 3;   // washer=SW2(idx1), dryer=SW4(idx3)

  switch (commandKey) {
    case 'Autorun':
      return mulaiMesin(ip, localKey, sw1, sw2);

    case 'selesai':
    case 'force_off':
      return matikanMesin(ip, localKey, sw1);

    case 'on_off':
      return pulseRelay(ip, localKey, sw1);

    case 'start_pause':
      return pulseRelay(ip, localKey, sw2);

    default: {
      // Terima SEMUA durasi kering (dry5, dry20, dry33, dst) -- bukan cuma 15/30/45.
      const m = /^dry(\d+)$/.exec(commandKey);
      if (m) return mulaiDryer(ip, localKey, sw1, sw2, Number(m[1]));
      throw badRequest(`Command "${commandKey}" tidak dikenal untuk Tuya LAN`);
    }
  }
}

function availableCommands(mesin) {
  if (!mesin || !mesin.command) return [];
  const cmd = typeof mesin.command === 'object' ? mesin.command : JSON.parse(mesin.command);
  return Object.keys(cmd);
}

function parseCommand(command) { return {}; }

module.exports = { trigger, availableCommands, parseCommand, sendDPs, pulseRelay };
