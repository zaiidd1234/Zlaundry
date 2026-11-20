/**
 * src/helpers/state-machine.js
 * =============================================================================
 * Otak workflow status. Berdasarkan kategori layanan yang dipilih pelanggan,
 * rakit daftar tahapan yang berlaku, tentukan status berikutnya, validasi
 * perpindahan, dan ambil efek tiap status.
 *
 * API:
 *   buildStages(kategoriList)            -> [kodeStatus, ...] urut
 *   isDelivery(kategoriList)             -> boolean
 *   nextStatus(currentKode, kategoriList)-> kodeStatus berikutnya | null (selesai)
 *   canMoveTo(currentKode, targetKode, kategoriList) -> { ok, reason }
 *   efekOf(kode)                         -> objek efek
 * =============================================================================
 */

const { STATUS, BY_KODE, KATEGORI_DELIVERY } = require('../constants/status');

function isDelivery(kategoriList) {
  return (kategoriList || []).some((k) => KATEGORI_DELIVERY.includes(k));
}

/** Apakah sebuah status berlaku untuk set kategori ini? */
function statusBerlaku(status, kategoriSet, delivery) {
  if (status.trigger === 'always') return true;
  if (status.trigger === 'pickup') return !delivery;       // hanya kalau tidak diantar
  // trigger berupa array kategori
  return status.trigger.some((k) => kategoriSet.has(k));
}

/** Rakit urutan tahapan status yang berlaku untuk kategori terpilih. */
function buildStages(kategoriList) {
  const set = new Set(kategoriList || []);
  const delivery = isDelivery(kategoriList);
  return STATUS
    .filter((s) => statusBerlaku(s, set, delivery))
    .sort((a, b) => a.urutan - b.urutan)
    .map((s) => s.kode);
}

/** Status berikutnya setelah currentKode (null jika sudah tahap terakhir). */
function nextStatus(currentKode, kategoriList) {
  const stages = buildStages(kategoriList);
  const i = stages.indexOf(currentKode);
  if (i === -1) return stages[0] || null;     // belum mulai -> tahap pertama
  return stages[i + 1] || null;
}

/**
 * Validasi perpindahan: hanya boleh maju ke tahap tepat berikutnya.
 * @returns {{ok:boolean, reason?:string}}
 */
function canMoveTo(currentKode, targetKode, kategoriList) {
  const stages = buildStages(kategoriList);
  if (!stages.includes(targetKode)) {
    return { ok: false, reason: `Status "${targetKode}" tidak berlaku untuk layanan transaksi ini` };
  }
  const expected = nextStatus(currentKode, kategoriList);
  if (targetKode !== expected) {
    return { ok: false, reason: `Status berikutnya seharusnya "${expected || 'selesai'}", bukan "${targetKode}"` };
  }
  return { ok: true };
}

/** Efek (flag) sebuah status. */
function efekOf(kode) {
  return (BY_KODE[kode] && BY_KODE[kode].efek) || {};
}

module.exports = { buildStages, isDelivery, nextStatus, canMoveTo, efekOf };
