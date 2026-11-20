/**
 * src/models/pembayaran-qris.model.js
 * =============================================================================
 * Akses tabel `pembayaran_qris` + `pembayaran_qris_transaksi` (lihat
 * sql/2026-09-23_pembayaran_qris.sql, sql/2026-09-24_kode_bayar_kiosk.sql).
 * 1 baris pembayaran_qris = 1 sesi permintaan QR dinamis ke Winpay, bisa
 * nyangkut ke lebih dari 1 `transaksi` (fitur gabung beberapa tagihan jadi
 * 1x bayar / tombol "Bayar Semua").
 *
 * `kode_bayar` CHAR(4) = kode yang diketik pelanggan di tablet kiosk dinding
 * (public/kiosk/) buat manggil QR sesi ini -- lihat findByKode() di bawah,
 * dipakai JUGA buat cek tabrakan kode saat generate (lihat
 * pembayaran-qris.service.js:generateKodeBayarUnik()).
 * =============================================================================
 */

const db = require('../config/database');

const FIELDS = `
  id, cabang_id, pelanggan_id, partner_reference_no, kode_bayar, contract_id, amount,
  status, qr_url, qr_content, expired_at, paid_at, dibuat_oleh_karyawan_id,
  created_at, updated_at
`;

/** Buat sesi pembayaran baru (status awal 'pending', belum ada contract_id/qr -- diisi setelah call generate ke Winpay lewat setHasilGenerate). */
async function create({ cabangId, pelangganId, partnerReferenceNo, kodeBayar, amount, dibuatOlehKaryawanId = null }, conn = null) {
  const runner = conn || db.pool;
  const [r] = await runner.execute(
    `INSERT INTO pembayaran_qris (cabang_id, pelanggan_id, partner_reference_no, kode_bayar, amount, status, dibuat_oleh_karyawan_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [cabangId, pelangganId, partnerReferenceNo, kodeBayar, amount, dibuatOlehKaryawanId]
  );
  return r.insertId;
}

/** Kaitkan sesi pembayaran ke 1+ transaksi (junction). */
async function tautkanTransaksi(pembayaranId, transaksiIds, conn = null) {
  const runner = conn || db.pool;
  for (const tid of transaksiIds) {
    await runner.execute(
      `INSERT INTO pembayaran_qris_transaksi (pembayaran_qris_id, transaksi_id) VALUES (?, ?)`,
      [pembayaranId, tid]
    );
  }
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM pembayaran_qris WHERE id = ? LIMIT 1`, [id]);
}

async function findByPartnerRef(partnerReferenceNo) {
  return db.queryOne(`SELECT ${FIELDS} FROM pembayaran_qris WHERE partner_reference_no = ? LIMIT 1`, [partnerReferenceNo]);
}

/** Daftar id transaksi yang tersangkut di 1 sesi pembayaran. */
async function listTransaksiIds(pembayaranId) {
  const rows = await db.query(`SELECT transaksi_id FROM pembayaran_qris_transaksi WHERE pembayaran_qris_id = ?`, [pembayaranId]);
  return rows.map((r) => r.transaksi_id);
}

/** Sesi pembayaran yang masih 'pending' buat 1 transaksi tertentu (kalau ada) -- dipakai pas kasir konfirmasi manual, buat auto-cancel. */
async function findPendingByTransaksiId(transaksiId) {
  return db.queryOne(
    `SELECT pq.id, pq.cabang_id, pq.pelanggan_id, pq.partner_reference_no, pq.contract_id, pq.amount,
            pq.status, pq.qr_url, pq.qr_content, pq.expired_at, pq.paid_at, pq.dibuat_oleh_karyawan_id,
            pq.created_at, pq.updated_at
     FROM pembayaran_qris pq
     JOIN pembayaran_qris_transaksi pqt ON pqt.pembayaran_qris_id = pq.id
     WHERE pqt.transaksi_id = ? AND pq.status = 'pending'
     LIMIT 1`,
    [transaksiId]
  );
}

/**
 * SEMUA sesi 'pending' milik 1 pelanggan di 1 cabang (bisa lebih dari 1
 * kalau pelanggan generate berkali-kali tanpa pernah bayar/nutup sesi lama
 * dulu). Dipakai pas pelanggan klik "Bayar Semua" LAGI -- sesi lama yang
 * masih nyangkut 'pending' (mis. karena sheet-nya ditutup tanpa dibayar)
 * di-cancel dulu semua sebelum bikin sesi baru, soalnya transaksi yang
 * udah "terkunci" ke sesi pending TIDAK muncul lagi di
 * findBelumLunasByPelanggan() (lihat NOT EXISTS ... status='pending' di
 * transaksi.model.js) -- tanpa ini pelanggan gak akan pernah bisa dapat
 * kode bayar baru buat transaksi itu lagi.
 */
async function findPendingByPelanggan(pelangganId, cabangId) {
  return db.query(
    `SELECT id, partner_reference_no, contract_id
     FROM pembayaran_qris
     WHERE pelanggan_id = ? AND cabang_id = ? AND status = 'pending'`,
    [pelangganId, cabangId]
  );
}

/**
 * Cari sesi 'pending' (masih ada QR-nya & belum lewat expired_at) by
 * cabang + kode_bayar 4 digit. Dipakai 2 tempat:
 *   1. Tablet kiosk (public/kiosk/) -- lookup QR dari kode yang diketik.
 *   2. generateKodeBayarUnik() di service -- cek tabrakan sebelum pakai
 *      kode baru (kode HANYA perlu unik di antara sesi yang masih hidup).
 * qr_url IS NOT NULL sengaja disyaratkan -- kalau generate ke Winpay gagal,
 * baris tetap 'pending' tapi TANPA qr_url sampai di-setStatus('failed')
 * (lihat buatSesiPembayaran() di service), jadi jangan ikut kehitung di
 * lookup manapun sebelum itu.
 */
async function findByKode(cabangId, kodeBayar) {
  return db.queryOne(
    `SELECT ${FIELDS} FROM pembayaran_qris
     WHERE cabang_id = ? AND kode_bayar = ? AND status = 'pending' AND qr_url IS NOT NULL
       AND (expired_at IS NULL OR expired_at > NOW())
     LIMIT 1`,
    [cabangId, kodeBayar]
  );
}

/** Isi hasil generate dari Winpay (contract_id, qr_url, qr_content, expired_at). */
async function setHasilGenerate(id, { contractId, qrUrl, qrContent, expiredAt, rawResponse }) {
  await db.pool.execute(
    `UPDATE pembayaran_qris SET contract_id=?, qr_url=?, qr_content=?, expired_at=?, raw_generate_response=? WHERE id=?`,
    [contractId, qrUrl, qrContent, toMysqlDatetime(expiredAt), rawResponse ? JSON.stringify(rawResponse) : null, id]
  );
}

/**
 * mysql2 cuma auto-convert objek Date ke format DATETIME MariaDB
 * ('YYYY-MM-DD HH:MM:SS'). Kalau yang dikirim string ISO 8601 mentah
 * (ada huruf T / Z / milidetik, hasil dari toISOString()), driver
 * ngirim apa adanya sebagai string dan MariaDB nolak ("Incorrect
 * datetime value"). Winpay (& mock-winpay) balikin expiredAt sebagai
 * string ISO, jadi selalu normalisasi ke Date dulu sebelum query.
 */
function toMysqlDatetime(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Update status (paid/expired/canceled/failed). */
async function setStatus(id, { status, paidAt = null, rawCallback = null }) {
  await db.pool.execute(
    `UPDATE pembayaran_qris SET status=?, paid_at=?, raw_callback_payload=? WHERE id=?`,
    [status, paidAt, rawCallback ? JSON.stringify(rawCallback) : null, id]
  );
}

module.exports = {
  create, tautkanTransaksi, findById, findByPartnerRef, listTransaksiIds,
  findPendingByTransaksiId, findPendingByPelanggan, findByKode, setHasilGenerate, setStatus,
};
