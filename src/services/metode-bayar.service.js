/**
 * src/services/metode-bayar.service.js
 * =============================================================================
 * Perubahan #83 -- 4 cara bayar per cabang:
 *   cash  : bayar tunai di kasir                     (cabang.bayar_cash_aktif)
 *   qris  : QRIS STATIS toko, dikonfirmasi kasir     (cabang.bayar_qris_aktif)
 *           -> masuk saldo Gopay kas kecil
 *   kiosk : "Kios-K" = QRIS dinamis Winpay di tablet  (cabang.winpay_aktif)
 *           kiosk; lunas otomatis lewat callback -> saldo Winpay
 *   poin  : tukar poin = POTONGAN harga, sisanya tetap (cabang.tukar_poin_aktif)
 *           dibayar cash/qris/kiosk. Mati = penukaran
 *           dinonaktifkan, perolehan poin tetap jalan.
 * Diatur owner di menu Cabang. Minimal 1 dari cash/qris/kiosk harus aktif.
 * Toleran kalau SQL 2026-11-18 belum dijalankan (kolom baru belum ada ->
 * dianggap aktif, kecuali kiosk yang ikut winpay_aktif).
 * =============================================================================
 */

const db = require('../config/database');
const { badRequest, notFound } = require('../helpers/errors');

const LABEL = { cash: 'Cash', qris: 'QRIS', kiosk: 'Kios-K', poin: 'Poin' };
const METODE_UANG = ['cash', 'qris', 'kiosk'];

const flag = (v, def = 1) => (v === undefined || v === null ? !!def : !!Number(v));

function dariBaris(c) {
  return {
    cash: flag(c.bayar_cash_aktif),
    qris: flag(c.bayar_qris_aktif),
    kiosk: flag(c.winpay_aktif, 0),
    poin: flag(c.tukar_poin_aktif),
    potongan_winpay_persen: c.mdr_winpay_persen != null ? Number(c.mdr_winpay_persen) : null,
  };
}

async function aktif(cabangId) {
  const c = await db.queryOne('SELECT * FROM cabang WHERE id = ?', [cabangId]);
  if (!c) throw notFound('Cabang tidak ditemukan');
  return dariBaris(c);
}

/** Tolak kalau metode tidak aktif di cabang (dipakai saat pesan). */
async function pastikanAktif(cabangId, metode) {
  const m = METODE_UANG.includes(metode) ? metode : 'cash';
  const a = await aktif(cabangId);
  if (!a[m]) throw badRequest(`Metode bayar ${LABEL[m]} sedang tidak aktif di cabang ini. Pilih metode lain.`);
  return a;
}

async function pastikanPoinAktif(cabangId) {
  const a = await aktif(cabangId);
  if (!a.poin) throw badRequest('Penukaran poin sedang dinonaktifkan di cabang ini.');
  return a;
}

/** Owner: ubah saklar. input { cash, qris, kiosk, poin } (boolean/0/1, sebagian boleh). */
async function ubah(cabangId, input = {}) {
  const lama = await aktif(cabangId);
  const baru = { ...lama };
  for (const k of ['cash', 'qris', 'kiosk', 'poin']) {
    if (input[k] !== undefined) baru[k] = !!Number(input[k] === true ? 1 : input[k] === false ? 0 : input[k]);
  }
  if (!METODE_UANG.some((k) => baru[k])) {
    throw badRequest('Minimal 1 metode bayar (Cash / QRIS / Kios-K) harus aktif.');
  }
  try {
    await db.query(
      `UPDATE cabang SET bayar_cash_aktif = ?, bayar_qris_aktif = ?, winpay_aktif = ?, tukar_poin_aktif = ? WHERE id = ?`,
      [baru.cash ? 1 : 0, baru.qris ? 1 : 0, baru.kiosk ? 1 : 0, baru.poin ? 1 : 0, cabangId]
    );
  } catch (e) {
    if (e && e.code === 'ER_BAD_FIELD_ERROR') throw badRequest('Database belum diperbarui (jalankan SQL 2026-11-18_metode_bayar_kiosk.sql).');
    throw e;
  }
  return aktif(cabangId);
}

/** Label tampilan. */
function label(m) { return LABEL[m] || (m ? String(m).toUpperCase() : '-'); }

module.exports = { aktif, pastikanAktif, pastikanPoinAktif, ubah, label, LABEL, METODE_UANG, dariBaris };
