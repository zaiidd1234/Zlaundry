/**
 * src/services/kas-winpay.service.js
 * =============================================================================
 * Perubahan #83 -- Saldo Winpay (Kios-K) per cabang.
 *
 * Alur uang Kios-K:
 *   1. Pelanggan bayar QR Winpay -> transaksi lunas (metode 'kiosk').
 *      Kas besar: pendapatan penuh (setor_penjualan) + biaya MDR (winpay_mdr,
 *      cabang.mdr_winpay_persen, default 0,35%) + KELUAR 'winpay_titip'
 *      sebesar dana bersih -> uangnya belum di kas besar, masih di Winpay.
 *   2. Manager/owner "Tarik ke Kas Besar" (isi nominal, maks = saldo) ->
 *      kas besar MASUK 'winpay_tarik'.
 *   Saldo Winpay = SUM(winpay_titip) - SUM(winpay_tarik).
 *   winpay_titip & winpay_tarik TIDAK masuk laba-rugi (cuma pindah tempat uang).
 * Kas kecil (cash + gopay kasir) tidak tersentuh.
 * =============================================================================
 */

const db = require('../config/database');
const { now } = require('../helpers/date');
const { badRequest } = require('../helpers/errors');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const SQL_SALDO = `SELECT
    COALESCE(SUM(CASE WHEN sumber = 'winpay_titip' AND jenis = 'keluar' THEN nominal ELSE 0 END), 0) AS titip,
    COALESCE(SUM(CASE WHEN sumber = 'winpay_tarik' AND jenis = 'masuk' THEN nominal ELSE 0 END), 0) AS tarik
  FROM kas_besar WHERE ref_cabang_id = ? AND sumber IN ('winpay_titip','winpay_tarik')`;

async function hitungSaldo(cabangId, conn = null) {
  const row = conn ? (await conn.execute(SQL_SALDO, [cabangId]))[0][0] : await db.queryOne(SQL_SALDO, [cabangId]);
  const titip = Number(row && row.titip) || 0;
  const tarik = Number(row && row.tarik) || 0;
  return { saldo: round2(titip - tarik), total_masuk: round2(titip), total_tarik: round2(tarik) };
}

async function ringkas(cabangId, { limit = 30 } = {}) {
  const [s, cab, riwayat] = await Promise.all([
    hitungSaldo(cabangId),
    db.queryOne('SELECT winpay_aktif, mdr_winpay_persen FROM cabang WHERE id = ?', [cabangId]),
    db.query(
      `SELECT kb.id, kb.tanggal, kb.jenis, kb.sumber, kb.nominal, kb.keterangan, k.nama AS oleh
         FROM kas_besar kb LEFT JOIN karyawan k ON k.id = kb.karyawan_id
        WHERE kb.ref_cabang_id = ? AND kb.sumber IN ('winpay_titip','winpay_tarik','winpay_mdr')
        ORDER BY kb.tanggal DESC, kb.id DESC LIMIT ${Math.max(1, Math.min(200, Number(limit) || 30))}`,
      [cabangId]
    ).catch(() => []),
  ]);
  return {
    ...s,
    kiosk_aktif: !!Number(cab && cab.winpay_aktif),
    potongan_persen: cab && cab.mdr_winpay_persen != null ? Number(cab.mdr_winpay_persen) : null,
    riwayat: riwayat.map((r) => ({
      id: r.id, tanggal: r.tanggal, nominal: Number(r.nominal) || 0, keterangan: r.keterangan, oleh: r.oleh || null,
      jenis: r.sumber === 'winpay_tarik' ? 'tarik' : r.sumber === 'winpay_mdr' ? 'potongan' : 'masuk',
    })),
  };
}

/** Tarik dana Winpay ke kas besar. nominal wajib, maks = saldo Winpay. */
async function tarik(cabangId, input = {}, { karyawanId } = {}) {
  const nominal = round2(String(input.nominal == null ? '' : input.nominal).replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!(nominal > 0)) throw badRequest('Isi nominal tarik');
  const ket = String(input.keterangan || '').trim().slice(0, 200);
  return db.transaction(async (conn) => {
    // kunci cabang supaya 2 penarikan bersamaan tidak melebihi saldo
    await conn.execute('SELECT id FROM cabang WHERE id = ? FOR UPDATE', [cabangId]);
    const { saldo } = await hitungSaldo(cabangId, conn);
    if (nominal > saldo) {
      throw badRequest(`Nominal melebihi saldo Winpay (maks Rp${Math.floor(saldo).toLocaleString('id-ID')})`);
    }
    const [coa] = await conn.execute(`SELECT id FROM coa WHERE kode = '1-103' LIMIT 1`);
    const coaId = coa && coa[0] ? coa[0].id : null;
    const [r] = await conn.execute(
      `INSERT INTO kas_besar (transfer_id, tanggal, jenis, coa_id, nominal, sumber, ref_cabang_id, karyawan_id, keterangan)
       VALUES (NULL, ?, 'masuk', ?, ?, 'winpay_tarik', ?, ?, ?)`,
      [now(), coaId, nominal, cabangId, karyawanId || null, `Tarik dana Winpay ke kas besar${ket ? ' - ' + ket : ''}`]
    );
    return { id: r.insertId, nominal, saldo_sebelum: saldo, saldo_sesudah: round2(saldo - nominal) };
  });
}

module.exports = { ringkas, tarik, hitungSaldo };
