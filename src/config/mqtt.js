/**
 * src/config/mqtt.js
 * =============================================================================
 * TAHAP 2 (BELUM DIAKTIFKAN) — MQTT API Client.
 * Backend kirim HTTP request ke MQTT server eksternal, server itu relay command
 * ke ESP32 di cabang. Dipakai nanti menggantikan provider hallolaundry (tahap 1).
 *
 * Saat ini iot.service.js (tahap 1) yang dipakai. File ini disimpan siap pakai;
 * untuk mengaktifkan, panggil startMesin/stopMesin dari workflow & set MQTT_API_URL.
 * =============================================================================
 */

const logger = require('./logger');

const MQTT_API_URL = process.env.MQTT_API_URL;
const MQTT_API_KEY = process.env.MQTT_API_KEY;
const MQTT_TIMEOUT_MS = parseInt(process.env.MQTT_TIMEOUT_MS, 10) || 10000;

async function sendCommand({ deviceId, command, payload = {} }) {
  if (!MQTT_API_URL) {
    logger.warn('MQTT_API_URL not configured, skipping IOT command');
    return { success: false, error: 'MQTT_API_URL not configured', response: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MQTT_TIMEOUT_MS);
  try {
    const response = await fetch(`${MQTT_API_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MQTT_API_KEY}` },
      body: JSON.stringify({ deviceId, command, payload }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger.error('MQTT API error', { status: response.status, data });
      return { success: false, error: data.message || `MQTT API responded with ${response.status}`, response: data };
    }
    return { success: true, response: data };
  } catch (err) {
    clearTimeout(timeout);
    logger.error('MQTT API request failed', { error: err.message, deviceId, command });
    return { success: false, error: err.name === 'AbortError' ? 'MQTT API timeout' : err.message, response: null };
  }
}

async function startMesin({ deviceId, durationMinutes }) {
  return sendCommand({ deviceId, command: 'start', payload: durationMinutes ? { duration: durationMinutes } : {} });
}
async function stopMesin(deviceId) { return sendCommand({ deviceId, command: 'stop' }); }
async function getMesinStatus(deviceId) { return sendCommand({ deviceId, command: 'status' }); }

module.exports = { sendCommand, startMesin, stopMesin, getMesinStatus };
