/**
 * src/helpers/phone.js
 * =============================================================================
 * Normalisasi nomor HP Indonesia.
 * - normalizeHp(input)  -> format simpan di DB: '08xxxxxxxxx'
 * - toWa(input)         -> format wa.me / internasional: '62xxxxxxxxx'
 * - waLink(input)       -> 'https://wa.me/62xxxxxxxxx'
 *
 * Aturan: buang non-digit. '62xxx' -> '0xxx'. '8xxx' -> '08xxx'. yang lain
 * dipastikan diawali '0'. Konsisten dengan migrate.js (data historis -> 08xx).
 * =============================================================================
 */

function normalizeHp(input) {
  let s = String(input || '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (s.startsWith('62')) s = '0' + s.slice(2);
  else if (s.startsWith('8')) s = '0' + s;
  else if (!s.startsWith('0')) s = '0' + s;
  return s;
}

/** Ke format 62xxxx (untuk wa.me / API WhatsApp). */
function toWa(input) {
  const local = normalizeHp(input);      // 08xxxx
  return local ? '62' + local.slice(1) : '';
}

function waLink(input, text = '') {
  const wa = toWa(input);
  if (!wa) return '';
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${wa}${q}`;
}

module.exports = { normalizeHp, toWa, waLink };
