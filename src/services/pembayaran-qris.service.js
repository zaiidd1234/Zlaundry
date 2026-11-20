/**
 * src/services/pembayaran-qris.service.js
 * =============================================================================
 * Business logic buat fitur "Bayar via QRIS Dinamis" (Winpay). Dipakai dari
 * customer app (pelanggan bayar sendiri) & kasir app (Pesankan, buat
 * pelanggan yang datang langsung ke outlet).
 *
 * Alur:
 *   1. daftarTagihan()      -> daftar transaksi belum-lunas pelanggan, buat checkbox.
 *   2. buatSesiPembayaran() -> gabungin transaksi terpilih, generate QR dinamis ke Winpay.
 *   3. Winpay callback masuk -> prosesCallback() -> tandai LUNAS semua transaksi
 *      terkait, REUSE logic yang sama persis kayak kasir klik "Konfirm Bayar"
 *      manual (transaksiService.bayar), cuma kasirId-nya di-resolve otomatis
 *      (karyawan aktif pertama di cabang itu) karena gak ada kasir yang mencet.
 *   4. statusSesi()         -> buat polling dari frontend (customer/kasir nunggu bayar).
 *   5. batalkanSesiPendingUntukTransaksi() -> dipanggil pas kasir konfirmasi
 *      manual duluan, biar sesi QR yang masih pending ke-cancel juga.
 * =============================================================================
 */

const crypto = require('crypto');
const db = require('../config/database');
const pembayaranQrisModel = require('../models/pembayaran-qris.model');
const transaksiModel = require('../models/transaksi.model');
const cabangModel = require('../models/cabang.model');
const winpayService = require('./winpay.service');
const logger = require('../config/logger');
const { badRequest, notFound, conflict } = require('../helpers/errors');

function buatPartnerReferenceNo(cabangId) {
  const rand = crypto.randomBytes(3).toString('hex');
  return `ZL${cabangId}${Date.now()}${rand}`.slice(0, 50);
}

/**
 * Perubahan #85: Merchant Ref (partnerReferenceNo) dari nomor transaksi supaya
 * gampang dicocokkan di dashboard Winpay.
 *   1 transaksi       -> {invoice}-{urutan}            mis. ZL01-20260501-001-1
 *   beberapa transaksi -> {invoice pertama}-{n}TRX-{urutan} mis. ZL01-20260501-001-3TRX-1
 * {urutan} = QR ke-berapa untuk dasar yang sama (Winpay menolak ref kembar).
 * Karakter di luar huruf/angka/-/_ dibuang, maks 50 (aturan Winpay).
 * Fallback ke format lama kalau invoice kosong.
 */
async function buatRefDariInvoice(cabangId, dipilih) {
  const urut = [...dipilih].sort((a, b) => Number(a.id) - Number(b.id));
  const inv = String((urut[0] && urut[0].no_invoice) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!inv) return buatPartnerReferenceNo(cabangId);
  const dasar = (urut.length > 1 ? `${inv}-${urut.length}TRX` : inv).slice(0, 44);
  const ada = await db.query(
    'SELECT partner_reference_no AS r FROM pembayaran_qris WHERE partner_reference_no LIKE ?', [`${dasar}-%`]);
  const pakai = new Set(ada.map((x) => x.r));
  for (let n = ada.length + 1; n < ada.length + 1000; n++) {
    const ref = `${dasar}-${n}`;
    if (!pakai.has(ref)) return ref;
  }
  return buatPartnerReferenceNo(cabangId);
}

/**
 * Kode bayar 4 digit acak, dipakai pelanggan buat manggil QR-nya di tablet
 * kiosk dinding (public/kiosk/). Cuma perlu UNIK di antara sesi yang masih
 * 'pending' & belum expired DI CABANG YANG SAMA (lihat findByKode() di
 * model) -- begitu sesi lama expired/selesai, kodenya bebas dipakai ulang.
 * Retry beberapa kali kalau kebetulan tabrakan (sangat jarang, ruang kode
 * cuma 10.000 tapi sesi pending bersamaan di 1 cabang biasanya sangat sedikit).
 */
async function generateKodeBayarUnik(cabangId) {
  for (let i = 0; i < 30; i++) {
    const kode = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const bentrok = await pembayaranQrisModel.findByKode(cabangId, kode);
    if (!bentrok) return kode;
  }
  throw conflict('Gagal bikin kode bayar unik, coba lagi sebentar lagi');
}

/** Daftar transaksi belum lunas milik 1 pelanggan -- buat checkbox pilih tagihan. */
async function daftarTagihan(pelangganId, cabangId) {
  const rows = await transaksiModel.findBelumLunasByPelanggan(pelangganId, cabangId);
  return rows.map((r) => ({
    id: r.id, no_invoice: r.no_invoice, kode_antrian: r.kode_antrian,
    tanggal: r.tanggal, total: Number(r.total) || 0, berat_kg: r.berat_kg,
    item_label: r.item_label, metode_bayar: r.metode_bayar,
  }));
}

/**
 * Bikin sesi pembayaran QRIS dinamis dari 1+ transaksi yang dipilih.
 * @param {object} p
 * @param {number} p.cabangId
 * @param {number} p.pelangganId
 * @param {number[]} p.transaksiIds - id transaksi yang dipilih (punya pelanggan ini, belum lunas)
 * @param {number|null} p.dibuatOlehKaryawanId - kasir yang generate (null kalau dari customer app)
 */
async function buatSesiPembayaran({ cabangId, pelangganId, transaksiIds, dibuatOlehKaryawanId = null }) {
  if (!Array.isArray(transaksiIds) || transaksiIds.length === 0) {
    throw badRequest('Pilih minimal 1 transaksi yang mau dibayar');
  }

  // Saklar per-cabang (cabang.winpay_aktif) -- kalau nonaktif, jangan coba
  // generate ke Winpay sama sekali; caller (controller/frontend) fallback ke
  // mekanisme QRIS statis lama. Ditandai statusCode 409 + flag khusus biar
  // frontend bisa bedakan "memang nonaktif" vs error lain (mis. dari Winpay).
  const cabangRow = await cabangModel.findById(cabangId);
  if (!cabangRow || !Number(cabangRow.winpay_aktif)) {
    // AppError (conflict) supaya benar-benar dibalas 409, bukan 500
    const err = conflict('Pembayaran QRIS online belum aktif untuk cabang ini. Silakan bayar di kasir (cash / QRIS kasir).', { winpay_nonaktif: true });
    err.isWinpayNonaktif = true;
    throw err;
  }

  // Validasi ulang di server: semua id yang dikirim HARUS ada di daftar
  // belum-lunas pelanggan ini (jangan percaya input dari client mentah-mentah).
  const tagihanValid = await transaksiModel.findBelumLunasByPelanggan(pelangganId, cabangId);
  const validIds = new Set(tagihanValid.map((r) => r.id));
  const dipilih = tagihanValid.filter((r) => transaksiIds.map(Number).includes(r.id));
  if (dipilih.length !== transaksiIds.length) {
    throw conflict('Ada transaksi yang dipilih sudah lunas / sedang ada sesi pembayaran QRIS lain / bukan milik pelanggan ini');
  }

  // Perubahan #83: dari app pelanggan, QR Winpay HANYA untuk pesanan metode Kios-K
  // (Cash & QRIS statis dibayar di kasir). Kasir boleh bikin QR untuk pesanan apa pun.
  if (!dibuatOlehKaryawanId && dipilih.some((r) => r.metode_bayar !== 'kiosk')) {
    throw badRequest('QR Kios-K hanya untuk pesanan dengan metode Kios-K. Pesanan Cash / QRIS dibayar di kasir.');
  }

  const amount = dipilih.reduce((s, r) => s + (Number(r.total) || 0), 0);
  if (amount <= 0) throw badRequest('Total tagihan harus lebih dari 0');

  let partnerReferenceNo = await buatRefDariInvoice(cabangId, dipilih); // #85
  const kodeBayar = await generateKodeBayarUnik(cabangId);
  let pembayaranId;
  for (let coba = 0; ; coba++) {
    try {
      pembayaranId = await db.transaction(async (conn) => {
        const id = await pembayaranQrisModel.create({
          cabangId, pelangganId, partnerReferenceNo, kodeBayar, amount, dibuatOlehKaryawanId,
        }, conn);
        await pembayaranQrisModel.tautkanTransaksi(id, dipilih.map((r) => r.id), conn);
        return id;
      });
      break;
    } catch (e) {
      // 2 QR dibuat bersamaan untuk invoice yg sama -> ref kembar; ambil urutan berikutnya
      if (e && e.code === 'ER_DUP_ENTRY' && coba < 3) {
        partnerReferenceNo = coba < 2 ? await buatRefDariInvoice(cabangId, dipilih) : buatPartnerReferenceNo(cabangId);
        continue;
      }
      throw e;
    }
  }

  // Generate QR ke Winpay. Kalau gagal, tandai sesi 'failed' (BUKAN dibiarkan
  // 'pending' tanpa qr_url) -- soalnya kode_bayar-nya harus langsung "mati"
  // juga, biar gak nyangkut sebagai kode yang keliatan valid tapi QR-nya
  // gak akan pernah ada (lihat qr_url IS NOT NULL di findByKode() model).
  // Caller (controller/frontend) yang nampilin errornya; pelanggan tinggal
  // klik "Bayar Semua"/generate lagi buat dapat kode baru.
  // Catatan: setHasilGenerate() DITARUH di try/catch yang SAMA dengan
  // generateQr() (bukan cuma generateQr() doang) -- soalnya kalau generate
  // ke Winpay sukses tapi gagal DISIMPAN (mis. error DB), sesi akan
  // nyangkut selamanya di status 'pending' tanpa qr_url. Itu bikin
  // transaksi yang udah ke-link ke sesi ini "hilang" dari daftar tagihan
  // (lihat NOT EXISTS ... status='pending' di findBelumLunasByPelanggan),
  // padahal QR-nya sendiri gak akan pernah bisa dipakai. Jadi apapun yang
  // gagal di antara generate sampai simpan, harus sama-sama nge-set
  // status 'failed' biar transaksi kembali muncul & bisa dicoba ulang.
  let hasil;
  try {
    try {
      hasil = await winpayService.generateQr({ partnerReferenceNo, amount });
    } catch (e) {
      // #85: Winpay bilang Merchant Ref sudah pernah dipakai (4094701) -> pakai
      // ref cadangan (format lama, pasti unik) & coba sekali lagi.
      const kode = e && e.winpayResponse && e.winpayResponse.responseCode;
      if (kode !== '4094701') throw e;
      const refLama = partnerReferenceNo;
      partnerReferenceNo = buatPartnerReferenceNo(cabangId);
      await db.query('UPDATE pembayaran_qris SET partner_reference_no = ? WHERE id = ?', [partnerReferenceNo, pembayaranId]);
      logger.warn('Merchant Ref dobel di Winpay, pakai ref cadangan', { pembayaranId, refLama, refBaru: partnerReferenceNo });
      hasil = await winpayService.generateQr({ partnerReferenceNo, amount });
    }
    await pembayaranQrisModel.setHasilGenerate(pembayaranId, {
      contractId: hasil.contractId, qrUrl: hasil.qrUrl, qrContent: hasil.qrContent,
      expiredAt: hasil.expiredAt, rawResponse: hasil.raw,
    });
  } catch (e) {
    logger.error('Winpay generateQr/simpan hasil gagal', { pembayaranId, partnerReferenceNo, err: e.message });
    await pembayaranQrisModel.setStatus(pembayaranId, { status: 'failed' });
    throw e;
  }

  return {
    id: pembayaranId, partner_reference_no: partnerReferenceNo, kode_bayar: kodeBayar, amount,
    qr_url: hasil.qrUrl, qr_content: hasil.qrContent, expired_at: hasil.expiredAt,
    transaksi: dipilih.map((r) => ({ id: r.id, no_invoice: r.no_invoice, total: Number(r.total) || 0 })),
  };
}

/**
 * Tombol "Bayar Semua" di tab Pesanan Aktif -- BEDA dari buatSesiPembayaran()
 * yang nerima transaksiIds pilihan pelanggan (checkbox); di sini SEMUA
 * transaksi belum-lunas pelanggan itu otomatis diproses, gak ada pilihan
 * manual dari pelanggan.
 *
 * PENTING: tagihan dipisah berdasarkan `metode_bayar` yang dipilih pelanggan
 * SAAT ORDER dibuat -- tagihan cash TIDAK BOLEH ikut digabung ke sesi QRIS
 * (nominalnya jadi salah/ketagih dobel kalau ikut), tetap harus dibayar cash
 * langsung ke kasir. Cuma tagihan metode 'qris' yang digabung jadi 1 sesi
 * QR dinamis + kode_bayar (reuse buatSesiPembayaran() apa adanya, termasuk
 * validasi ulang & pengecekan cabang.winpay_aktif di dalamnya).
 *
 * PENTING JUGA: sesi 'pending' LAMA milik pelanggan ini (kalau ada -- mis.
 * dia generate kode bayar sebelumnya terus nutup sheet-nya tanpa dibayar)
 * di-cancel dulu di awal. Soalnya transaksi yang udah "terkunci" ke sesi
 * pending gak akan muncul lagi di findBelumLunasByPelanggan() (lihat NOT
 * EXISTS ... status='pending'), jadi tanpa langkah ini pelanggan yang nutup
 * sheet kode bayar gak akan PERNAH bisa dapat kode baru buat transaksi itu
 * lagi (macet permanen). Klik "Bayar Semua" jadi selalu berarti "kasih saya
 * kode bayar TERBARU buat semua tagihan qris yang sekarang", nyuperseed
 * kode manapun yang lama.
 *
 * @returns kalau ADA tagihan qris: hasil buatSesiPembayaran() + `cash_transaksi`
 *   (daftar tagihan cash yang TIDAK ikut, buat ditampilkan terpisah ke pelanggan).
 *   Kalau SEMUA tagihan metode cash (gak ada qris sama sekali): `{ semuaCash: true, cash_transaksi }`
 *   TANPA nyoba generate sesi QRIS sama sekali (gak ada gunanya, sesi bakal kosong).
 */
async function buatSesiBayarSemua({ cabangId, pelangganId, dibuatOlehKaryawanId = null }) {
  await batalkanSemuaSesiPendingPelanggan(pelangganId, cabangId);

  const tagihan = await transaksiModel.findBelumLunasByPelanggan(pelangganId, cabangId);
  if (!tagihan.length) throw badRequest('Tidak ada tagihan yang belum lunas');

  // Perubahan #83: tagihan dipecah per metode yang dipilih saat pesan.
  // Cash & QRIS (statis) dibayar di kasir -> cuma ditampilkan sebagai info.
  // Kios-K -> digabung jadi 1 kode bayar (QR Winpay di tablet kiosk).
  const ringkas = (r) => ({ id: r.id, no_invoice: r.no_invoice, total: Number(r.total) || 0 });
  const kel = { cash: [], qris: [], kiosk: [] };
  tagihan.forEach((t) => { (kel[t.metode_bayar] || kel.cash).push(t); });
  const rincian = {};
  for (const k of ['cash', 'qris', 'kiosk']) {
    if (!kel[k].length) continue;
    rincian[k] = { jumlah: kel[k].length, total: kel[k].reduce((s2, r) => s2 + (Number(r.total) || 0), 0), transaksi: kel[k].map(ringkas) };
  }
  const cashRingkas = kel.cash.map(ringkas);

  if (!kel.kiosk.length) {
    return { tanpaKiosk: true, semuaCash: !kel.qris.length, rincian, cash_transaksi: cashRingkas };
  }

  let hasil;
  try {
    hasil = await buatSesiPembayaran({
      cabangId, pelangganId, transaksiIds: kel.kiosk.map((t) => t.id), dibuatOlehKaryawanId,
    });
  } catch (e) {
    // Kios-K gagal/nonaktif -> rincian tetap dikirim; bagian Kios-K dibayar di kasir
    logger.warn('Bayar Semua: kode Kios-K gagal dibuat', { pelangganId, err: e.message });
    return { kioskGagal: true, pesan_kiosk: e.message, rincian, cash_transaksi: cashRingkas };
  }
  return { ...hasil, rincian, cash_transaksi: cashRingkas };
}

/** Status 1 sesi pembayaran -- buat polling dari frontend. */
async function statusSesi(pembayaranId) {
  const row = await pembayaranQrisModel.findById(pembayaranId);
  if (!row) throw notFound('Sesi pembayaran tidak ditemukan');
  return {
    id: row.id, status: row.status, amount: Number(row.amount) || 0,
    kode_bayar: row.kode_bayar, qr_url: row.qr_url, expired_at: row.expired_at, paid_at: row.paid_at,
  };
}

/**
 * Lookup buat TABLET KIOSK dinding (public/kiosk/) -- publik, TANPA info
 * identitas pelanggan (nama/telepon/pelanggan_id) sama sekali, cuma yang
 * perlu ditampilin di layar QR: jumlah & QR-nya sendiri. Lihat
 * findByKode() di model buat aturan "masih hidup"-nya (status pending, ada
 * qr_url, belum expired).
 */
async function sesiByKode(cabangId, kodeBayar) {
  const row = await pembayaranQrisModel.findByKode(cabangId, kodeBayar);
  if (!row) {
    throw notFound('Kode bayar tidak ditemukan / sudah kadaluarsa'); // #78: dulu Error biasa -> jadi 500
  }
  return {
    id: row.id, amount: Number(row.amount) || 0,
    qr_url: row.qr_url, qr_content: row.qr_content, expired_at: row.expired_at,
  };
}

/** Cari 1 karyawan aktif di cabang -- dipakai sebagai "kasir sistem" pas transaksi.service.bayar() dipanggil otomatis dari webhook (gak ada kasir manusia yang mencet). */
async function karyawanSistemUntukCabang(cabangId) {
  const row = await db.queryOne(
    `SELECT id FROM karyawan WHERE cabang_id = ? AND status = 'aktif' ORDER BY id ASC LIMIT 1`,
    [cabangId]
  );
  return row ? row.id : null;
}

/**
 * Proses callback/notify dari Winpay. Idempotent -- Winpay bisa retry sampai
 * 3x, jadi kalau sesi udah 'paid' sebelumnya, callback berikutnya diabaikan
 * (bukan diulang prosesnya).
 * @param {object} payload - body callback (sudah divalidasi signature-nya di controller)
 * @returns {{ok: boolean, alreadyProcessed?: boolean}}
 */
async function prosesCallback(payload) {
  const partnerReferenceNo = payload.originalPartnerReferenceNo;
  if (!partnerReferenceNo) throw badRequest('originalPartnerReferenceNo tidak ada di payload callback');

  const sesi = await pembayaranQrisModel.findByPartnerRef(partnerReferenceNo);
  if (!sesi) throw notFound('Sesi pembayaran tidak ditemukan untuk referensi ini');

  if (sesi.status === 'paid') {
    return { ok: true, alreadyProcessed: true }; // idempotent, callback ke-2/3 dari Winpay
  }

  // Status SNAP: 00 Success, 01 Initiated, 02 Paying, 03 Pending, 04 Refunded,
  // 05 Canceled, 06 Failed, 07 Not found.
  // #78: hanya 05/06 yang menggagalkan sesi; 01-03 = masih proses (abaikan),
  // 04/07 dicatat di log saja (jangan ubah status lokal).
  const st = String(payload.latestTransactionStatus || '').padStart(2, '0');
  if (st !== '00') {
    if (st === '05' || st === '06') {
      if (sesi.status === 'pending') await pembayaranQrisModel.setStatus(sesi.id, { status: 'failed', rawCallback: payload });
    } else {
      logger.info('Winpay callback status non-final diabaikan', { pembayaranId: sesi.id, status: st });
    }
    return { ok: true };
  }

  // #78: nominal yang dibayar HARUS sama dengan nominal sesi.
  const nominal = payload.amount && payload.amount.value != null ? Math.round(Number(payload.amount.value)) : null;
  if (nominal == null || nominal !== Math.round(Number(sesi.amount))) {
    logger.error('Winpay callback nominal TIDAK COCOK -- transaksi tidak ditandai lunas, cek manual', {
      pembayaranId: sesi.id, nominal_callback: payload.amount, nominal_sesi: sesi.amount,
    });
    return { ok: true, nominalTidakCocok: true };
  }
  if (sesi.status !== 'pending') {
    // dibayar setelah sesi dibatalkan/kedaluwarsa -> uang tetap masuk, catat lunas
    logger.warn('Winpay callback sukses untuk sesi yang sudah tidak pending', { pembayaranId: sesi.id, statusLama: sesi.status });
  }

  await pembayaranQrisModel.setStatus(sesi.id, { status: 'paid', paidAt: new Date(), rawCallback: payload });

  // Tandai LUNAS semua transaksi yang tersangkut di sesi ini, reuse persis
  // logic yang sama kayak kasir klik "Konfirm Bayar" manual (poin, kas,
  // stok, dst) -- lihat src/services/transaksi.service.js:bayar().
  const transaksiIds = await pembayaranQrisModel.listTransaksiIds(sesi.id);
  const kasirId = await karyawanSistemUntukCabang(sesi.cabang_id);
  const transaksiService = require('./transaksi.service'); // lazy require -- hindari circular dependency (transaksi.service belum & tidak perlu require balik file ini)

  for (const transaksiId of transaksiIds) {
    try {
      const trx = await transaksiModel.findById(transaksiId);
      if (!trx || trx.status_bayar === 'lunas') continue; // udah lunas duluan (mis. dikonfirm manual barengan) -- skip, jangan dobel proses
      await transaksiService.bayar(transaksiId, { metode_bayar: 'kiosk', sumber_bayar: 'winpay' }, { kasirId }); // #83: Kios-K
    } catch (e) {
      // Satu transaksi gagal di-tandai lunas TIDAK boleh bikin transaksi lain
      // di sesi yang sama ikut gagal -- log & lanjut, biar bisa ditangani
      // manual sama kasir (uang udah masuk, tinggal beresin pencatatan).
      logger.error('Gagal tandai lunas transaksi dari callback Winpay', { transaksiId, pembayaranId: sesi.id, err: e.message });
    }
  }

  return { ok: true };
}

/**
 * Dipanggil pas kasir klik "Konfirm Bayar Manual" -- kalau transaksi itu
 * masih punya sesi pembayaran_qris yang PENDING, cancel dulu ke Winpay biar
 * gak dobel/nyangkut. Best-effort: gagal cancel ke Winpay TETAP lanjut set
 * status lokal jadi 'canceled' (uangnya emang gak akan masuk 2x, worst case
 * QR-nya masih "hidup" di sisi Winpay sampai expired sendiri).
 */
async function batalkanSesiPendingUntukTransaksi(transaksiId) {
  const sesi = await pembayaranQrisModel.findPendingByTransaksiId(transaksiId);
  if (!sesi) return null;
  try {
    await winpayService.cancel({ partnerReferenceNo: sesi.partner_reference_no, contractId: sesi.contract_id, reason: 'Dibayar manual oleh kasir' });
  } catch (e) {
    logger.error('Gagal cancel QR ke Winpay (lanjut set status lokal)', { sesiId: sesi.id, err: e.message });
  }
  await pembayaranQrisModel.setStatus(sesi.id, { status: 'canceled' });
  return sesi.id;
}

/**
 * Cancel SEMUA sesi pembayaran_qris 'pending' milik 1 pelanggan di 1 cabang
 * (bisa lebih dari 1 baris kalau pelanggan generate kode bayar berkali-kali
 * tanpa pernah bayar/nutup sesi lama dulu -- mis. sheet "Kode Bayar" ditutup
 * begitu aja). Dipanggil di awal buatSesiBayarSemua() (lihat komentarnya)
 * biar tombol "Bayar Semua" SELALU bisa nge-generate kode baru, gak macet
 * gara-gara sesi lama masih nyangkut 'pending' & bikin transaksinya
 * "hilang" dari daftar tagihan. Best-effort ke Winpay (gagal cancel di sisi
 * Winpay TETAP lanjut set status lokal 'canceled').
 */
async function batalkanSemuaSesiPendingPelanggan(pelangganId, cabangId) {
  const daftarSesi = await pembayaranQrisModel.findPendingByPelanggan(pelangganId, cabangId);
  for (const sesi of daftarSesi) {
    try {
      await winpayService.cancel({ partnerReferenceNo: sesi.partner_reference_no, contractId: sesi.contract_id, reason: 'Digantikan sesi bayar baru' });
    } catch (e) {
      logger.error('Gagal cancel sesi qris lama ke Winpay (lanjut set status lokal)', { sesiId: sesi.id, err: e.message });
    }
    await pembayaranQrisModel.setStatus(sesi.id, { status: 'canceled' });
  }
}

module.exports = {
  daftarTagihan, buatSesiPembayaran, buatSesiBayarSemua, statusSesi, sesiByKode,
  prosesCallback, batalkanSesiPendingUntukTransaksi, batalkanSemuaSesiPendingPelanggan,
};
