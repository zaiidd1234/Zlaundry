/**
 * src/helpers/transfer-calc.js
 * =============================================================================
 * Algoritma penentuan setoran.
 *
 * pilihTransaksiUtuh(transaksiList, saldoGopay):
 *   pilih transaksi belum_setor secara FIFO (urut tanggal/lama dulu) selama
 *   akumulasi total <= saldoGopay. Transaksi diambil UTUH (tidak dipecah).
 *   -> { dipilih:[...], totalDipilih, sisaSaldo }
 *
 * hitungNet(totalPendapatan, totalReimburse):
 *   net = pendapatan - reimburse (yang ditransfer ke management).
 *
 * Catatan: saldoGopay yang dipakai = saldo SETELAH konversi cash->gopay,
 *   karena semua setoran lewat gopay (QRIS). Konversi dilakukan di service.
 * =============================================================================
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param {Array} transaksiList [{ id, total, tanggal }]  sudah urut FIFO (lama->baru)
 * @param {number} saldoGopay   batas dari saldo (setelah konversi cash->gopay)
 * @param {number} capMax       batas maksimal per transfer (mis. 500rb); 0/null = tanpa cap
 *
 * Batas efektif = min(saldoGopay, capMax). FIFO ketat: berhenti di transaksi
 * pertama yang bikin akumulasi melebihi batas (transaksi diambil UTUH).
 */
function pilihTransaksiUtuh(transaksiList, saldoGopay, capMax = 0) {
  const batas = capMax && capMax > 0 ? Math.min(Number(saldoGopay) || 0, Number(capMax)) : (Number(saldoGopay) || 0);
  let akum = 0;
  const dipilih = [];
  for (const t of transaksiList) {
    const total = Number(t.total) || 0;
    if (akum + total <= batas) {
      dipilih.push(t);
      akum = round2(akum + total);
    } else break; // FIFO ketat: berhenti di transaksi pertama yang melebihi batas
  }
  return { dipilih, totalDipilih: akum, sisaSaldo: round2(batas - akum), batas };
}

function hitungNet(totalPendapatan, totalReimburse = 0) {
  return round2((Number(totalPendapatan) || 0) - (Number(totalReimburse) || 0));
}

/**
 * Hitung rencana setoran. Pendapatan dan reimburse independen satu sama lain:
 *   - Pendapatan: SEMUA yang belum disetor diambil FIFO, DIBATASI supaya NET tidak melebihi cap.
 *   - Reimburse: SEMUA belanja yang belum di-reimburse, selalu ikut penuh (tidak FIFO, tidak ditahan).
 *   - net = pendapatan - reimburse - loyalty.
 *       net > cap   -> pendapatan FIFO dipotong supaya net pas di cap (transfer real dibatasi cap)
 *       net <= cap  -> ambil SEMUA pendapatan yang ada, net bisa berapa pun (termasuk negatif)
 *           net > 0  -> kasir setor sisa ke management
 *           net < 0  -> management top up ke kasir (reimburse > pendapatan yang tersedia)
 *           net = 0  -> balance pas
 *
 * Plafon saldo kas fisik TIDAK membatasi pendapatan FIFO — pendapatan yang belum disetor
 * adalah fakta pembukuan yang independen dari saldo kas saat ini.
 *
 * @param {Array}  belum          transaksi belum setor [{id,total,...}] urut FIFO
 * @param {number} totalReimburse total SEMUA belanja belum-reimburse (selalu penuh, tidak dipotong)
 * @param {number} plafonSaldo    (tidak lagi membatasi pendapatan — dipertahankan utk info/observability saja)
 * @param {number} capNet         cap NET transfer real per setor (mis. 500rb)
 * @param {number} totalLoyalty   total biaya loyalty dari transaksi dalam batch (default 0)
 * @returns {object} { dipilih, totalPendapatan, totalReimburse, totalLoyalty, net, batasPendapatan, arah }
 */
function hitungSetoran(belum, totalReimburse, plafonSaldo, capNet, totalLoyalty = 0) {
  const reimb = Math.max(0, Number(totalReimburse) || 0);
  const loyalty = Math.max(0, Number(totalLoyalty) || 0);
  const cap = capNet && capNet > 0 ? Number(capNet) : Infinity;

  // Cap berlaku ke NET, bukan ke pendapatan mentah.
  // batasPendapatan = cap + reimburse + loyalty -> kalau pendapatan FIFO sampai batas ini,
  // net akan PAS di cap. Kalau total pendapatan < batas ini, semua diambil (net < cap, bisa negatif).
  const batasPendapatan = cap + reimb + loyalty;

  let akum = 0;
  const dipilih = [];
  for (const t of belum) {
    const total = Number(t.total) || 0;
    if (round2(akum + total) <= batasPendapatan) {
      dipilih.push(t);
      akum = round2(akum + total);
    } else break; // FIFO ketat — berhenti begitu net akan melebihi cap
  }

  const net = round2(akum - reimb - loyalty);
  return {
    dipilih,
    totalPendapatan: akum,
    totalReimburse: reimb,
    totalLoyalty: loyalty,
    net,
    batasPendapatan: round2(Math.min(batasPendapatan, Number.MAX_SAFE_INTEGER)),
    arah: net >= 0 ? 'kasir_ke_management' : 'management_ke_kasir',
    cukup: true,  // tidak pernah blocking — net negatif tetap valid (arah dibalik)
  };
}

module.exports = { pilihTransaksiUtuh, hitungNet, hitungSetoran, round2 };
