/**
 * src/helpers/date.js
 * =============================================================================
 * Util tanggal/waktu zona Asia/Jakarta (UTC+7).
 *   now()            -> 'YYYY-MM-DD HH:mm:ss' (untuk simpan ke DATETIME)
 *   today()          -> 'YYYY-MM-DD'
 *   format(d, fmt)   -> format sederhana: 'YYYY-MM-DD', 'YYYYMMDD', 'YYYY-MM-DD HH:mm:ss'
 *   parseWIB(str)    -> '01 May 2026 10:35:50 WIB' -> 'YYYY-MM-DD HH:mm:ss' (atau null)
 * =============================================================================
 */

const TZ = 'Asia/Jakarta';
const pad = (n) => String(n).padStart(2, '0');

/** Pecah Date jadi komponen waktu Jakarta. */
function parts(d = new Date()) {
  const j = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  return {
    Y: j.getFullYear(), M: j.getMonth() + 1, D: j.getDate(),
    h: j.getHours(), m: j.getMinutes(), s: j.getSeconds(),
  };
}

function format(d = new Date(), fmt = 'YYYY-MM-DD HH:mm:ss') {
  const { Y, M, D, h, m, s } = parts(d);
  switch (fmt) {
    case 'YYYYMMDD': return `${Y}${pad(M)}${pad(D)}`;
    case 'YYYY-MM-DD': return `${Y}-${pad(M)}-${pad(D)}`;
    case 'YYYY-MM-DD HH:mm:ss':
    default: return `${Y}-${pad(M)}-${pad(D)} ${pad(h)}:${pad(m)}:${pad(s)}`;
  }
}

const now = () => format(new Date(), 'YYYY-MM-DD HH:mm:ss');
const today = () => format(new Date(), 'YYYY-MM-DD');

const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

/** Parse '01 May 2026 10:35:50 WIB' -> 'YYYY-MM-DD HH:mm:ss' (null kalau gagal). */
function parseWIB(str) {
  if (!str) return null;
  const s = String(str).replace(/\bWIB\b|\bUTC\b|GMT[+-]\d+/gi, '').trim();
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, dd, mon, yyyy, HH = '00', MM = '00', SS = '00'] = m;
  const mm = MONTHS[mon.slice(0, 3)];
  if (!mm) return null;
  return `${yyyy}-${mm}-${pad(dd)} ${pad(HH)}:${pad(MM)}:${pad(SS)}`;
}

/**
 * Tentukan datetime untuk disimpan, dengan dukungan backdate (tanggal lampau).
 * Backdate hanya aktif kalau env ALLOW_BACKDATE = 'true'.
 *
 * @param {string|null} input - 'YYYY-MM-DD' atau 'YYYY-MM-DD HH:mm:ss' dari user (boleh null)
 * @returns {string} 'YYYY-MM-DD HH:mm:ss' siap simpan
 *
 * Aturan:
 *   - input kosong               -> now() (waktu sekarang)
 *   - backdate OFF               -> abaikan input, pakai now()
 *   - backdate ON + tgl saja     -> 'YYYY-MM-DD 12:00:00' (jam default siang)
 *   - backdate ON + tgl+jam      -> dipakai apa adanya
 *   - tanggal masa depan ditolak -> dibatasi ke now()
 */
function resolveTanggal(input) {
  if (!input) return now();
  const allow = String(process.env.ALLOW_BACKDATE || '').toLowerCase() === 'true';
  if (!allow) return now();

  const s = String(input).trim();
  let dt;
  const mDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mDateTime = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (mDateOnly) {
    dt = `${s} 12:00:00`; // jam default siang
  } else if (mDateTime) {
    const [, Y, M, D, h, m, sec = '00'] = mDateTime;
    dt = `${Y}-${M}-${D} ${h}:${m}:${pad(sec)}`;
  } else {
    return now(); // format tak dikenal -> aman pakai sekarang
  }

  // tolak tanggal masa depan: batasi ke now()
  const sekarang = now();
  if (dt > sekarang) return sekarang;
  return dt;
}

module.exports = { now, today, format, parseWIB, resolveTanggal, TZ };
