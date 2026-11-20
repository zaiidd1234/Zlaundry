/**
 * src/helpers/laba-rugi.js
 * =============================================================================
 * Bangun Laporan Laba Rugi (dihitung live, TIDAK disimpan di tabel khusus).
 *
 * Sumber angka:
 *   - PENDAPATAN (root id 4): dari kas_kecil jenis_mutasi='pendapatan'
 *     (atau kas_besar 'setor_penjualan' — keduanya per COA; pakai kas_kecil
 *      sebagai sumber utama supaya tidak tergantung sudah/belum setor).
 *   - BEBAN (root 5 COGS, 6 COS, 7 OPEX): dari kas_kecil 'belanja_ops' +
 *     kas_besar 'opex'/'reimburse' (beban yang dibayar langsung management).
 *
 * Klasifikasi pakai COA root (lihat coa.model.akarDari). Kolom 'sumber' TIDAK
 * dipakai untuk klasifikasi—hanya menandai aliran uang.
 *
 * susunLabaRugi(rowsPerCoa, petaCoa):
 *   rowsPerCoa = [{ coa_id, masuk, keluar }]  (sudah di-SUM per coa oleh service)
 *   -> { pendapatan, cogs, cos, opex, laba_kotor, laba_bersih, rincian }
 * =============================================================================
 */

const { akarDari } = require('../models/coa.model');

// id root grup
// Root diidentifikasi via KODE (bukan id) karena id auto-increment != kode akun.
// Kode root standar: '4' PENDAPATAN, '5' HPP/COGS, '6' COS/Biaya Jasa, '7' OPEX/Beban Operasional.
const ROOT = { PENDAPATAN: '4', COGS: '5', COS: '6', OPEX: '7' };

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param {Array} rowsPerCoa [{ coa_id, nominal }]  nominal bersih (sudah bertanda: pendapatan +, beban +)
 * @param {Map}   petaCoa    dari coaModel.peta()
 */
function susunLabaRugi(rowsPerCoa, petaCoa) {
  const akum = { pendapatan: 0, cogs: 0, cos: 0, opex: 0 };
  const rincian = { pendapatan: [], cogs: [], cos: [], opex: [], lainnya: [] };

  for (const r of rowsPerCoa) {
    const root = akarDari(r.coa_id, petaCoa);
    const nominal = round2(r.nominal);
    const item = { coa_id: r.coa_id, kode: (petaCoa.get(r.coa_id) || {}).kode, nama: (petaCoa.get(r.coa_id) || {}).nama, nominal };
    if (!root) { rincian.lainnya.push(item); continue; }
    switch (String(root.kode)) {
      case ROOT.PENDAPATAN: akum.pendapatan = round2(akum.pendapatan + nominal); rincian.pendapatan.push(item); break;
      case ROOT.COGS:       akum.cogs = round2(akum.cogs + nominal);             rincian.cogs.push(item); break;
      case ROOT.COS:        akum.cos = round2(akum.cos + nominal);               rincian.cos.push(item); break;
      case ROOT.OPEX:       akum.opex = round2(akum.opex + nominal);             rincian.opex.push(item); break;
      default:              rincian.lainnya.push(item);
    }
  }

  const laba_kotor = round2(akum.pendapatan - akum.cogs);
  const laba_bersih = round2(laba_kotor - akum.cos - akum.opex);

  return {
    pendapatan: akum.pendapatan,
    cogs: akum.cogs,
    cos: akum.cos,
    opex: akum.opex,
    laba_kotor,
    laba_bersih,
    rincian,
  };
}

module.exports = { susunLabaRugi, ROOT };
