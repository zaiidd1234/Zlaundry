/**
 * src/services/customer.service.js
 * =============================================================================
 * Logika untuk endpoint publik customer (tanpa login). Identitas = telepon.
 * Reuse master/pelanggan/transaksi service & model yang sudah ada.
 *
 * - listCabang()                         : cabang + koordinat (UI hitung terdekat / dropdown)
 * - katalog(cabangId)                    : layanan + barang per cabang
 * - lookup(cabangId, telepon)            : cek pelanggan eksisting (autofill), TANPA create
 * - riwayat(cabangId, telepon, tab)      : daftar pesanan milik telepon itu
 * - detailMilik(cabangId, telepon, id)   : detail 1 transaksi, dipastikan milik telepon & cabang
 * =============================================================================
 */

const masterService = require('./master.service');
const transaksiService = require('./transaksi.service');
const pelangganModel = require('../models/pelanggan.model');
const transaksiModel = require('../models/transaksi.model');
const mesinUsageModel = require('../models/mesin-usage.model');
const detailTransaksiModel = require('../models/detail-transaksi.model');
const layananModel = require('../models/layanan.model');
const promoService = require('./promo.service');
const db = require('../config/database');
const { normalizeHp } = require('../helpers/phone');
const { now } = require('../helpers/date');
const { notFound, badRequest, forbidden, conflict } = require('../helpers/errors');

const listCabang = () => masterService.listCabang();

const katalog = (cabangId) => masterService.katalog(cabangId);

/** Cek pelanggan by HP (autofill). Return { found, pelanggan? } tanpa membuat data. */
async function lookup(cabangId, telepon, loc = {}) {
  const hp = normalizeHp(telepon);
  if (!hp || hp.length < 9) return { found: false };
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) return { found: false };
  // catat login dengan lokasi (fire & forget)
  pelangganModel.catatLogin(p.id, loc).catch(() => {});
  return {
    found: true,
    pelanggan: { id: p.id, nama: p.nama, telepon: p.telepon, alamat: p.alamat, point: p.point },
  };
}

/** Daftar riwayat pesanan milik sebuah telepon di cabang ini. */
async function riwayat(cabangId, telepon, tab = 'aktif') {
  const hp = normalizeHp(telepon);
  if (!hp) throw badRequest('Nomor HP tidak valid');
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) return [];                       // belum pernah pesan -> kosong
  const list = await transaksiModel.findByPelanggan(p.id, { tab });

  // kategori_list dikirim DB sebagai CSV ("cuci,kering") -> pecah jadi array
  // buat semua baris (aktif maupun selesai), dipakai front-end nentuin tahapan
  // mana yang relevan ditampilkan di timeline kartu (lihat orderCard() di app.js).
  list.forEach((t) => {
    t.kategori_list = t.kategori_list ? String(t.kategori_list).split(',').filter(Boolean) : [];
  });

  // Khusus tab aktif: sisipkan next_action + riwayat/mesin_pakai (reuse getDetail supaya
  // hasilnya PERSIS sama dengan yang ditampilkan di halaman detail — 1 sumber kebenaran).
  // Jumlah pesanan aktif per pelanggan biasanya kecil, jadi aman dipanggil per-baris.
  if (tab === 'aktif' && list.length) {
    await Promise.all(list.map(async (t) => {
      try {
        const d = await transaksiService.getDetail(t.id);
        t.next_action = d.next_action;
        t.riwayat = d.riwayat;
        t.mesin_pakai = d.mesin_pakai;
      } catch (e) {
        t.next_action = null; t.riwayat = []; t.mesin_pakai = [];
      }
    }));
  }
  return list;
}

/**
 * Detail transaksi, dipastikan milik telepon & cabang yang diminta (cegah intip orang lain).
 */
async function detailMilik(cabangId, telepon, transaksiId) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) throw notFound('Pelanggan tidak ditemukan');

  const detail = await transaksiService.getDetail(transaksiId);
  if (detail.cabang_id !== cabangId || detail.pelanggan_id !== p.id) {
    throw forbidden('Transaksi ini bukan milik Anda');
  }
  return detail;
}

/* ============================================================
   WEWENANG CUSTOMER: PROSES MESIN
   =============================================================
   Setelah kasir konfirmasi bayar (status_bayar = 'lunas'), customer
   diberi wewenang untuk menjalankan SENDIRI 3 tahap mesin (via app,
   tanpa harus ke kasir): pilih mesin -> mulai -> selesai (cuci/kering).
   Tahap lain (antar, setrika, siap diambil, dst) TETAP hanya kasir.
   ============================================================ */

// Whitelist status yang boleh dipicu customer sendiri. Server yang menentukan
// target status berikutnya (dari next_action) — customer TIDAK bisa memilih
// status sembarangan, cuma bisa "lanjut" sesuai urutan resmi state-machine.
const ALLOWED_CUSTOMER_STATUS = [
  'alokasi_mesin_cuci', 'mulai_cuci', 'selesai_cuci',
  'alokasi_mesin_kering', 'mulai_kering', 'selesai_kering',
];

/** Daftar mesin siap pakai (status aktif) untuk dipilih customer. */
async function daftarMesin(cabangId, tipe) {
  if (!['washer', 'dryer'].includes(tipe)) throw badRequest('Tipe mesin tidak valid');
  const list = await masterService.listMesin(cabangId, { tipe });
  return list.filter((m) => m.status === 'aktif' && !m.direservasi); // hanya idle & belum dipesan orang lain
}

// Fallback estimasi durasi (menit) kalau sesi yang lagi jalan tidak (belum) punya
// info durasi_target dari layanan (mis. layanan lama tanpa durasi_menit terisi).
const DEFAULT_DURASI_MENIT = { washer: 40, dryer: 45 };

/**
 * Ringkasan status mesin per tipe (washer/dryer) untuk ditampilkan ke customer
 * di menu "Data Saya", supaya customer tidak numpuk antrian datang ke outlet
 * saat semua mesin lagi terpakai.
 *
 * Mesin dengan status 'maintenance'/'nonaktif' tidak dihitung sama sekali
 * (bukan bagian dari armada yang bisa dipakai customer hari ini).
 *
 * PERHITUNGAN ETA memperhitungkan juga PELANGGAN YANG SUDAH BAYAR TAPI MASIH
 * ANTRE (belum kebagian mesin sama sekali -- lihat detailTransaksiModel.
 * hitungAntreanMesin). Simulasinya: tiap pelanggan yang antre "diambilkan"
 * mesin yang PALING CEPAT selesai di antara semua mesin yang lagi jalan --
 * begitu mesin itu selesai, langsung dipakai lagi orang yang antre itu buat
 * 1 siklus penuh. Efeknya, mesin yang tadinya "paling cepat selesai" jadi
 * mesin yang PALING LAMA tersedia (karena kepakai 2x), dan estimasi "mesin
 * tersedia dalam X menit" ke customer baru otomatis geser ke mesin
 * TERCEPAT BERIKUTNYA yang beneran kosong buat dia -- bukan ke mesin yang
 * sudah "dipesan" antrean.
 *
 * @returns {{washer: StatusTipe, dryer: StatusTipe}}
 *   StatusTipe = { idle, busy, antre, total, eta_menit }
 *   eta_menit hanya terisi (bukan null) kalau idle === 0 dan ada mesin yang jalan
 */
async function statusMesin(cabangId) {
  const [mesinList, sesiAktif, antreCuci, antreKering] = await Promise.all([
    masterService.listMesin(cabangId),
    mesinUsageModel.aktifByCabang(cabangId),
    detailTransaksiModel.hitungAntreanMesin(cabangId, 'cuci'),
    detailTransaksiModel.hitungAntreanMesin(cabangId, 'kering'),
  ]);

  const sesiByMesinId = new Map(sesiAktif.map((u) => [Number(u.mesin_id), u]));
  const sekarang = new Date(now().replace(' ', 'T')).getTime();
  const jmlAntre = { washer: antreCuci, dryer: antreKering };

  function ringkasTipe(tipe) {
    const armada = mesinList.filter((m) => m.tipe === tipe && ['aktif', 'jalan'].includes(m.status));
    // Mesin yang sudah "direservasi" (dipilih kasir tapi belum "mulai") dihitung
    // TERPAKAI, bukan idle -- walau kolom status mentahnya masih 'aktif'.
    const idle = armada.filter((m) => m.status === 'aktif' && !m.direservasi).length;
    const busyList = armada.filter((m) => m.status === 'jalan' || (m.status === 'aktif' && m.direservasi));
    const antre = jmlAntre[tipe] || 0;

    let etaMenit = null;
    if (idle === 0 && busyList.length > 0) {
      const durasiDefault = DEFAULT_DURASI_MENIT[tipe] || 40;

      // waktu SELESAI (timestamp absolut, ms) tiap mesin yang lagi jalan/direservasi
      const waktuBebas = busyList.map((m) => {
        const sesi = sesiByMesinId.get(Number(m.id));
        const durasi = (sesi && sesi.durasi_target) || durasiDefault;
        const mulaiMs = sesi ? new Date(String(sesi.waktu_mulai).replace(' ', 'T')).getTime() : sekarang;
        return mulaiMs + durasi * 60000;
      });

      // Simulasi antrean: tiap pelanggan yang sudah bayar & antre "menempati"
      // mesin yang paling cepat bebas saat itu, lalu mesin itu dianggap kepakai
      // lagi 1 siklus penuh (durasiDefault) sebelum beneran kosong lagi.
      for (let i = 0; i < antre; i++) {
        let idxTercepat = 0;
        for (let j = 1; j < waktuBebas.length; j++) {
          if (waktuBebas[j] < waktuBebas[idxTercepat]) idxTercepat = j;
        }
        waktuBebas[idxTercepat] += durasiDefault * 60000;
      }

      const bebasTercepatMs = Math.min(...waktuBebas);
      etaMenit = Math.max(1, Math.ceil((bebasTercepatMs - sekarang) / 60000));
    }

    return { idle, busy: busyList.length, antre, total: armada.length, eta_menit: etaMenit };
  }

  const hasil = { washer: ringkasTipe('washer'), dryer: ringkasTipe('dryer') };
  // Mode antrian terkunci: ETA order baru = mesin yang paling cepat kosong
  // (memperhitungkan antrian per mesin), sama persis dengan yang akan didapat.
  for (const tipe of ['washer', 'dryer']) {
    if (hasil[tipe].idle === 0) {
      const eta = await require('./antrian-mesin.service').etaOrderBaru(cabangId, tipe).catch(() => null);
      if (eta != null) hasil[tipe].eta_menit = Math.max(1, eta);
    }
  }
  return hasil;
}

/**
 * Jalankan 1 langkah proses mesin atas nama customer sendiri.
 * @param {number} cabangId
 * @param {string} telepon   identitas pemilik pesanan (wajib cocok)
 * @param {number} transaksiId
 * @param {object} input     { mesin_id? } — wajib diisi kalau tahapnya "pilih mesin"
 */
async function aksiMesinProses(cabangId, telepon, transaksiId, { mesin_id = null } = {}) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) throw notFound('Pelanggan tidak ditemukan');

  const detail = await transaksiService.getDetail(transaksiId);
  if (detail.cabang_id !== cabangId || detail.pelanggan_id !== p.id) {
    throw forbidden('Transaksi ini bukan milik Anda');
  }
  if (detail.status_bayar !== 'lunas' && !Number(detail.bayar_saat_ambil)) {
    throw conflict('Menunggu konfirmasi pembayaran dari kasir sebelum proses bisa dimulai');
  }

  const na = detail.next_action || {};
  if (!na.target || !ALLOWED_CUSTOMER_STATUS.includes(na.target)) {
    throw forbidden('Tahap pesanan ini hanya bisa diproses oleh kasir');
  }
  if (na.tipe === 'pilih_mesin' && !mesin_id) {
    throw badRequest('Pilih mesin terlebih dahulu');
  }

  // userId: null -> tercatat di riwayat sebagai aksi customer sendiri (bukan staff)
  return transaksiService.pindahStatus(
    transaksiId,
    { status: na.target, mesin_id: mesin_id || null },
    { userId: null },
  );
}

/**
 * Daftar jenis promo yang BISA DIPAKAI SEKARANG oleh pelanggan (by telepon),
 * dipakai tombol "Gunakan Promo" di customer/kasir SEBELUM order dibuat.
 * Kalau nomor HP belum pernah transaksi sama sekali di cabang ini (pelanggan
 * baru beneran), pelangganId dianggap null -- fungsi2 di bawah sudah didesain
 * aman menangani itu (otomatis dianggap "belum pernah transaksi").
 *
 * INI CUMA PREVIEW (baca db.pool langsung, bukan dalam transaksi/lock) --
 * validasi FINAL & mengikat tetap terjadi lagi saat order beneran dibuat
 * (lihat transaksi.service.js createOrder), jadi aman walau ada race
 * condition kecil antara preview & submit beneran (kuota Jumat dst tetap
 * dijamin benar di titik commit, bukan di titik preview ini).
 */
async function promoTersedia(cabangId, telepon) {
  const hpNorm = normalizeHp(telepon);
  const pelanggan = hpNorm ? await pelangganModel.findByTelepon(cabangId, hpNorm) : null;
  const pelangganId = pelanggan ? pelanggan.id : null;

  const [promoJumatRow, promoBaruRow] = await Promise.all([
    layananModel.findPromoByCabangJenis(cabangId, 'gratis_cuci_jumat_berkah'),
    layananModel.findPromoByCabangJenis(cabangId, 'gratis_cuci_pelanggan_baru'),
  ]);

  const daftarJenis = await promoService.promoYangBisaDipakai(db.pool, {
    cabangId, pelangganId, tanggal: now(),
    jumatTersedia: !!promoJumatRow, pelangganBaruTersedia: !!promoBaruRow,
  });

  const rowByJenis = { gratis_cuci_jumat_berkah: promoJumatRow, gratis_cuci_pelanggan_baru: promoBaruRow };
  return daftarJenis.map((jenis) => {
    const row = rowByJenis[jenis];
    return {
      jenis_promo: jenis,
      label: promoService.PROMO_LABEL[jenis] || jenis,
      harga_normal: row ? Number(row.harga) : null,
      harga_promo: row ? (Number(row.harga_promo) || 0) : null,
    };
  });
}

/* ============================================================
   BAYAR VIA QRIS DINAMIS (Winpay) -- identitas via telepon, sama kayak
   fungsi customer lain di file ini. pembayaranQrisService yang urus logic
   inti; di sini cuma resolve telepon->pelanggan & pastiin kepemilikan.
   ============================================================ */
const pembayaranQrisService = require('./pembayaran-qris.service');

/** GET tagihan belum lunas milik 1 nomor telepon -- buat checkbox pilih di app customer. */
async function tagihanQris(cabangId, telepon) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) return [];
  return pembayaranQrisService.daftarTagihan(p.id, cabangId);
}

/** Generate QR dinamis dari transaksi-transaksi terpilih milik 1 nomor telepon. */
async function buatPembayaranQris(cabangId, telepon, transaksiIds) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) throw notFound('Pelanggan tidak ditemukan');
  return pembayaranQrisService.buatSesiPembayaran({
    cabangId, pelangganId: p.id, transaksiIds, dibuatOlehKaryawanId: null,
  });
}

/** Tombol "Bayar Semua" di tab Pesanan Aktif -- gabung SEMUA tagihan belum lunas nomor telepon ini, sekalian dapat kode_bayar 4 digit buat tablet kiosk. */
async function bayarSemuaQris(cabangId, telepon) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) throw notFound('Pelanggan tidak ditemukan');
  return pembayaranQrisService.buatSesiBayarSemua({ cabangId, pelangganId: p.id });
}

/** Status sesi pembayaran (polling) -- dipastikan sesi itu emang milik nomor telepon ini. */
async function statusPembayaranQris(cabangId, telepon, pembayaranId) {
  const hp = normalizeHp(telepon);
  const p = await pelangganModel.findByTelepon(cabangId, hp);
  if (!p) throw notFound('Pelanggan tidak ditemukan');
  const sesi = await pembayaranQrisService.statusSesi(pembayaranId);
  const row = await require('../models/pembayaran-qris.model').findById(pembayaranId);
  if (!row || row.cabang_id !== cabangId || row.pelanggan_id !== p.id) {
    throw forbidden('Sesi pembayaran ini bukan milik Anda');
  }
  return sesi;
}

module.exports = {
  listCabang, katalog, lookup, riwayat, detailMilik,
  daftarMesin, aksiMesinProses, statusMesin, promoTersedia,
  tagihanQris, buatPembayaranQris, bayarSemuaQris, statusPembayaranQris,
};
