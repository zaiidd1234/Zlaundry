/**
 * src/services/iot.service.js
 * =============================================================================
 * IoT Router — provider dipilih dari kolom iot_provider di tabel mesin:
 *   bypass  → tidak kirim command (default)
 *   hallo   → HalloLaundry Cloud API
 *   tuya    → Tuya Cloud API atau Tuya LAN (tergantung iot_trigger)
 * =============================================================================
 */

const logger = require('../config/logger');

const halloProvider = require('./iot-hallo.service');
const tuyaProvider  = require('./iot-tuya.service');

const bypassProvider = {
  trigger(mesin, commandKey) {
    logger.info('[BYPASS] IoT tidak aktif untuk mesin ini', { mesin: mesin.kode_mesin, commandKey });
    return Promise.resolve({ success: true, bypass: true });
  },
  availableCommands(mesin) {
    if (!mesin || !mesin.command) return [];
    const cmd = typeof mesin.command === 'object' ? mesin.command : JSON.parse(mesin.command);
    return Object.keys(cmd);
  },
  parseCommand(command) { return {}; },
};

function getProvider(mesin) {
  const provider = (mesin && mesin.iot_provider || 'bypass').toLowerCase();
  if (provider === 'tuya')  return tuyaProvider;
  if (provider === 'hallo') return halloProvider;
  return bypassProvider;
}

async function trigger(mesin, commandKey) {
  return getProvider(mesin).trigger(mesin, commandKey);
}

function availableCommands(mesin) {
  return getProvider(mesin).availableCommands(mesin);
}

function parseCommand(command) {
  return halloProvider.parseCommand(command);
}

/**
 * Perubahan #24: cek status real exhaust fan (Tuya) sebelum kirim perintah.
 * Dulu dipanggil dari transaksi.service tapi TIDAK diekspor di sini -> error
 * "is not a function" -> perintah fan tidak pernah terkirim. Fail-safe: null
 * = tidak tahu -> caller tetap mengirim perintah.
 */
async function statusFanSudahSesuai(deviceId, targetOn) {
  try {
    if (!deviceId || typeof tuyaProvider.statusFanSudahSesuai !== 'function') return null;
    return await tuyaProvider.statusFanSudahSesuai(deviceId, targetOn);
  } catch (e) {
    return null;
  }
}

module.exports = { trigger, availableCommands, parseCommand, getProvider, statusFanSudahSesuai };
