/**
 * src/services/laporan.service.js
 * =============================================================================
 * Laporan keuangan (dihitung live, tanpa tabel khusus).
 *
 * labaRugi(cabangId, {dari, sampai}):  [MANAGER = KAS BESAR]
 *   - PENDAPATAN: SUM kas_besar masuk 'setor_penjualan' per coa_id (rentang tgl)
 *   - BEBAN     : SUM kas_besar keluar 'reimburse'+'opex' per coa_id
 *   MURNI dari kas_besar (tidak mencampur kas_kecil), lalu diklasifikasi per induk COA.
 *
 * performaCabang(cabangId, {bulan}):
 *   omzet bulan berjalan vs target_omzet_bulanan cabang -> persentase pencapaian.
 * =============================================================================
 */

const db = require('../config/database');
const coaModel = require('../models/coa.model');
const cabangModel = require('../models/cabang.model');
const { susunLabaRugi } = require('../helpers/laba-rugi');
const { today } = require('../helpers/date');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Default rentang: awal bulan ini s.d. hari ini. */
function defaultRange() {
  const t = today(); // YYYY-MM-DD
  return { dari: `${t.slice(0, 7)}-01`, sampai: t };
}

async function labaRugi(cabangId, range = {}) {
  const { dari, sampai } = { ...defaultRange(), ...range };

  // === MANAGER = KAS BESAR ===
  // Laba-rugi diambil MURNI dari kas_besar (sudut pandang management):
  //   - PENDAPATAN : kas_besar masuk 'setor_penjualan' per coa_id
  //   - BEBAN      : kas_besar keluar ('reimburse' = belanja kasir yg diganti,
  //                  'opex' = beban langsung management spt gaji/hosting) per coa_id
  // TIDAK mencampur kas_kecil supaya tidak dobel & konsisten dgn saldo kas besar.

  const pendapatan = await db.query(
    `SELECT coa_id, SUM(nominal) AS nominal
     FROM kas_besar
     WHERE ref_cabang_id = ? AND jenis = 'masuk' AND sumber = 'setor_penjualan'
       AND DATE(tanggal) BETWEEN ? AND ?
     GROUP BY coa_id`,
    [cabangId, dari, sampai]
  );

  const beban = await db.query(
    `SELECT coa_id, SUM(nominal) AS nominal
     FROM kas_besar
     WHERE ref_cabang_id = ? AND jenis = 'keluar' AND sumber IN ('reimburse','opex','akrual','biaya_loyalty','winpay_mdr')
       AND DATE(tanggal) BETWEEN ? AND ?
     GROUP BY coa_id`,
    [cabangId, dari, sampai]
  );

  const akum = new Map();
  const tambah = (coa_id, n) => akum.set(coa_id, round2((akum.get(coa_id) || 0) + Number(n)));
  pendapatan.forEach((r) => tambah(r.coa_id, r.nominal));
  beban.forEach((r) => tambah(r.coa_id, r.nominal));

  const rowsPerCoa = [...akum.entries()].map(([coa_id, nominal]) => ({ coa_id, nominal }));
  const peta = await coaModel.peta();
  const hasil = susunLabaRugi(rowsPerCoa, peta);

  return { periode: { dari, sampai }, ...hasil };
}

async function performaCabang(cabangId, { bulan = null } = {}) {
  const t = today();
  const ym = bulan || t.slice(0, 7);     // YYYY-MM
  const dari = `${ym}-01`;
  const sampai = ym === t.slice(0, 7) ? t : `${ym}-31`;

  const cabang = await cabangModel.findById(cabangId);
  const target = cabang ? Number(cabang.target_omzet_bulanan) || 0 : 0;

  const row = await db.queryOne(
    `SELECT SUM(IF(jenis = 'masuk', nominal, -nominal)) AS omzet
     FROM kas_kecil
     WHERE cabang_id = ? AND jenis_mutasi = 'pendapatan' AND DATE(tanggal) BETWEEN ? AND ?`,
    [cabangId, dari, sampai]
  );
  const omzet = row && row.omzet ? Number(row.omzet) : 0;
  const pencapaian = target > 0 ? round2((omzet / target) * 100) : null;

  return {
    cabang_id: cabangId,
    cabang: cabang ? cabang.nama : null,
    periode: ym,
    target_omzet_bulanan: target,
    omzet,
    sisa_target: round2(Math.max(target - omzet, 0)),
    pencapaian_persen: pencapaian,
  };
}

module.exports = { labaRugi, performaCabang };
