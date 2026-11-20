/**
 * src/services/transaksi.service.js
 * =============================================================================
 * Inti pembuatan order laundry. createOrder() merangkai semuanya dalam SATU
 * transaksi DB (atomik):
 *   1. identifikasi pelanggan (lookup-or-create by HP)
 *   2. validasi & susun item dari katalog (snapshot harga)
 *   3. validasi kapasitas mesin (ada washer/dryer yg muat berat? kalau tidak -> tolak)
 *   4. generate no_invoice (locked, anti-race)
 *   5. insert header (status awal: menunggu_bayar)
 *   6. alokasi keranjang (kalau ada cucian) -> set keranjang_id + kode_antrian
 *   7. insert detail item
 *   8. hitung & set total
 * Pembayaran TERPISAH (lihat bayar() di step berikutnya).
 *
 * KONTRAK INPUT createOrder(input, ctx):
 *   ctx   = { cabangId, kasirId }            (dari req.user)
 *   input = {
 *     pelanggan: { telepon, nama?, alamat? },
 *     berat_kg,                               // wajib jika ada layanan cucian
 *     alamat_antar?,                          // wajib jika antar/antar_jemput
 *     layanan: [ { layanan_id, qty? } ],      // qty untuk per_km (jarak); selain itu dihitung
 *     barang:  [ { barang_id, qty } ],
 *     diskon?,                                // default 0
 *     sumber_pesan?                           // 'kasir' | 'customer_app'
 *   }
 * =============================================================================
 */

const db = require('../config/database');
const pelangganService = require('./pelanggan.service');
const keranjangService = require('./keranjang.service');
const layananModel = require('../models/layanan.model');
const barangModel = require('../models/barang.model');
const mesinModel = require('../models/mesin.model');const mesinUsageModel = require('../models/mesin-usage.model');
const iotLogModel = require('../models/iot-log.model');
const statusModel = require('../models/status-master.model');
const transaksiModel = require('../models/transaksi.model');
const detailModel = require('../models/detail-transaksi.model');
const statusLogModel = require('../models/transaksi-status-log.model');
const pelangganModel = require('../models/pelanggan.model');
const cabangModel = require('../models/cabang.model');
const keranjangModel = require('../models/keranjang.model');
const kasKecilModel = require('../models/kas-kecil.model');
const kasBesarModel = require('../models/kas-besar.model');
const transferModel = require('../models/transfer.model');
const kasService = require('./kas.service');
const stokService = require('./stok.service');
const mesinService = require('./mesin.service');
const antrianService = require('./antrian-mesin.service');
const mesinLogManualModel = require('../models/mesin-log-manual.model');
const iotService = require('./iot.service');
const whatsappService = require('./whatsapp.service');
const promoService = require('./promo.service');
const jatahService = require('./jatah.service');
const logger = require('../config/logger');
const { nextStatus, canMoveTo, efekOf } = require('../helpers/state-machine');
const { generateNoInvoice, generateIdTransfer } = require('../helpers/invoice');
const { now, today } = require('../helpers/date');
const { hitungPoin, hitungPoinItems, poinTercatat, addFrekuensi } = require('../helpers/poin');
const metodeBayarService = require('./metode-bayar.service');
const { badRequest, notFound, conflict, forbidden } = require('../helpers/errors');
const { waLink } = require('../helpers/phone');

// mesinTipe -> kategori layanan terkait
const TIPE_KE_KATEGORI = { washer: 'cuci', dryer: 'kering' };

// Kategori yang dianggap "cucian" (butuh berat + keranjang)
const KATEGORI_CUCIAN = ['cuci', 'kering', 'lipat', 'setrika_lipat', 'drop_off'];
const KATEGORI_ANTAR = ['antar', 'antar_jemput', 'jemput']; // #73: alamat wajib

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// COA biaya MDR Winpay (fee dipotong Winpay saat QRIS dinamis settle langsung
// ke kas besar). Fallback ke COA_ADMIN_TOPUP_GOPAY (bucket "biaya admin
// payment gateway" yang sudah ada) sampai owner buat COA khusus & set env ini.
const COA_MDR_WINPAY = Number(process.env.COA_MDR_WINPAY) || Number(process.env.COA_ADMIN_TOPUP_GOPAY) || 41;
const COA_GOPAY = Number(process.env.COA_SALDO_GOPAY) || 4; // 1-102 Saldo Gopay (sama seperti transfer.service.js)

/**
 * Susun daftar item (jasa + barang) dari katalog, hitung subtotal.
 * Validasi: layanan/barang ada, milik cabang, aktif; qty sesuai satuan.
 * @returns {Array} items siap di-insert + flag kategori
 */
async function susunItem(cabangId, input) {
  const items = [];
  const kategoriAda = new Set();
  // Perubahan #35: berat boleh desimal (disimpan apa adanya), tetapi tier
  // harga cuci & layanan per kg memakai berat DIBULATKAN (9,4 -> 9; 6,5 -> 7;
  // di bawah 1 kg dihitung 1 kg).
  const beratAsli = Number(input.berat_kg) || 0;
  const berat = beratAsli > 0 ? Math.max(1, Math.round(beratAsli)) : 0;

  // ---- LAYANAN (jasa) ----
  for (const sel of input.layanan || []) {
    let L = await layananModel.findById(sel.layanan_id);
    if (!L || L.cabang_id !== cabangId || L.status !== 'aktif') {
      throw badRequest(`Layanan id ${sel.layanan_id} tidak valid untuk cabang ini`);
    }

    // TIER HARGA CUCI BERDASAR BERAT: kalau cabang ini punya >1 baris "Cuci"
    // aktif (beda berat_maks), SERVER yang nentuin baris yang benar berdasar
    // berat_kg -- BUKAN percaya begitu saja layanan_id yang dikirim client
    // (anti-manipulasi: kirim id murah padahal cucian berat). Kalau cabang
    // cuma punya 1 baris Cuci (default/lama), tidak ada override sama sekali
    // -- perilaku lama persis, flat price apa pun beratnya.
    if (L.kategori === 'cuci') {
      const opsiCuci = await layananModel.findCuciByCabang(cabangId);
      if (opsiCuci.length > 1) {
        if (berat <= 0) throw badRequest('Berat cucian wajib diisi untuk menentukan tarif Cuci di cabang ini');
        L = opsiCuci.find((r) => r.berat_maks == null || berat <= Number(r.berat_maks)) || opsiCuci[opsiCuci.length - 1];
      }
    }

    let qty;
    if (L.satuan_hitung === 'per_load') qty = Number(sel.qty) || 1; // default 1 load
    else if (L.satuan_hitung === 'per_kg') {
      if (berat <= 0) throw badRequest('Berat cucian wajib diisi untuk layanan per kg');
      qty = berat;
    } else if (L.satuan_hitung === 'per_km') {
      qty = Number(sel.qty) || 0;
      if (qty <= 0) throw badRequest(`Jarak (km) wajib diisi untuk layanan ${L.nama_paket}`);
    } else {
      qty = Number(sel.qty) || 1;
    }

    // DROP-OFF: pilihan bebas customer/kasir, tarif per mesin -- tapi tetap
    // dikunci maks 2 di server (anti-manipulasi, jangan percaya qty kiriman
    // client mentah-mentah), independen dari layanan cuci/kering/antar lain.
    if (L.kategori === 'drop_off') qty = Math.max(0, Math.min(2, qty));
    if (L.kategori === 'drop_off' && qty <= 0) continue; // qty 0 -> jangan disisipkan sbg item

    kategoriAda.add(L.kategori);

    const harga = Number(L.harga);
    items.push({
      item_tipe: 'jasa',
      layanan_id: L.id,
      barang_id: null,
      kategori: L.kategori,
      nama_item: L.nama_paket,           // snapshot
      harga_satuan: harga,               // snapshot
      qty,
      subtotal: round2(harga * qty),
    });
  }

  // ---- BARANG ----
  for (const sel of input.barang || []) {
    const qty = Number(sel.qty) || 0;
    if (qty <= 0) continue;
    const B = await barangModel.findById(sel.barang_id);
    if (!B || B.cabang_id !== cabangId || B.status !== 'aktif') {
      throw badRequest(`Barang id ${sel.barang_id} tidak valid untuk cabang ini`);
    }
    const harga = Number(B.harga_jual);
    items.push({
      item_tipe: 'barang',
      layanan_id: null,
      barang_id: B.id,
      kategori: null,
      nama_item: B.nama,                 // snapshot
      harga_satuan: harga,               // snapshot
      qty,
      subtotal: round2(harga * qty),
    });
  }

  if (items.length === 0) throw badRequest('Minimal pilih satu layanan atau barang');

  return { items, kategoriAda };
}

/** Perubahan #83: id COA dari kode (fallback kalau belum ada). */
async function coaIdByKode(conn, kode, fallback) {
  const [rows] = await conn.execute('SELECT id FROM coa WHERE kode = ? LIMIT 1', [kode]);
  return rows && rows[0] ? rows[0].id : fallback;
}

/**
 * Buat order baru. Mengembalikan transaksi lengkap (header + items + pelanggan + keranjang).
 */
async function createOrder(input, ctx) {
  const { cabangId, kasirId } = ctx;
  const berat = Number(input.berat_kg) || null;

  // Perubahan #39: "Pesan untuk saya" -- order kasir sendiri pakai jatah cuci
  const pakaiJatah = !!input.jatah_karyawan;
  if (pakaiJatah) {
    if (ctx.role !== 'kasir') throw forbidden('Jatah cuci hanya untuk akun kasir');
    const k = await require('../models/karyawan.model').findById(kasirId);
    if (!k || !k.telepon) throw badRequest('Isi nomor HP kamu dulu untuk memakai jatah cuci');
    input = { ...input, pelanggan: { telepon: k.telepon, nama: k.nama }, promo_pilihan: null, diskon: 0, barang: [], sumber_pesan: 'kasir' };
  }

  // Perubahan #83: metode bayar harus aktif di cabang (jatah karyawan tidak dibayar)
  if (!pakaiJatah) await metodeBayarService.pastikanAktif(cabangId, input.metode_bayar || 'cash');

  // 1) susun item (read katalog) — di luar transaksi tulis, validasi dulu
  const { items, kategoriAda } = await susunItem(cabangId, input);

  const adaCucian = [...kategoriAda].some((k) => KATEGORI_CUCIAN.includes(k));
  const adaAntar = [...kategoriAda].some((k) => KATEGORI_ANTAR.includes(k));

  if (adaCucian && (!berat || berat <= 0)) throw badRequest('Berat cucian wajib diisi');
  if (adaAntar && !(input.alamat_antar && input.alamat_antar.trim())) {
    throw badRequest('Alamat antar wajib diisi untuk layanan antar/antar-jemput');
  }

  // catatan: kapasitas mesin TIDAK divalidasi saat order. Pengecekan kapasitas
  // dilakukan saat pilih/alokasi mesin (mesin.service.alokasi), karena di situ
  // baru diketahui mesin mana yang dipakai.

  // 3) status awal
  const stMenunggu = await statusModel.findByKode('menunggu_bayar');
  if (!stMenunggu) throw badRequest('status_master belum di-seed (menunggu_bayar)');

  // catatan: subtotal/diskon/total BELUM dihitung di sini (beda dari sebelumnya) --
  // sengaja ditunda sampai di dalam transaksi DB (5b-lanjutan), karena promo cuci
  // gratis butuh tahu pelanggan.id dulu (baru didapat lewat identifikasi()), dan
  // kalau promo kepakai, item Cuci-nya di-nolkan SEBELUM subtotal dihitung.

  // 5) jalankan dalam 1 transaksi DB
  const result = await db.transaction(async (conn) => {
    // 5a) identifikasi pelanggan (atomik)
    const { pelanggan } = await pelangganService.identifikasi({
      cabangId,
      telepon: input.pelanggan.telepon,
      nama: input.pelanggan.nama,
      alamat: input.pelanggan.alamat,
    }, conn);

    // 5b) no_invoice (locked)
    // PENTING: kode cabang WAJIB diambil dari DB (bukan dari ctx.cabangKode/JWT/body
    // client), karena sumbernya bisa kosong/salah dan diam-diam jatuh ke fallback
    // 'ZL01' untuk semua cabang -> no_invoice bentrok antar cabang (unique key violation,
    // muncul sebagai 409 Conflict). Lihat juga services/transfer.service.js.
    const cabangRow = await cabangModel.findById(cabangId);
    if (!cabangRow) throw badRequest('Cabang tidak ditemukan');
    const noInvoice = await generateNoInvoice(conn, cabangId, cabangRow.kode);
    const tanggal = now();

    // 5b-lanjutan) PROMO CUCI GRATIS — sekarang EKSPLISIT (tombol "Gunakan
    // Promo" di customer/kasir), BUKAN otomatis lagi. `input.promo_pilihan`
    // (kalau dikirim) WAJIB divalidasi ULANG di sini (jangan percaya client
    // begitu saja) -- dicek di dalam transaksi DB yang sama dengan
    // generateNoInvoice di atas (lock FOR UPDATE), anti race-condition kuota
    // "5 pelanggan pertama" Jumat kalau 2 checkout kebetulan bersamaan.
    //
    // MEKANISME (baris layanan promo, bukan diskon di transaksi): kalau
    // promo_pilihan valid & cabang ini punya baris layanan promo aktif utk
    // jenis itu, item "Cuci" yang customer/kasir pilih di-SUBSTITUSI ke
    // baris layanan promo tsb -- harga_satuan/subtotal jadi ikut
    // `harga_promo` (biasanya 0). Kalau promo_pilihan TIDAK dikirim, atau
    // ternyata tidak valid lagi (mis. kuota Jumat abis pas checkout), order
    // tetap jalan normal dengan harga biasa -- TIDAK ada lagi auto-apply.
    //
    // Efeknya: `transaksi.subtotal/diskon/total` TIDAK berubah sama sekali
    // strukturnya (diskon tetap murni buat tukar poin, seperti semula) --
    // "kegratisannya" sudah tercermin langsung dari harga item itu sendiri.
    const cuciItem = items.find((it) => it.item_tipe === 'jasa' && it.kategori === 'cuci');
    let jenisPromo = null;
    const promoDiminta = input.promo_pilihan || null;
    if (cuciItem && promoDiminta) {
      const [promoJumatRow, promoBaruRow] = await Promise.all([
        layananModel.findPromoByCabangJenis(cabangId, 'gratis_cuci_jumat_berkah'),
        layananModel.findPromoByCabangJenis(cabangId, 'gratis_cuci_pelanggan_baru'),
      ]);
      const valid = await promoService.validasiPromoPilihan(conn, promoDiminta, {
        cabangId, pelangganId: pelanggan.id, tanggal,
        jumatTersedia: !!promoJumatRow,
        pelangganBaruTersedia: !!promoBaruRow,
      });
      if (valid) jenisPromo = promoDiminta;
      const promoRow = jenisPromo === 'gratis_cuci_jumat_berkah' ? promoJumatRow
        : jenisPromo === 'gratis_cuci_pelanggan_baru' ? promoBaruRow
        : null;
      if (promoRow) {
        const hargaPromo = Number(promoRow.harga_promo) || 0;
        cuciItem.layanan_id = promoRow.id;
        cuciItem.nama_item = promoRow.nama_paket;
        cuciItem.harga_satuan = hargaPromo;
        cuciItem.subtotal = round2(hargaPromo * cuciItem.qty);
      } else {
        jenisPromo = null; // eligible secara aturan tapi barisnya nonaktif/gak ada -> anggap tidak dapat promo
      }
    }

    // Perubahan #39: potong harga cuci/kering dengan sisa jatah (bagian jatah tidak dibukukan)
    const jatahHasil = pakaiJatah ? await jatahService.terapkan(conn, kasirId, items) : null;

    // 4) hitung total (persis seperti sebelum ada fitur promo -- diskon murni
    // tukar poin/manual, tidak ada campur tangan promo di sini)
    const subtotal = round2(items.reduce((s, it) => s + it.subtotal, 0));
    const diskon = round2(Number(input.diskon) || 0);
    const total = round2(Math.max(subtotal - diskon, 0));

    // 5c) insert header
    const transaksiId = await transaksiModel.create(conn, {
      cabang_id: cabangId,
      pelanggan_id: pelanggan.id,
      kasir_id: kasirId,
      keranjang_id: null,
      kode_antrian: null,
      status_terakhir_id: stMenunggu.id,
      no_invoice: noInvoice,
      tanggal,
      berat_kg: berat,
      alamat_antar: input.alamat_antar || null,
      subtotal, diskon, total,
      metode_bayar: input.metode_bayar || 'cash', // sementara; final saat bayar
      status_bayar: 'belum',
      status_setor: 'belum_setor',
      sumber_pesan: input.sumber_pesan || 'kasir',
    });

    // 5d) alokasi keranjang kalau ada cucian
    let keranjang = null;
    if (adaCucian) {
      keranjang = await keranjangService.alokasi(conn, cabangId, transaksiId);
      await transaksiModel.setKeranjang(conn, transaksiId, keranjang.id, keranjang.kode);
    }

    // 5e) insert detail item
    for (const it of items) {
      await detailModel.create(conn, {
        transaksi_id: transaksiId,
        item_tipe: it.item_tipe,
        layanan_id: it.layanan_id,
        barang_id: it.barang_id,
        mesin_id: null, // dialokasikan saat status mesin (Fase 5)
        nama_item: it.nama_item,
        harga_satuan: it.harga_satuan,
        qty: it.qty,
        subtotal: it.subtotal,
      });
    }

    if (jatahHasil) {
      await jatahService.catat(conn, {
        karyawanId: kasirId, cabangId, transaksiId, minggu: jatahHasil.minggu,
        nilaiOrder: jatahHasil.nilaiOrder, nominal: jatahHasil.nominal,
      });
    }

    return { transaksiId, noInvoice, pelanggan, keranjang, jenisPromo, jatahHasil };
  });

  // 6) kalau transaksi BARANG SAJA (tanpa jasa apa pun) DAN dibuat kasir (POS
  // langsung/tunai di tempat): auto-lunas + langsung selesai (skip siap_diambil, tanpa WA).
  // KHUSUS order dari customer app -> JANGAN auto-complete: (a) gak ada kasirId sama
  // sekali (customer app gak login staff) jadi bakal error pas nyoba catat kas_kecil
  // (karyawan_id NOT NULL), dan (b) secara logika juga salah -- customer app cuma
  // "memesan" dari jauh, belum tentu udah bayar/udah diambil di tempat. Biarkan
  // pesanan barang-only dari customer app nunggu di "menunggu_bayar" seperti pesanan
  // lain, nanti kasir yang proses bayar & serah-terima seperti biasa.
  const barangSaja = items.length > 0 && items.every((it) => it.item_tipe === 'barang');
  const dariKasir = (input.sumber_pesan || 'kasir') !== 'customer_app';
  if (barangSaja && dariKasir) {
    await bayar(result.transaksiId, { metode_bayar: input.metode_bayar || 'cash' }, { kasirId });
    // setelah lunas (sudah_bayar), majukan LANGSUNG ke sudah_diambil — pakai pool langsung (tanpa conn transaksi terpisah)
    try {
      const stSelesai = await statusModel.findByKode('sudah_diambil');
      if (stSelesai) {
        await transaksiModel.setStatusPool(result.transaksiId, stSelesai.id);
        await statusLogModel.create({
          transaksi_id: result.transaksiId,
          status_id: stSelesai.id,
          karyawan_id: kasirId,
          waktu: now(),
          keterangan: 'Penjualan barang - selesai otomatis',
        });
      }
    } catch (e) { logger.error('Set selesai barang-saja gagal', { id: result.transaksiId, err: e.message }); }
  }

  // 7) ambil transaksi lengkap untuk response
  const header = await transaksiModel.findById(result.transaksiId);
  const detail = await detailModel.findByTransaksi(result.transaksiId);
  return {
    ...header, pelanggan: result.pelanggan, keranjang: result.keranjang, items: detail,
    barang_saja: barangSaja, jenis_promo: result.jenisPromo || null,
    jatah: result.jatahHasil ? { nilai_order: result.jatahHasil.nilaiOrder, dipakai: result.jatahHasil.nominal } : null,
  };
}

/**
 * Bayar transaksi (kasir klik "sudah bayar", atau otomatis dari webhook Winpay).
 * Dalam 1 transaksi DB:
 *   - set status_bayar=lunas, status_terakhir=sudah_bayar, metode_bayar
 *   - kas_kecil pendapatan per item (akun cash/gopay sesuai metode)
 *   - kurangi stok barang + stok_mutasi
 *   - update point & frekuensi pelanggan
 *   - catat status log sudah_bayar
 *   - KALAU input.sumber_bayar === 'winpay': langsung "setor otomatis" dalam
 *     transaksi yang sama -- pendapatan yang barusan dicatat ke kas_kecil
 *     (supaya omzet/performa cabang tetap akurat) langsung diringkas & di-
 *     posting ke kas_besar (sumber 'setor_penjualan', sama seperti setoran
 *     manual biasa) DIKURANGI biaya MDR (kas_besar keluar, sumber
 *     'winpay_mdr') -- karena uang QRIS dinamis Winpay sudah otomatis
 *     settle ke rekening asli, bukan fisik di tangan kasir, jadi TIDAK lewat
 *     alur "Setor" manual seperti QRIS statis/cash. Lihat
 *     sql/2026-09-23_winpay_prioritas_cabang.sql.
 * @param {number} transaksiId
 * @param {object} input { metode_bayar: 'cash'|'qris', sumber_bayar?: 'manual'|'winpay' }
 * @param {object} ctx   { kasirId }
 */
async function bayar(transaksiId, input, ctx) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (header.status_bayar === 'lunas') throw conflict('Transaksi sudah lunas');

  // Kalau transaksi ini lagi punya sesi QRIS dinamis (Winpay) yang masih
  // PENDING (mis. kasir generate QR duluan, tapi pelanggan akhirnya bayar
  // cash/ditandai manual), cancel dulu sesi itu ke Winpay biar gak nyangkut
  // dobel. Best-effort -- gagal cancel TIDAK boleh menggagalkan pembayaran
  // manual ini (uangnya udah di tangan kasir/pelanggan udah bayar).
  try {
    await require('./pembayaran-qris.service').batalkanSesiPendingUntukTransaksi(transaksiId);
  } catch (e) {
    logger.error('Gagal cancel sesi QRIS pending saat bayar manual (lanjut)', { transaksiId, err: e.message });
  }

  // metode bayar: ikut yang sudah dipilih saat pesan (header); input hanya override opsional
  // sumber_bayar: 'winpay' cuma dikirim dari pembayaran-qris.service.js:prosesCallback()
  // (webhook Winpay) -- lihat step 2d di bawah untuk beda pembukuannya vs QRIS statis/cash.
  const sumberBayar = input.sumber_bayar === 'winpay' ? 'winpay' : 'manual';
  // Perubahan #83: metode 'kiosk' (Kios-K/Winpay) HANYA lewat callback Winpay.
  // Bayar manual di kasir untuk pesanan Kios-K wajib pilih cash / qris.
  const metodeMinta = input.metode_bayar || header.metode_bayar;
  let metode;
  if (sumberBayar === 'winpay') metode = 'kiosk';
  else if (metodeMinta === 'kiosk') {
    throw badRequest('Pesanan ini metode Kios-K: dibayar lewat kiosk/QR Winpay. Kalau pelanggan bayar di kasir, pilih Cash atau QRIS.');
  } else metode = metodeMinta === 'qris' ? 'qris' : 'cash';
  // kas kecil: cash -> laci; qris & kiosk -> akun gopay (kiosk langsung di-"setor" lagi di step 2d, net 0)
  const akun = metode === 'cash' ? 'cash' : 'gopay';

  const items = await detailModel.findByTransaksi(transaksiId);
  if (items.length === 0) throw badRequest('Transaksi tidak punya item');

  const stSudahBayar = await statusModel.findByKode('sudah_bayar');
  if (!stSudahBayar) throw badRequest('status_master belum di-seed (sudah_bayar)');

  const tanggal = now();
  const ymd = today();
  // Perubahan #13: order "bayar saat ambil" sudah diproses -> status tahap
  // TIDAK direset ke sudah_bayar, stok sudah dipotong saat mulai diproses.
  const bsa = !!Number(header.bayar_saat_ambil);

  await db.transaction(async (conn) => {
    // 1) status bayar
    await transaksiModel.setBayar(conn, transaksiId, {
      status_bayar: 'lunas',
      status_terakhir_id: bsa ? header.status_terakhir_id : stSudahBayar.id,
      metode_bayar: metode,
      tanggal_bayar: tanggal,
    });

    // 2) pendapatan per item -> kas_kecil. Untuk item PROMO (is_promo=1 di
    // baris layanannya), subtotal-nya di detail_transaksi memang 0 (customer
    // tidak bayar) -- makanya di bawah ini kita TAMBAH pendapatan senilai harga
    // NORMAL layanan itu (langkah 2b) supaya pendapatan jasa cuci tetap
    // tercatat penuh di pembukuan, lalu langsung dikeluarkan lagi sebagai
    // biaya marketing (langkah 2c) -- sesuai arahan owner.
    await kasService.catatPendapatanTransaksi(conn, {
      transaksi: header, items, akun, metode, kasirId: ctx.kasirId, tanggal,
    });

    // 2b + 2c) cari item jasa yang lagi PROMO, lalu posting pendapatan penuh +
    // biaya marketing sebesar nilai promonya (harga normal - harga yang sudah
    // dibayar, yaitu 0). Biasanya cuma ada 1 item Cuci per transaksi.
    const itemJasa = items.filter((it) => it.item_tipe === 'jasa' && it.layanan_id);
    for (const it of itemJasa) {
      const layananRow = await layananModel.findById(it.layanan_id);
      if (!layananRow || !Number(layananRow.is_promo)) continue; // bukan item promo, skip

      const nilaiPromo = round2((Number(layananRow.harga) || 0) - (Number(it.subtotal) || 0));
      if (nilaiPromo <= 0) continue; // tidak ada selisih (mis. harga normal ternyata sama), tidak perlu posting apa-apa

      let promoKasirId = ctx.kasirId || header.kasir_id;
      if (!promoKasirId) {
        const [karRow] = await conn.execute(
          `SELECT id FROM karyawan WHERE cabang_id = ? AND status = 'aktif' ORDER BY id ASC LIMIT 1`,
          [header.cabang_id]
        );
        promoKasirId = karRow && karRow[0] ? karRow[0].id : null;
      }
      if (!promoKasirId) {
        logger.error('Pembukuan promo gagal: tidak ada karyawan aktif di cabang', { transaksiId, cabangId: header.cabang_id });
        continue;
      }

      const labelPromo = promoService.PROMO_LABEL[layananRow.jenis_promo] || 'Promo cuci gratis';

      // 2b) tambahan pendapatan (masuk) senilai harga normal yang "hilang" tadi
      await kasKecilModel.insert({
        cabang_id: header.cabang_id,
        tanggal,
        akun,
        jenis: 'masuk',
        jenis_mutasi: 'pendapatan',
        coa_id: layananRow.coa_id,
        ref_transaksi_id: transaksiId,
        ref_detail_transaksi_id: it.id,
        nominal: nilaiPromo,
        metode_asal: metode,
        karyawan_id: promoKasirId,
        keterangan: `Pendapatan penuh (${labelPromo}) - ${header.no_invoice}`,
      }, conn);

      // 2c) biaya marketing (keluar) senilai yang sama -> net kas tetap benar
      await kasKecilModel.insert({
        cabang_id: header.cabang_id,
        tanggal,
        akun,
        jenis: 'keluar',
        jenis_mutasi: 'biaya_loyalty', // bucket generik "pendapatan yg di-nol-kan lewat biaya" (dibedakan lewat coa_id)
        coa_id: promoService.MARKETING_COA_ID,
        ref_transaksi_id: transaksiId,
        ref_detail_transaksi_id: it.id,
        nominal: nilaiPromo,
        metode_asal: metode,
        karyawan_id: promoKasirId,
        keterangan: `${labelPromo} - ${header.no_invoice}`,
      }, conn);
    }

    // 2d) KHUSUS bayar via Winpay: "setor otomatis" pendapatan yang barusan
    // dicatat di step 2/2b ke kas_besar dalam transaksi DB yang sama, karena
    // uangnya sudah settle otomatis ke rekening asli -- TIDAK menunggu kasir
    // klik "Setor" manual seperti QRIS statis/cash. Reuse fungsi posting yang
    // sama persis dengan alur setor manual (transfer.service.js) supaya
    // laporan/omzet manager tetap konsisten.
    if (sumberBayar === 'winpay') {
      // Perubahan #83: poin yang direservasi saat pesan langsung dipotong di
      // sini (dulu cuma lewat tombol bayar kasir -> Winpay tidak pernah potong)
      await catatTukarPoin(conn, { ...header, metode_bayar: 'kiosk' }, transaksiId);
      const cabangRow = await cabangModel.findById(header.cabang_id);
      if (!cabangRow) throw badRequest('Cabang tidak ditemukan');
      const idTransfer = await generateIdTransfer(conn, header.cabang_id, cabangRow.kode);
      const totalPendapatanTransaksi = round2(Number(header.total) || 0);
      const mdrPersen = Number(cabangRow.mdr_winpay_persen) || 0;
      const biayaMdr = round2(totalPendapatanTransaksi * (mdrPersen / 100));
      const netTransfer = round2(totalPendapatanTransaksi - biayaMdr);

      const transferId = await transferModel.create(conn, {
        cabang_id: header.cabang_id, tanggal, id_transfer: idTransfer, arah: 'kasir_ke_management',
        nominal_transfer: netTransfer, total_pendapatan: totalPendapatanTransaksi, total_reimburse: 0,
        // 0 (bukan null) -- kolom ini NOT NULL di tabel `transfer`. Jalur
        // setor manual biasa isi ini dgn saldo dompet gopay kasir nyata;
        // jalur Winpay gak punya konsep itu (duit settle otomatis langsung
        // ke rekening, gak numpang lewat dompet gopay kasir), jadi 0 aja.
        saldo_gopay_snapshot: 0, jumlah_transaksi: 1, karyawan_id: ctx.kasirId || null,
      });

      // stempel transaksi + baris kas_kecil pendapatan (termasuk baris promo
      // step 2b kalau ada) dgn transfer_id ini -- WAJIB sebelum posting ke
      // kas_besar di bawah, karena postingPendapatanDariTransfer/
      // postingLoyaltyDariTransfer meringkas berdasarkan transfer_id ini.
      await transaksiModel.stempelSetor(conn, transferId, [transaksiId]);
      await kasKecilModel.stempelPendapatan(conn, transferId, [transaksiId]);

      // baris kas_kecil 'setor' (keluar) -- menutup saldo kas_kecil, karena
      // uangnya memang tidak pernah fisik ada di laci/saldo gopay kasir
      await kasKecilModel.insert({
        cabang_id: header.cabang_id, tanggal, akun: 'gopay', jenis: 'keluar',
        jenis_mutasi: 'setor', coa_id: COA_GOPAY, transfer_id: transferId,
        nominal: totalPendapatanTransaksi, karyawan_id: ctx.kasirId || null,
        metode_asal: 'kiosk', // #83: baris Kios-K disembunyikan dari tampilan kas kecil (net 0)
        keterangan: `Setor otomatis Winpay ${idTransfer} - ${header.no_invoice}`,
      }, conn);

      // posting pendapatan per COA + biaya loyalty (kalau ada item promo) ke
      // kas_besar -- reuse persis fungsi yang dipakai alur setor manual
      await kasBesarModel.postingPendapatanDariTransfer(conn, {
        transferId, tanggal, cabangId: header.cabang_id, kasirId: ctx.kasirId || null, idTransfer,
      });
      await kasBesarModel.postingLoyaltyDariTransfer(conn, {
        transferId, tanggal, cabangId: header.cabang_id, kasirId: ctx.kasirId || null, idTransfer,
      });

      // biaya MDR Winpay (keluar), TERPISAH dari pendapatan -- biar laba-rugi
      // manager kelihatan gross pendapatan vs biaya MDR-nya, bukan net yang
      // sudah dipotong diam-diam. mdr_winpay_persen NULL/0 = belum di-set,
      // tidak ada biaya dicatat (bukan error, biar tidak memblokir pembayaran).
      const coaMdr = await coaIdByKode(conn, '6-107', COA_MDR_WINPAY); // #83: Biaya MDR QRIS Pelanggan
      if (biayaMdr > 0) {
        await kasBesarModel.insert({
          transfer_id: transferId, tanggal, jenis: 'keluar', coa_id: coaMdr,
          nominal: biayaMdr, sumber: 'winpay_mdr', ref_cabang_id: header.cabang_id,
          karyawan_id: ctx.kasirId || null,
          keterangan: `Biaya MDR Winpay ${mdrPersen}% - ${header.no_invoice}`,
        }, conn);
      } else if (!cabangRow.mdr_winpay_persen) {
        logger.error('mdr_winpay_persen belum di-set utk cabang ini -- bayar Winpay diposting TANPA potongan MDR', { cabangId: header.cabang_id, transaksiId });
      }

      // Perubahan #83: dana bersih masih di rekening Winpay (belum ditarik) ->
      // keluarkan dari kas besar fisik ke "Saldo Winpay". Masuk lagi ke kas
      // besar saat manager/owner klik "Tarik ke Kas Besar" (sumber winpay_tarik).
      // Tidak masuk laba-rugi (bukan pendapatan/biaya, cuma pindah tempat uang).
      if (netTransfer > 0) {
        const coaWinpay = await coaIdByKode(conn, '1-103', null);
        await kasBesarModel.insert({
          transfer_id: transferId, tanggal, jenis: 'keluar', coa_id: coaWinpay,
          nominal: netTransfer, sumber: 'winpay_titip', ref_cabang_id: header.cabang_id,
          karyawan_id: ctx.kasirId || null,
          keterangan: `Dana Kios-K di Winpay (belum ditarik) - ${header.no_invoice}`,
        }, conn);
      }
    }

    // 3) kurangi stok barang (bayar saat ambil: sudah dipotong saat diproses)
    if (!bsa) {
      await stokService.kurangiUntukTransaksi(conn, {
        transaksi: header, items, kasirId: ctx.kasirId, tanggal,
      });
    }

    // 4) point & frekuensi pelanggan — dihitung dari total yang dibayar
    // Perubahan #39: order jatah karyawan tidak dapat poin pelanggan
    // Perubahan #83: poin hanya dari layanan mesin (cuci & kering), dicatat di transaksi.poin_didapat
    const poin = (await jatahService.orderJatah(transaksiId, conn)) ? 0 : hitungPoinItems(items, header.total);
    await transaksiModel.setPoinDidapat(conn, transaksiId, poin);
    const sudahAda = await transaksiModel.adaTransaksiHari(header.pelanggan_id, ymd, transaksiId, conn);
    await require('../models/pelanggan.model').tambahPointFrekuensi(
      header.pelanggan_id, poin, addFrekuensi(sudahAda), conn
    );

    // 5) status log (bayar saat ambil: TIDAK menambah log status -- waktu
    // status dipakai urutan antrian mesin; pembayaran tercatat di kas &
    // transaksi.tanggal_bayar)
    if (!bsa) await statusLogModel.create({
      transaksi_id: transaksiId,
      status_id: stSudahBayar.id,
      karyawan_id: ctx.kasirId,
      waktu: tanggal,
      keterangan: `Bayar ${metode} lunas`,
    }, conn);
  });

  // notif WA setelah bayar (kasir kirim manual via wa.me)
  let waOut = null;
  let waCtxBayar = null;
  let kategoriListBayar = [];
  try {
    const pelanggan = await pelangganModel.findById(header.pelanggan_id);
    const cabang = await cabangModel.findById(header.cabang_id).catch(() => null);
    const keranjang = header.keranjang_id ? await keranjangModel.findById(header.keranjang_id).catch(() => null) : null;
    const kodeKeranjang = keranjang ? keranjang.kode : null;
    const ktxBayar = await konteksTransaksi(transaksiId).catch(() => ({ kategoriList: [], dropOffQty: 0 }));
    kategoriListBayar = ktxBayar.kategoriList;
    const argsWa = { nama: pelanggan && pelanggan.nama, noInvoice: header.no_invoice, cabang, kodeKeranjang, kategoriList: kategoriListBayar, dropOffQty: ktxBayar.dropOffQty, total: header.total };
    waCtxBayar = { telepon: pelanggan && pelanggan.telepon, args: argsWa };
    const pesan = whatsappService.buildMessage(bsa ? 'lunas_saat_ambil' : 'sudah_bayar', argsWa);
    const link = waLink(pelanggan && pelanggan.telepon, pesan);
    if (link) waOut = { link, terkirim_api: false };
  } catch (e) { logger.error('WA notif bayar gagal', { transaksiId, err: e.message }); }

  // Antrian mesin TERKUNCI (mode 'otomatis'): begitu lunas, order langsung
  // dapat mesin yang dijanjikan + urutan antrian (urut konfirmasi bayar);
  // kalau mesin janjinya kosong, langsung dialokasikan (status alokasi_*).
  // Lihat services/antrian-mesin.service.js. Mode 'manual' -> no-op (kasir
  // tetap pilih mesin sendiri seperti biasa).
  await antrianService.refresh(header.cabang_id);
  // pesan WA "sudah bayar" ditambah info mesin janji + estimasi (kalau antre)
  if (waOut && waCtxBayar && !bsa) {
    try {
      const antrian = await infoAntrianWa(header.cabang_id, transaksiId);
      if (antrian) {
        const link = waLink(waCtxBayar.telepon, whatsappService.buildMessage('sudah_bayar', { ...waCtxBayar.args, antrian }));
        if (link) waOut = { link, terkirim_api: false };
      }
    } catch (e) { logger.error('WA info antrian gagal', { transaksiId, err: e.message }); }
  }

  const updatedFinal = await transaksiModel.findById(transaksiId);
  const statusFinal = updatedFinal.status_terakhir_id ? await statusModel.findById(updatedFinal.status_terakhir_id) : null;

  return { ...updatedFinal, items, poin: hitungPoinItems(items, header.total), status_kode: statusFinal ? statusFinal.kode : 'sudah_bayar', wa: waOut };
}

/**
 * Perubahan #13 -- "Proses, Bayar Saat Ambil" (kasir).
 * Order belum bayar langsung diproses: status -> sudah_bayar (tahap awal
 * proses, masuk antrian mesin urut waktu klik), stok barang dipotong sekarang
 * (barang langsung dipakai). status_bayar tetap 'belum': kas, setoran & poin
 * baru dicatat saat uang diterima (bayar()). Sudah Diambil dikunci sampai lunas.
 */
async function prosesBayarSaatAmbil(transaksiId, ctx) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (ctx.cabangId && header.cabang_id !== ctx.cabangId) throw conflict('Transaksi bukan dari cabang ini');
  if (header.status_bayar === 'lunas') throw conflict('Transaksi sudah lunas');
  if (Number(header.bayar_saat_ambil)) throw conflict('Pesanan ini sudah diproses (bayar saat ambil)');
  const cur = header.status_terakhir_id ? await statusModel.findById(header.status_terakhir_id) : null;
  if (cur && cur.kode !== 'menunggu_bayar') throw conflict('Pesanan sudah diproses');

  const items = await detailModel.findByTransaksi(transaksiId);
  if (items.length === 0) throw badRequest('Transaksi tidak punya item');
  const stSudahBayar = await statusModel.findByKode('sudah_bayar');
  const tanggal = now();

  await db.transaction(async (conn) => {
    const [lock] = await conn.execute(`SELECT status_bayar, bayar_saat_ambil FROM transaksi WHERE id = ? FOR UPDATE`, [transaksiId]);
    if (!lock[0] || lock[0].status_bayar === 'lunas' || Number(lock[0].bayar_saat_ambil)) throw conflict('Pesanan sudah diproses');
    await transaksiModel.setBayarSaatAmbil(conn, transaksiId, { status_terakhir_id: stSudahBayar.id });
    await stokService.kurangiUntukTransaksi(conn, { transaksi: header, items, kasirId: ctx.kasirId, tanggal });
    await statusLogModel.create({
      transaksi_id: transaksiId, status_id: stSudahBayar.id, karyawan_id: ctx.kasirId, waktu: tanggal,
      keterangan: 'Diproses, bayar saat ambil',
    }, conn);
  });

  await antrianService.refresh(header.cabang_id);

  let waOut = null;
  try {
    const pelanggan = await pelangganModel.findById(header.pelanggan_id);
    const cabang = await cabangModel.findById(header.cabang_id).catch(() => null);
    const keranjang = header.keranjang_id ? await keranjangModel.findById(header.keranjang_id).catch(() => null) : null;
    const { kategoriList, dropOffQty } = await konteksTransaksi(transaksiId);
    const antrian = await infoAntrianWa(header.cabang_id, transaksiId).catch(() => null);
    const pesan = whatsappService.buildMessage('bayar_saat_ambil', {
      nama: pelanggan && pelanggan.nama, noInvoice: header.no_invoice, cabang,
      kodeKeranjang: keranjang ? keranjang.kode : null, kategoriList, dropOffQty, antrian, total: header.total,
    });
    const link = waLink(pelanggan && pelanggan.telepon, pesan);
    if (link) waOut = { link, terkirim_api: false };
  } catch (e) { logger.error('WA bayar saat ambil gagal', { transaksiId, err: e.message }); }

  const akhir = await getDetail(transaksiId);
  return { ...akhir, wa: waOut };
}

/** Ambil transaksi lengkap (header + items + riwayat status + status terkini). */
async function getDetail(transaksiId) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  const items = await detailModel.findByTransaksi(transaksiId);
  const riwayat = await statusLogModel.findByTransaksi(transaksiId);
  // status terkini dari header (selalu ada walau log masih kosong)
  let status_kode = null, status_nama = null;
  if (header.status_terakhir_id) {
    const st = await statusModel.findById(header.status_terakhir_id);
    if (st) { status_kode = st.kode; status_nama = st.nama; }
  }
  // info pelanggan
  let pelanggan = null;
  if (header.pelanggan_id) {
    const p = await pelangganModel.findById(header.pelanggan_id);
    if (p) pelanggan = {
      id: p.id, nama: p.nama, telepon: p.telepon, alamat: p.alamat,
      point: Number(p.point) || 0, kunjungan: Number(p.frekuensi_kedatangan) || 0,
      loyal: (Number(p.frekuensi_kedatangan) || 0) > 1,
    };
  }
  // riwayat pemakaian mesin (washer/dryer yang pernah dipakai, jalan & selesai)
  const usageRows = await mesinUsageModel.byTransaksi(transaksiId);
  const mesin_pakai = usageRows.map((u) => {
    const startMs = new Date(String(u.waktu_mulai).replace(' ', 'T') + '+07:00').getTime();
    const endMs = u.waktu_selesai ? new Date(String(u.waktu_selesai).replace(' ', 'T') + '+07:00').getTime() : Date.now();
    const durasi = isNaN(startMs) ? null : Math.max(0, Math.floor((endMs - startMs) / 60000));
    return {
      kode_mesin: u.kode_mesin,
      tipe: u.tipe,                          // washer | dryer
      kapasitas_kg: u.kapasitas_kg,
      selesai: !!u.waktu_selesai,
      durasi_menit: durasi,
      durasi_target: u.durasi_target ? Number(u.durasi_target) : null,
      // Jam mulai mentah -- dipakai front-end (kartu "Pesanan Aktif" customer)
      // buat nampilin "Mulai: <jam>" / "Estimasi selesai: <jam>" beneran,
      // bukan cuma hitungan mundur relatif.
      waktu_mulai: u.waktu_mulai || null,
    };
  });

  let next_action = { tipe: 'lanjut', target: null, label: 'Lanjut' };
  try {
    next_action = await hitungNextAction(transaksiId, header, status_kode);
  } catch (e) {
    next_action = { tipe: header.status_bayar !== 'lunas' ? 'bayar' : 'lanjut', target: null, label: header.status_bayar !== 'lunas' ? 'Terima Pembayaran' : 'Lanjut Proses' };
  }
  // data cabang untuk struk (alamat, telp, link sosmed)
  let cabang = null;
  try {
    const c = await cabangModel.findById(header.cabang_id);
    if (c) cabang = {
      nama: c.nama, alamat: c.alamat, kota: c.kota, no_hp: c.no_hp,
      link_gmap_review: c.link_gmap_review, link_ig: c.link_ig,
      link_fb: c.link_fb, link_tiktok: c.link_tiktok,
    };
  } catch (e) { /* abaikan */ }
  // Perubahan #83: metode bayar aktif (lembar bayar kasir) + poin yang didapat
  const metode_aktif = await metodeBayarService.aktif(header.cabang_id).catch(() => null);
  const poin_didapat = await transaksiModel.getPoinDidapat(transaksiId).catch(() => null);

  return { ...header, status_kode, status_nama, pelanggan, cabang, items, riwayat, mesin_pakai, next_action, metode_aktif, poin_didapat };
}

/** Tentukan aksi berikutnya untuk UI kasir: status target + apakah perlu pilih mesin. */
/** Floor minimum (menit) sebelum tombol "Selesai Cuci" bisa diklik manual --
 * siklus bilas mesin cuci baru mulai di menit ke-30, klik sebelum itu berarti
 * cucian ditandai selesai padahal belum sempat dibilas. Berlaku sama untuk
 * customer maupun kasir. */
const GATE_SELESAI_CUCI_MENIT = 30; // Perubahan #11: disamakan dengan popup mesin (dulu 25)
const DEFAULT_DURASI_TIPE = { washer: 40, dryer: 45 };

/**
 * Estimasi berapa menit lagi transaksi INI (yang lagi antre) bakal dapat
 * mesin -- simulasi sama persis kayak statusMesin() di customer.service.js,
 * tapi dari sudut pandang "posisi SAYA di antrian" (bukan "orang baru yang
 * baru mau checkout sekarang"). Return null kalau memang gak ada yang lagi
 * jalan (mesin harusnya idle -> caller harusnya gak masuk cabang ini sama
 * sekali kalau state konsisten, tapi safety kalau ada edge case aneh).
 */
async function estimasiAntrianUntukTransaksi(cabangId, tipe, transaksiId) {
  const antrian = await daftarAntrian(cabangId, tipe); // FIFO, urut tanggal ASC
  const posisi = antrian.findIndex((a) => a.transaksi_id === transaksiId) + 1; // 1-based
  if (posisi <= 0) return null;

  const semuaUsage = await mesinUsageModel.aktifByCabang(cabangId);
  const semuaMesin = await mesinModel.findByCabang(cabangId, { tipe });
  const idMesinTipe = new Set(semuaMesin.map((m) => m.id));
  const busy = semuaUsage.filter((u) => idMesinTipe.has(u.mesin_id));
  if (!busy.length) return null;

  const durasiDefault = DEFAULT_DURASI_TIPE[tipe] || 40;
  const sekarang = Date.now();
  const waktuBebas = busy.map((u) => {
    const durasi = u.durasi_target || durasiDefault;
    const mulaiMs = new Date(String(u.waktu_mulai).replace(' ', 'T') + '+07:00').getTime();
    return mulaiMs + durasi * 60000;
  });

  // konsumsi slot buat org yg antre DI DEPAN saya (posisi-1 orang)
  for (let i = 0; i < posisi - 1; i++) {
    let idx = 0;
    for (let j = 1; j < waktuBebas.length; j++) if (waktuBebas[j] < waktuBebas[idx]) idx = j;
    waktuBebas[idx] += durasiDefault * 60000;
  }
  const giliranSayaMs = Math.min(...waktuBebas);
  return Math.max(1, Math.ceil((giliranSayaMs - sekarang) / 60000));
}

async function hitungNextAction(transaksiId, header, currentKode) {
  // butuh kategori transaksi untuk bangun stage
  const { kategoriList, jasa } = await konteksTransaksi(transaksiId);
  // kalau belum lunas -> aksi pertama adalah BAYAR (bukan pindah status)
  const bsa = header.status_bayar !== 'lunas' && !!Number(header.bayar_saat_ambil);
  if (header.status_bayar !== 'lunas' && !bsa) {
    return { tipe: 'bayar', target: null, label: 'Terima Pembayaran' };
  }
  const target = nextStatus(currentKode, kategoriList);
  // bayar saat ambil: sebelum Sudah Diambil / Selesai Antar wajib bayar dulu
  if (bsa && (!target || ['sudah_diambil', 'selesai_antar'].includes(target))) {
    return { tipe: 'bayar', target: null, label: 'Terima Pembayaran (bayar saat ambil)', bayar_saat_ambil: true };
  }
  if (!target) return { tipe: 'selesai', target: null, label: 'Selesai' };
  const efek = efekOf(target);
  const targetRow = await statusModel.findByKode(target);
  const target_nama = targetRow ? targetRow.nama : target;

  // "Selesai Kering": TIDAK ADA tombol manual sama sekali -- durasi dryer
  // sudah pasti & dikontrol sistem sejak awal (customer pilih dry15/30/45,
  // sistem yang jadwalkan OFF-nya via auto-complete). Tidak ada skenario
  // valid untuk "selesai lebih cepat dari jadwal" secara manual.
  if (target === 'selesai_kering') {
    return {
      tipe: 'menunggu_otomatis', target, target_nama, mesin_tipe: null,
      label: 'Menunggu selesai otomatis',
    };
  }

  // "Selesai Cuci": tombol ada, tapi terkunci sampai GATE_SELESAI_CUCI_MENIT
  // terlewati sejak mesin mulai jalan (siklus bilas baru mulai menit ke-20).
  if (target === 'selesai_cuci') {
    const usageList = await mesinUsageModel.byTransaksi(transaksiId);
    const jalan = usageList.find((u) => u.tipe === 'washer' && !u.waktu_selesai);
    if (jalan) {
      const elapsedMenit = (Date.now() - new Date(String(jalan.waktu_mulai).replace(' ', 'T') + '+07:00').getTime()) / 60000;
      if (elapsedMenit < GATE_SELESAI_CUCI_MENIT) {
        const sisaMenit = Math.ceil(GATE_SELESAI_CUCI_MENIT - elapsedMenit);
        return {
          tipe: 'menunggu_gate', target, target_nama, mesin_tipe: null,
          sisa_menit: sisaMenit,
          label: `Tersedia ${sisaMenit} menit lagi`,
        };
      }
    }
  }

  // Mode alokasi cabang: 'otomatis' -> customer/kasir TIDAK disuruh pilih
  // mesin. Kalau ADA mesin kosong sekarang -> tombol "lanjut" biasa (submit
  // tanpa mesin_id, backend yg alokasikan beneran pas diklik), labelnya
  // SUDAH sertain PREDIKSI kode mesin (mis. "Alokasi Mesin Kering di D03")
  // biar customer nggak nunggu buta -- prediksi ini read-only/tanpa lock,
  // BISA beda dari hasil final kalau kebetulan ada yang nyerobot bersamaan
  // (jarang terjadi, dan begitu diklik alokasi beneran tetap lock ulang dari
  // nol, jadi tetap konsisten & anti race-condition). Kalau semua mesin
  // PENUH -> tipe khusus 'menunggu_antrian' dengan estimasi menit, PERSISTEN
  // ditampilkan (bukan toast sekilas) sampai beneran dapat mesin. 'manual' ->
  // tetap 'pilih_mesin' seperti sekarang (customer/kasir pilih sendiri dari
  // daftar mesin kosong).
  let tipeAksi = efek.allocMesin ? 'pilih_mesin' : 'lanjut';
  let sisaAntrianInfo = {};
  let mesinPrediksi = null;
  if (efek.allocMesin) {
    const cabangRow = await cabangModel.findById(header.cabang_id).catch(() => null);
    if (cabangRow && cabangRow.pemilihan_mesin === 'otomatis') {
      // Antrian terkunci: order sudah punya mesin janji + estimasi.
      const info = await antrianService.infoTransaksi(header.cabang_id, transaksiId, efek.allocMesin).catch(() => null);
      tipeAksi = 'menunggu_antrian';
      sisaAntrianInfo = info ? {
        estimasi_menit: info.siap_tunggu_bongkar ? 0 : info.tunggu_menit,
        mesin_antrian: info.kode_mesin, mesin_antrian_pendek: info.kode_mesin_pendek,
        posisi_antrian: info.posisi, siap_tunggu_bongkar: info.siap_tunggu_bongkar,
      } : { estimasi_menit: null };
    }
  }

  let labelAksi = target_nama;
  if (tipeAksi === 'menunggu_antrian') {
    const jenisTxt = efek.allocMesin === 'dryer' ? 'mesin kering' : 'mesin cuci';
    const kodeM = sisaAntrianInfo.mesin_antrian_pendek;
    if (kodeM && sisaAntrianInfo.siap_tunggu_bongkar) {
      labelAksi = `Antre di ${kodeM} · mesin sudah siap, tunggu pelanggan sebelumnya mengeluarkan cucian dari mesin`;
    } else if (kodeM) {
      labelAksi = `Antre di ${kodeM} · estimasi ± ${sisaAntrianInfo.estimasi_menit || 1} menit`;
    } else {
      labelAksi = `Menunggu ${jenisTxt} kosong`;
    }
  } else if (tipeAksi === 'lanjut' && efek.allocMesin && mesinPrediksi) {
    labelAksi = `${target_nama} di ${mesinPrediksi}`;
  }

  return {
    tipe: tipeAksi,
    target,
    target_nama,
    mesin_tipe: efek.allocMesin || null,   // 'washer' | 'dryer' | null
    mesin_prediksi: mesinPrediksi,
    label: labelAksi,
    ...sisaAntrianInfo,
  };
}

/**
 * Susun konteks transaksi: header, detail jasa + kategori/durasi, daftar kategori.
 */
async function konteksTransaksi(transaksiId) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  const details = await detailModel.findByTransaksi(transaksiId);
  const jasa = [];
  const kategoriSet = new Set();
  for (const d of details) {
    if (d.item_tipe === 'jasa') {
      const L = await layananModel.findById(d.layanan_id);
      if (L) { d._kategori = L.kategori; d._durasi = L.durasi_menit; kategoriSet.add(L.kategori); }
      jasa.push(d);
    }
  }
  // Perubahan #33: jumlah drop-off (1x / 2x) menentukan siapa memindahkan cucian -> isi pesan WA
  const dropOffQty = jasa.filter((d) => d._kategori === 'drop_off').reduce((a, d) => a + (Number(d.qty) || 0), 0);
  return { header, details, jasa, kategoriList: [...kategoriSet], dropOffQty };
}

/**
 * Resolve kode mesin buat dilampirkan ke notif WA, sesuai status & kategori
 * layanan transaksi -- dipakai BARENGAN di pindahStatus() (status baru saja
 * berubah) dan setPosisiManual() (status sama, cuma kasir update lokasi
 * manual), satu sumber logic biar gak nyimpang.
 *   - selesai_cuci/selesai_kering : mesin yang BARU SAJA nyelesaiin tahap
 *     ini (mesinLogId, cuma ada pas dipanggil langsung setelah closeUsage).
 *   - siap_diambil (bukan drop-off) : mesin TERAKHIR yang dipakai (dryer
 *     kalau ada kering, washer kalau "Cuci Saja") -- lihat mesin_usage.
 */
async function resolveKodeMesinNotif(transaksiId, statusKode, kategoriList, mesinLogId, dropOffQty = 0) {
  if ((statusKode === 'selesai_cuci' || statusKode === 'selesai_kering') && mesinLogId) {
    const mesinInfo = await mesinModel.findById(mesinLogId).catch(() => null);
    return mesinInfo ? mesinInfo.kode_mesin : null;
  }
  // Perubahan #33: drop-off 1x cuci+kering -> cucian terakhir tetap di pengering (customer keluarkan sendiri)
  const dropParsial = kategoriList.includes('drop_off') && kategoriList.includes('cuci') && kategoriList.includes('kering') && Number(dropOffQty || 1) < 2;
  if (statusKode === 'siap_diambil' && (!kategoriList.includes('drop_off') || dropParsial)) {
    const adaKering = kategoriList.includes('kering');
    const adaCuci = kategoriList.includes('cuci');
    if (adaKering || adaCuci) {
      const tipeTarget = adaKering ? 'dryer' : 'washer';
      const usageList = await mesinUsageModel.byTransaksi(transaksiId).catch(() => []);
      const match = usageList.filter((u) => u.tipe === tipeTarget).pop(); // pakai yang terakhir
      return match ? match.kode_mesin : null;
    }
  }
  return null;
}

/**
 * Kasir update MANUAL posisi fisik cucian ('mesin' | 'keranjang'). Kasus
 * nyata: cucian udah kelar diproses tapi pelanggan gak kunjung ambil,
 * padahal mesinnya perlu dikosongin buat antrian berikutnya -- kasir
 * keluarin paksa & taruh di keranjang. Tanpa ini, notif WA (& tampilan
 * lokasi) bakal tetap ngomong "masih di mesin X" walau udah dipindah.
 * Balikin detail transaksi + link WA terbaru (pakai status SEKARANG, bukan
 * ganti status) biar kasir bisa langsung kabari pelanggan kalau perlu.
 */
async function setPosisiManual(transaksiId, posisi, ctx) {
  if (posisi !== 'mesin' && posisi !== 'keranjang') {
    throw badRequest('Posisi harus "mesin" atau "keranjang"');
  }
  const { header, kategoriList, dropOffQty } = await konteksTransaksi(transaksiId);
  const TERMINAL_PICKUP = ['sudah_diambil', 'selesai_antar'];
  const curStatus = header.status_terakhir_id ? await statusModel.findById(header.status_terakhir_id) : null;
  const currentKode = curStatus ? curStatus.kode : null;
  if ((header.status_bayar !== 'lunas' && !Number(header.bayar_saat_ambil)) || !currentKode || TERMINAL_PICKUP.includes(currentKode)) {
    throw conflict('Posisi cucian cuma bisa diubah selama transaksi masih berjalan (sudah lunas, belum diambil/diantar).');
  }

  await transaksiModel.setPosisiManual(transaksiId, posisi);

  let waOut = null;
  try {
    const pelanggan = await pelangganModel.findById(header.pelanggan_id);
    const cabang = await cabangModel.findById(header.cabang_id).catch(() => null);
    const keranjang = header.keranjang_id ? await keranjangModel.findById(header.keranjang_id).catch(() => null) : null;
    const kodeKeranjang = keranjang ? keranjang.kode : null;
    const kodeMesin = await resolveKodeMesinNotif(transaksiId, currentKode, kategoriList, null, dropOffQty);
    const pesan = whatsappService.buildMessage(currentKode, {
      nama: pelanggan && pelanggan.nama, noInvoice: header.no_invoice, cabang,
      kodeKeranjang, kodeMesin, kategoriList, dropOffQty, posisiManual: posisi,
      tagihan: (Number(header.bayar_saat_ambil) && header.status_bayar !== 'lunas') ? Number(header.total) : null,
    });
    const link = waLink(pelanggan && pelanggan.telepon, pesan);
    if (link) waOut = { link, terkirim_api: false };
  } catch (e) { logger.error('Gagal siapkan link WA posisi manual', { transaksiId, err: e.message }); }

  const detail = await getDetail(transaksiId);
  if (waOut) detail.wa = waOut;
  return detail;
}

/* ============================================================
   AUTO-COMPLETE DRYER: begitu durasi target tercapai, sistem OTOMATIS
   mindahin status ke "selesai_kering" (yang otomatis juga ngirim IoT OFF
   ke mesin + orkestrasi exaust fan + notif WA -- reuse pindahStatus() apa
   adanya, gak ada logic kedua yang terpisah).
   Ini GANTI mekanisme lama (timer nempel di provider IoT yang cuma matiin
   device doang, status transaksi gak ikut ke-update sampai ada yang klik
   manual -> itu yang bikin dobel trigger: device udah OFF sendiri via
   timer, terus diklik "Selesai" lagi -> device di-pulse ON/OFF ULANG.
   ============================================================ */
const dryerTimers = new Map(); // transaksiId -> Timeout handle (in-memory)

function scheduleDryerAutoComplete(transaksiId, durasiMenit) {
  cancelDryerAutoComplete(transaksiId); // jaga-jaga jangan sampai ke-schedule dobel
  const ms = Math.max(0, Math.round(durasiMenit * 60 * 1000));
  const handle = setTimeout(async () => {
    dryerTimers.delete(transaksiId);
    try {
      await pindahStatus(transaksiId, { status: 'selesai_kering' }, { userId: null, internal: true });
      logger.info('Dryer auto-complete: status "selesai_kering" otomatis ter-update', { transaksiId });
    } catch (e) {
      // Wajar kalau transaksi udah diselesaikan manual duluan (mis. kasir stop lebih
      // awal) -> canMoveTo() bakal nolak, tinggal di-log info, bukan error.
      logger.info('Dryer auto-complete dilewati (kemungkinan sudah selesai duluan)', { transaksiId, err: e.message });
    }
  }, ms);
  handle.unref(); // jangan sampai timer ini nahan proses Node tetap hidup
  dryerTimers.set(transaksiId, handle);
}

function cancelDryerAutoComplete(transaksiId) {
  const handle = dryerTimers.get(transaksiId);
  if (handle) { clearTimeout(handle); dryerTimers.delete(transaksiId); }
}

/* ============================================================
   AUTO-COMPLETE WASHER: sama prinsipnya kayak dryer di atas -- begitu
   durasi target tercapai, otomatis pindah "selesai_cuci". BEDA PENTING:
   mesin cuci (Samsung Autorun) OFF SENDIRI secara fisik lewat siklus
   internal hardware-nya -- sistem TIDAK PERNAH kirim command IoT apa pun
   buat washer (lihat efek.mesinTipe==='dryer' check di atas, cabang
   'dryer' doang yang bikin iotJob). Jadi timer ini murni "nyusul-nyusul"
   pencatatan status doang, bukan yang menggerakkan kenyataan fisik --
   resikonya jauh lebih rendah drpd punya dryer kalau telat/kepotong.
   ============================================================ */
const washerTimers = new Map(); // transaksiId -> Timeout handle (in-memory)

function scheduleWasherAutoComplete(transaksiId, durasiMenit) {
  cancelWasherAutoComplete(transaksiId);
  const ms = Math.max(0, Math.round(durasiMenit * 60 * 1000));
  const handle = setTimeout(async () => {
    washerTimers.delete(transaksiId);
    try {
      await pindahStatus(transaksiId, { status: 'selesai_cuci' }, { userId: null, internal: true });
      logger.info('Washer auto-complete: status "selesai_cuci" otomatis ter-update', { transaksiId });
    } catch (e) {
      logger.info('Washer auto-complete dilewati (kemungkinan sudah selesai duluan)', { transaksiId, err: e.message });
    }
  }, ms);
  handle.unref();
  washerTimers.set(transaksiId, handle);
}

function cancelWasherAutoComplete(transaksiId) {
  const handle = washerTimers.get(transaksiId);
  if (handle) { clearTimeout(handle); washerTimers.delete(transaksiId); }
}

/**
 * Sama seperti recoverDryerTimers() -- dipanggil sekali saat server start, DAN
 * berkala lewat safety-net (lihat mulaiSafetyNetAutoComplete()) buat nutup
 * celah "host sempat sleep/freeze" (lihat komentar panjang di recoverDryerTimers()).
 */
async function recoverWasherTimers(silent = false) {
  const rows = await db.query(
    `SELECT u.transaksi_id, u.waktu_mulai, l.durasi_menit AS durasi_target
     FROM mesin_usage u
     JOIN mesin m ON m.id = u.mesin_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE m.tipe = 'washer' AND u.waktu_selesai IS NULL`
  );
  let jml = 0;
  let jmlOverdue = 0;
  for (const r of rows) {
    if (!r.durasi_target) continue;
    const elapsedMs = Date.now() - new Date(String(r.waktu_mulai).replace(' ', 'T') + '+07:00').getTime();
    const sisaMenit = r.durasi_target - elapsedMs / 60000;
    if (sisaMenit <= 0) {
      jmlOverdue += 1;
      if (silent) {
        logger.info('Safety-net: washer overdue, auto-complete dipaksa jalan sekarang', { transaksiId: r.transaksi_id, telatMenit: Math.round(-sisaMenit) });
      }
      pindahStatus(r.transaksi_id, { status: 'selesai_cuci' }, { userId: null, internal: true })
        .catch((e) => logger.info('Washer recovery auto-complete dilewati', { transaksiId: r.transaksi_id, err: e.message }));
    } else {
      scheduleWasherAutoComplete(r.transaksi_id, sisaMenit);
    }
    jml += 1;
  }
  if (jml > 0 && (!silent || jmlOverdue)) logger.info(`Washer timer recovery: ${jml} sesi cuci aktif di-jadwalkan ulang${silent ? ` (${jmlOverdue} overdue)` : ''}`);
  return jml;
}

/**
 * Safety-net: panggil ulang recoverDryerTimers()/recoverWasherTimers() secara
 * BERKALA (bukan cuma sekali pas server start). Ini nutup celah kasus nyata
 * yang kejadian: timer di-memory gak nembak tepat waktu karena host (laptop
 * testing lokal) sempat sleep/freeze beberapa menit -- BUKAN karena server
 * restart (recovery versi startup gak ke-trigger di kasus itu). Aman dipanggil
 * berkali-kali: kalau semua sesi masih dalam target, cuma reschedule ulang
 * timernya (no-op secara efek); kalau ada yang udah lewat target, langsung
 * diselesaikan saat itu juga tanpa perlu nunggu setTimeout aslinya nembak.
 */
function mulaiSafetyNetAutoComplete(intervalMs = 2 * 60 * 1000) {
  const handle = setInterval(() => {
    Promise.all([recoverDryerTimers(true), recoverWasherTimers(true)])
      .catch((e) => logger.error('Safety-net auto-complete gagal jalan', { err: e.message }));
  }, intervalMs);
  handle.unref(); // jangan sampai interval ini nahan proses Node tetap hidup
  return handle;
}

/**
 * Restart proses (kasir): mesin sudah tercatat "jalan" untuk transaksi ini,
 * tapi fisiknya gagal trigger. Wewenang ini SENGAJA hanya untuk mesin yang
 * BENERAN sedang jalan (bukan idle/maintenance) -- mencegah potensi fraud.
 *
 * Efek: alasan wajib (audit) -> tutup sesi lama TANPA nambah cycle -> buka
 * sesi baru (waktu_mulai = sekarang) -> kirim ulang command IoT -> reschedule
 * timer auto-complete FULL dari awal (bukan sisa) sesuai tipe mesin (dryer:
 * kirim IoT off + reschedule; washer: TIDAK kirim IoT apa pun, cuma reschedule
 * status -- mesin OFF sendiri secara fisik).
 */
// Urutan perintah IoT per jenis restart dari popup mesin kasir (Perubahan #1):
//  - washer 'mesin_on'  : mesin masih nyala (pintu dC / keran 4C) -> OFF, ON, Start
//  - washer 'mesin_off' : mesin mati (belum dicolok, sudah dicolok) -> ON, Start
//  - dryer  'start'     : pintu lupa ditutup / dibuka di tengah -> Start (durasi dari awal)
// `on_off` = pulse tombol power (toggle), `start_pause` = pulse tombol start.
const JEDA_OFF_KE_ON_MS = 3000;
const JEDA_ON_KE_START_MS = 1500;
const JEDA_DRYER_ON_KE_START_MS = 3000; // Perubahan #21/#25
const URUTAN_RESTART = {
  mesin_on: [['on_off', JEDA_OFF_KE_ON_MS], ['on_off', JEDA_ON_KE_START_MS], ['start_pause', 0]],
  mesin_off: [['on_off', JEDA_ON_KE_START_MS], ['start_pause', 0]],
  start: [['start_pause', 0]],
};
const LABEL_MODE_RESTART = {
  mesin_on: 'Restart (Mesin ON): OFF -> ON -> Start',
  mesin_off: 'Restart (Mesin OFF): ON -> Start',
  onoff: 'On/Off (tombol power)',
  start: 'Start ulang (durasi dari awal)',
};

/** Kirim urutan command IoT satu per satu (jeda antar command), tiap langkah dicatat ke iot_log. */
async function kirimUrutanIot(mesin, urutan, transaksiId) {
  for (const [cmd, jedaMs] of urutan) {
    try {
      await iotService.trigger(mesin, cmd);
      await iotLogModel.create({ mesinId: mesin.id, commandKey: cmd, sukses: true, transaksiId }).catch(() => {});
    } catch (e) {
      logger.error('Restart: command IoT gagal', { transaksiId, mesinId: mesin.id, cmd, err: e.message });
      await iotLogModel.create({ mesinId: mesin.id, commandKey: cmd, sukses: false, pesanError: e.message, transaksiId }).catch(() => {});
    }
    if (jedaMs) await new Promise((r) => setTimeout(r, jedaMs));
  }
}

/** Info antrian mesin terkunci untuk pesan WA (null kalau tidak antre / mode manual). */
async function infoAntrianWa(cabangId, transaksiId, hanyaTipe = null) {
  for (const tipe of (hanyaTipe ? [hanyaTipe] : ['washer', 'dryer'])) {
    const info = await antrianService.infoTransaksi(cabangId, transaksiId, tipe).catch(() => null);
    if (info) return { ...info, jenis: tipe === 'dryer' ? 'mesin pengering' : 'mesin cuci' };
  }
  return null;
}

async function restartProses(transaksiId, { alasan, karyawanId, mode = null }) {
  if (mode && !URUTAN_RESTART[mode]) throw badRequest('Mode restart tidak dikenal');
  if (!alasan || !alasan.trim()) throw badRequest('Alasan restart wajib diisi');

  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');

  const usageList = await mesinUsageModel.byTransaksi(transaksiId);
  const jalan = usageList.find((u) => !u.waktu_selesai);
  if (!jalan) throw conflict('Tidak ada mesin yang sedang berjalan untuk transaksi ini');

  const tipe = jalan.tipe;
  const durasiTarget = jalan.durasi_target;
  if (mode === 'start' && tipe !== 'dryer') throw badRequest('Start ulang hanya untuk mesin kering');
  // Perubahan #25: pengering boleh 'mesin_off' (mesin mati: ON -> Start)
  if (mode === 'mesin_on' && tipe !== 'washer') throw badRequest('Mode ini hanya untuk mesin cuci');
  const waktu = now();

  // cancel timer lama dulu, biar gak nembak duluan di tengah proses restart
  if (tipe === 'dryer') cancelDryerAutoComplete(transaksiId);
  if (tipe === 'washer') cancelWasherAutoComplete(transaksiId);

  const mesin = await db.transaction(async (conn) => {
    const m = await mesinService.restart(conn, {
      transaksiId, mesinId: jalan.mesin_id, detailTransaksiId: jalan.detail_transaksi_id, waktu,
    });
    await mesinLogManualModel.create({
      mesinId: jalan.mesin_id, jenisAksi: 'restart_proses', transaksiId, command: mode ? `restart_${mode}` : null,
      alasan: alasan.trim(), karyawanId, cabangId: header.cabang_id,
    }, conn);
    return m;
  });

  // kirim ulang command IoT (nyalakan fisik lagi) -- reuse commandKey yang sama
  // kayak pas mulai pertama kali
  if (mode) {
    // pengering mati: ON lalu tunggu 3 dtk (board pengering butuh waktu nyala) baru Start
    const urutan = (tipe === 'dryer' && mode === 'mesin_off') ? [['on_off', JEDA_DRYER_ON_KE_START_MS], ['start_pause', 0]] : URUTAN_RESTART[mode];
    await kirimUrutanIot(mesin, urutan, transaksiId);
  } else {
    const commandKey = tipe === 'washer' ? 'Autorun' : `dry${durasiTarget}`;
    try {
      await iotService.trigger(mesin, commandKey);
    } catch (e) {
      logger.error('Restart proses: trigger IoT gagal', { transaksiId, mesinId: jalan.mesin_id, err: e.message });
    }
  }

  // reschedule auto-complete FULL dari waktu restart (bukan sisa)
  if (durasiTarget) {
    if (tipe === 'dryer') scheduleDryerAutoComplete(transaksiId, durasiTarget);
    else scheduleWasherAutoComplete(transaksiId, durasiTarget);
  }

  // estimasi antrian di belakangnya ikut bergeser (dihitung live, cukup sinkron)
  await antrianService.refresh(header.cabang_id);
  return { mesin_id: jalan.mesin_id, kode_mesin: jalan.kode_mesin, tipe, waktu_mulai_baru: waktu, mode, label: mode ? LABEL_MODE_RESTART[mode] : null };
}

/**
 * Resume mesin KERING (kasir): pintu sempat dibuka di tengah proses lalu
 * ditutup lagi -> mesin pause. Kirim Start saja, timer & sesi TIDAK diubah
 * (durasi lanjut). Tanpa alasan, tetap dicatat di log.
 */
async function resumeKering(transaksiId, { karyawanId }) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  const usageList = await mesinUsageModel.byTransaksi(transaksiId);
  const jalan = usageList.find((u) => !u.waktu_selesai);
  if (!jalan) throw conflict('Tidak ada mesin yang sedang berjalan untuk transaksi ini');
  if (jalan.tipe !== 'dryer') throw badRequest('Resume hanya untuk mesin kering');
  const mesin = await mesinModel.findById(jalan.mesin_id);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  await mesinLogManualModel.create({
    mesinId: jalan.mesin_id, jenisAksi: 'resume_kering', transaksiId, command: 'start_pause',
    alasan: 'Resume (lanjut, durasi tidak berubah)', karyawanId, cabangId: header.cabang_id,
  });
  await kirimUrutanIot(mesin, [['start_pause', 0]], transaksiId);
  return { mesin_id: jalan.mesin_id, kode_mesin: jalan.kode_mesin, tipe: jalan.tipe };
}

/**
 * Perubahan #11: tombol [Selesai Cuci] di popup mesin kasir (cuci bisa lebih
 * cepat dari durasi). Aktif mulai menit ke-30 berjalan (atau durasi target bila
 * < 30). Tanpa alasan; tercatat di log status (karyawan + keterangan).
 * Efek sama dengan auto-complete: status selesai_cuci, timer dibatalkan,
 * antrian maju, order ber-kering lanjut ke antrian pengering.
 */
const GATE_SELESAI_CUCI_POPUP_MENIT = 30;
async function selesaiCuciPopup(transaksiId, { karyawanId }) {
  const usageList = await mesinUsageModel.byTransaksi(transaksiId);
  const jalan = usageList.find((u) => u.tipe === 'washer' && !u.waktu_selesai);
  if (!jalan) throw conflict('Tidak ada mesin cuci yang sedang berjalan untuk transaksi ini');
  const target = await db.queryOne(
    `SELECT l.durasi_menit FROM detail_transaksi dt JOIN layanan l ON l.id = dt.layanan_id WHERE dt.id = ?`,
    [jalan.detail_transaksi_id]
  );
  const durasi = Number(target && target.durasi_menit) || GATE_SELESAI_CUCI_POPUP_MENIT;
  const gate = Math.min(GATE_SELESAI_CUCI_POPUP_MENIT, durasi);
  const elapsed = (Date.now() - new Date(String(jalan.waktu_mulai).replace(' ', 'T') + '+07:00').getTime()) / 60000;
  if (elapsed < gate) {
    throw conflict(`Selesai Cuci aktif di menit ke-${gate}, tunggu ${Math.ceil(gate - elapsed)} menit lagi.`);
  }
  return pindahStatus(transaksiId, { status: 'selesai_cuci', keterangan: 'Selesai cuci manual dari popup mesin (kasir)' }, { userId: karyawanId });
}

/**
 * Perubahan #21: tombol [On/Off] popup mesin kasir -- pulse tombol power mesin
 * yang sedang dipakai transaksi ini. Tanpa alasan (keputusan user), timer &
 * status tidak berubah; tetap dicatat di log mesin.
 */
async function onOffMesin(transaksiId, { karyawanId }) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  const usageList = await mesinUsageModel.byTransaksi(transaksiId);
  const jalan = usageList.find((u) => !u.waktu_selesai);
  if (!jalan) throw conflict('Tidak ada mesin yang sedang berjalan untuk transaksi ini');
  const mesin = await mesinModel.findById(jalan.mesin_id);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  await mesinLogManualModel.create({
    mesinId: jalan.mesin_id, jenisAksi: 'trigger_manual', transaksiId, command: 'on_off',
    alasan: 'On/Off dari popup mesin kasir', karyawanId, cabangId: header.cabang_id,
  });
  await kirimUrutanIot(mesin, [['on_off', 0]], transaksiId);
  return { mesin_id: jalan.mesin_id, kode_mesin: jalan.kode_mesin, tipe: jalan.tipe };
}

/** Batalkan timer auto-complete 1 transaksi (dipakai antrian saat mesin rusak). */
function _cancelTimer(transaksiId, tipe) {
  if (tipe === 'dryer') cancelDryerAutoComplete(transaksiId);
  else cancelWasherAutoComplete(transaksiId);
}

const LABEL_START_ALARM = {
  // 4C/4E (Samsung): keran air suplai belum dibuka -- mesin TETAP nyala/standby,
  // siklus cuma pause nunggu air. Fix-nya buka keran, lalu cukup pulse tombol
  // Start lagi (SW2 washer) -- JANGAN full restart (SW1+SW2), soalnya SW1 itu
  // toggle: mesin yang masih nyala kalau di-pulse SW1 lagi malah bakal OFF.
  '4c_4e': 'Start ulang setelah alarm 4C/4E (keran air belum dibuka)',
  // dC/dE (Samsung): pintu belum tertutup rapat -- sama, mesin tetap nyala/standby.
  'dc_de': 'Start ulang setelah alarm dC/dE (pintu belum tertutup)',
};

/**
 * "Lanjut Start" (kasir) untuk 2 alarm Samsung yang TIDAK mematikan mesin
 * (4C/4E = keran air, dC/dE = pintu) -- beda dari restartProses() di atas yang
 * untuk mesin yang BENERAN mati/gagal trigger dari awal. Di sini mesin dianggap
 * masih dalam siklus yang sama (TIDAK tutup/buka mesin_usage baru, TIDAK
 * reschedule timer auto-complete) -- cuma kirim ulang pulse tombol Start
 * (SW2/SW4) biar mesin lanjut jalan setelah kendala fisiknya dibenarkan kasir.
 */
async function startSetelahAlarm(transaksiId, { jenis, karyawanId }) {
  if (!LABEL_START_ALARM[jenis]) throw badRequest('Jenis alarm tidak dikenal');

  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');

  const usageList = await mesinUsageModel.byTransaksi(transaksiId);
  const jalan = usageList.find((u) => !u.waktu_selesai);
  if (!jalan) throw conflict('Tidak ada mesin yang sedang berjalan untuk transaksi ini');

  const mesin = await mesinModel.findById(jalan.mesin_id);
  if (!mesin) throw notFound('Mesin tidak ditemukan');

  try {
    await iotService.trigger(mesin, 'start_pause'); // pulse SW2/SW4 doang, bukan full restart
  } catch (e) {
    logger.error('Start setelah alarm: trigger IoT gagal', { transaksiId, mesinId: jalan.mesin_id, jenis, err: e.message });
  }

  await mesinLogManualModel.create({
    mesinId: jalan.mesin_id, jenisAksi: 'start_alarm', transaksiId, command: 'start_pause',
    alasan: LABEL_START_ALARM[jenis], karyawanId, cabangId: header.cabang_id,
  });

  return { mesin_id: jalan.mesin_id, kode_mesin: jalan.kode_mesin, tipe: jalan.tipe };
}

/**
 * Daftar antrian: transaksi yang SUDAH BAYAR tapi item cuci/kering-nya BELUM
 * dapat mesin. Urut FIFO (tanggal bayar paling lama duluan). Dipakai buat
 * UI kasir (daftar antrian & manuver manual) dan cascade auto-assign di bawah.
 */
async function daftarAntrian(cabangId, tipe) {
  // Sumber kebenaran sekarang antrian terkunci per mesin.
  return antrianService.daftar(cabangId, tipe);
}

/**
 * Cascade: dipanggil tiap kali 1 mesin baru bebas (closeUsage). Kalau cabang
 * ini mode 'otomatis' DAN ada antrian utk tipe itu, coba alokasikan otomatis
 * ke yang PALING DEPAN antrian -- reuse pindahStatus() apa adanya (termasuk
 * pilihOtomatis() & lock anti-race-nya), bukan logic terpisah.
 * Kalau gagal (mis. ternyata mesin barusan kesambar transaksi lain / manuver
 * kasir bersamaan), cukup di-log info -- BUKAN error keras, ini proses
 * best-effort di background, bukan permintaan eksplisit pengguna.
 */
async function cobaAlokasikanAntrian(cabangId) {
  await antrianService.refresh(cabangId);
}

/**
 * Dipanggil SEKALI saat server baru nyala (lihat server.js) -- cari dryer yang
 * masih jalan (belum "selesai_kering") dan pasang ulang timernya berdasarkan
 * sisa waktu, biar auto-complete TETAP jalan meski server sempat di-restart
 * di tengah siklus kering (timer lama di-memory otomatis hilang saat restart).
 *
 * JUGA dipanggil BERKALA (lihat mulaiSafetyNetAutoComplete() di bawah) sebagai
 * "safety net" -- bukan cuma pas restart. Kenapa perlu: setTimeout() di-memory
 * murni ngikutin jam sistem host. Kalau host-nya sempat sleep/freeze (umum
 * banget kejadian pas testing lokal di laptop -- lid ketutup, macbook sleep),
 * timer ikut "dibekukan" selama itu dan baru nembak telat pas laptop nyala
 * lagi. Restart TIDAK terjadi di kasus ini jadi recoverDryerTimers() versi
 * "sekali pas start" gak ke-trigger -- makanya perlu dipanggil ulang berkala
 * juga, supaya begitu proses balik aktif, sesi yang udah lewat target durasi
 * langsung ke-deteksi & diselesaikan sendiri tanpa nunggu setTimeout aslinya.
 * @param {boolean} [silent] true kalau dipanggil dari safety-net berkala --
 *   cuma log kalau BENERAN nemu sesi yang overdue (biar log gak spam tiap
 *   interval untuk sesi yang emang lagi jalan normal).
 */
async function recoverDryerTimers(silent = false) {
  const rows = await db.query(
    `SELECT u.transaksi_id, u.waktu_mulai, l.durasi_menit AS durasi_target
     FROM mesin_usage u
     JOIN mesin m ON m.id = u.mesin_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE m.tipe = 'dryer' AND u.waktu_selesai IS NULL`
  );
  let jml = 0;
  let jmlOverdue = 0;
  for (const r of rows) {
    if (!r.durasi_target) continue; // gak ada target durasi -> gak bisa dijadwalkan
    const elapsedMs = Date.now() - new Date(String(r.waktu_mulai).replace(' ', 'T') + '+07:00').getTime();
    const sisaMenit = r.durasi_target - elapsedMs / 60000;
    if (sisaMenit <= 0) {
      // Target udah lewat (server mati, ATAU host sempat sleep/freeze) -> proses sekarang juga
      jmlOverdue += 1;
      if (silent) {
        logger.info('Safety-net: dryer overdue, auto-complete dipaksa jalan sekarang', { transaksiId: r.transaksi_id, telatMenit: Math.round(-sisaMenit) });
      }
      pindahStatus(r.transaksi_id, { status: 'selesai_kering' }, { userId: null, internal: true })
        .catch((e) => logger.info('Dryer recovery auto-complete dilewati', { transaksiId: r.transaksi_id, err: e.message }));
    } else {
      scheduleDryerAutoComplete(r.transaksi_id, sisaMenit);
    }
    jml += 1;
  }
  // Log ringkasan startup TETAP jalan seperti biasa (silent=false, dari server.js).
  // Buat panggilan berkala (silent=true) -- log "N di-jadwalkan ulang" cuma nambah
  // noise tiap 2 menit (wajar ada beberapa sesi aktif terus-terusan), jadi cuma
  // dilaporkan kalau BENERAN nemu yang overdue (sudah di-log di atas per-transaksi).
  if (jml && (!silent || jmlOverdue)) logger.info(`Dryer timer recovery: ${jml} sesi kering aktif di-jadwalkan ulang${silent ? ` (${jmlOverdue} overdue)` : ''}`);
}

/**
 * Pindah status transaksi (maju ke tahap berikutnya) + jalankan efeknya.
 * @param {number} transaksiId
 * @param {object} input { status? (target kode, default next), mesin_id?, keterangan? }
 * @param {object} ctx   { userId }
 */
/** Perubahan #26: siklus bawaan mesin pengering (mesin mati sendiri) -- paket >= ini tidak di-off. */
const DRYER_SIKLUS_BAWAAN_MENIT = Number(process.env.DRYER_SIKLUS_BAWAAN_MENIT) || 45;

async function pindahStatus(transaksiId, input, ctx) {
  const { header, jasa, kategoriList, dropOffQty } = await konteksTransaksi(transaksiId);

  const curStatus = header.status_terakhir_id
    ? await statusModel.findById(header.status_terakhir_id) : null;
  const currentKode = curStatus ? curStatus.kode : null;

  const target = input.status || nextStatus(currentKode, kategoriList);
  if (!target) throw badRequest('Transaksi sudah di tahap akhir');
  // Perubahan #49: pesanan yang ditahan owner tidak bisa diproses sampai hold dilepas
  if (Number(header.ditahan)) throw conflict('Pesanan sedang DITAHAN owner. Lepas hold dulu untuk memproses.');

  // Perubahan #13: pembayaran hanya lewat bayar() / prosesBayarSaatAmbil();
  // order belum bayar (bukan bayar-saat-ambil) tidak bisa diproses; cucian
  // bayar-saat-ambil tidak bisa diserahkan sebelum lunas.
  if (header.status_bayar !== 'lunas') {
    if (target === 'sudah_bayar' || !Number(header.bayar_saat_ambil)) {
      throw conflict('Pesanan belum dibayar. Terima pembayaran dulu (atau pilih Proses, Bayar Saat Ambil).');
    }
    if (['sudah_diambil', 'selesai_antar'].includes(target)) {
      throw conflict('Pesanan bayar saat ambil belum dibayar. Terima pembayaran dulu sebelum cucian diserahkan.');
    }
  }

  const cek = canMoveTo(currentKode, target, kategoriList);
  if (!cek.ok) throw conflict(cek.reason);

  // Perubahan #27: "Selesai Antar" dikunci untuk kasir yang klik "Proses Antar"
  // (benefit antar 80% jatuh ke dia). Manager/owner boleh menyelesaikan.
  if (target === 'selesai_antar' && !ctx.internal && !['manager', 'owner'].includes(ctx.role)) {
    const pengantar = await db.queryOne(
      `SELECT l.karyawan_id, k.nama FROM transaksi_status_log l
         JOIN status_master s ON s.id = l.status_id
         LEFT JOIN karyawan k ON k.id = l.karyawan_id
        WHERE l.transaksi_id = ? AND s.kode = 'proses_antar'
        ORDER BY l.waktu DESC, l.id DESC LIMIT 1`, [transaksiId]);
    if (pengantar && pengantar.karyawan_id && Number(pengantar.karyawan_id) !== Number(ctx.userId)) {
      throw forbidden(`Selesai Antar hanya bisa oleh ${pengantar.nama || 'kasir'} yang memproses antar.`);
    }
  }

  // "Selesai Kering": TIDAK ADA jalur manual sama sekali (kasir MAUPUN
  // customer) -- durasi dryer sudah pasti & dikontrol sistem sejak awal,
  // transisi ini MURNI lewat auto-complete timer (ctx.internal).
  if (target === 'selesai_kering' && !ctx.internal) {
    throw conflict('Tahap ini otomatis selesai sendiri sesuai durasi yang dipilih, tidak bisa diselesaikan manual.');
  }

  // "Selesai Cuci": gate 30 menit -- berlaku sama untuk kasir MAUPUN customer
  // (siklus bilas mesin cuci baru mulai di menit ke-30; auto-complete timer
  // internal TIDAK kena gate ini, karena waktunya sudah pasti dijadwalkan
  // sesuai durasi_target, bukan diklik manual sebelum waktunya).
  if (target === 'selesai_cuci' && !ctx.internal) {
    const usageList = await mesinUsageModel.byTransaksi(transaksiId);
    const jalanWasher = usageList.find((u) => u.tipe === 'washer' && !u.waktu_selesai);
    if (jalanWasher) {
      const elapsedMenit = (Date.now() - new Date(String(jalanWasher.waktu_mulai).replace(' ', 'T') + '+07:00').getTime()) / 60000;
      if (elapsedMenit < GATE_SELESAI_CUCI_MENIT) {
        const sisaMenit = Math.ceil(GATE_SELESAI_CUCI_MENIT - elapsedMenit);
        throw conflict(`Belum bisa diselesaikan, tunggu ${sisaMenit} menit lagi (proses bilas).`);
      }
    }
  }

  const targetRow = await statusModel.findByKode(target);
  if (!targetRow) throw badRequest(`Status "${target}" tidak ada di status_master`);
  const efek = efekOf(target);
  const waktu = now();

  // cari detail jasa untuk tipe mesin (washer->cuci, dryer->kering)
  const detailForTipe = (tipe) => jasa.find((d) => d._kategori === TIPE_KE_KATEGORI[tipe]);

  let iotJob = null;     // { mesin, commandKey } -> dipicu setelah commit
  let exhaustFanJob = null; // { mesin, commandKey: 'on'|'off' } -> orkestrasi exaust fan ikut dryer
  let kirimWa = false;
  let mesinLogId = input.mesin_id || null;
  let cascadeMesinBebas = null; // { cabangId, tipe } -- diisi kalau closeUsage kejadian, dipakai buat cascade antrian setelah commit

  // Mode pemilihan mesin cabang ini -- dicek SEKALI di luar transaksi (ini
  // pengaturan, bukan sesuatu yang perlu row-lock/transactional).
  const cabangRowForAlokasi = efek.allocMesin ? await cabangModel.findById(header.cabang_id) : null;
  const modePemilihan = cabangRowForAlokasi ? cabangRowForAlokasi.pemilihan_mesin : 'manual';

  // Mode 'otomatis' + tanpa mesin pilihan kasir: alokasi HANYA lewat antrian
  // terkunci (mesin yang dijanjikan). Sinkronkan antrian dulu -- kalau mesin
  // janjinya bebas & order ini kepala antrian, refresh() langsung
  // mengalokasikannya; kalau belum, order tetap antre (bukan error aplikasi).
  if (efek.allocMesin && !input.mesin_id && modePemilihan === 'otomatis') {
    await antrianService.refresh(header.cabang_id);
    const sesudah = await transaksiModel.findById(transaksiId);
    if (Number(sesudah.status_terakhir_id) === Number(targetRow.id)) return getDetail(transaksiId);
    throw conflict('Mesin yang dijanjikan belum kosong, transaksi tetap di antrian.', { antrian: true });
  }

  await db.transaction(async (conn) => {
    // Perubahan #23: kunci baris transaksi & pastikan status belum berubah
    // sejak dibaca (timer/safety-net bisa jalan bersamaan di beberapa proses
    // Node). Kalau sudah dipindah pemanggil lain -> batal tanpa efek apa pun
    // (tanpa log, tanpa cycle, tanpa perintah IoT).
    const [kunciRows] = await conn.execute('SELECT status_terakhir_id FROM transaksi WHERE id = ? FOR UPDATE', [transaksiId]);
    const statusSekarang = kunciRows[0] ? kunciRows[0].status_terakhir_id : null;
    if (Number(statusSekarang || 0) !== Number(header.status_terakhir_id || 0)) {
      throw conflict('Status pesanan sudah berubah (diproses bersamaan), muat ulang.');
    }
    // alokasi mesin: manual (kasir pilih sendiri, ATAU kasir manuver override
    // walau cabang mode='otomatis') vs otomatis (sistem yang pilih sesuai
    // rules -- lihat mesinService.pilihOtomatis).
    if (efek.allocMesin) {
      const det = detailForTipe(efek.allocMesin);
      if (!det) throw badRequest('Item layanan untuk mesin ini tidak ditemukan');

      if (input.mesin_id) {
        // staff pilih manual -- berlaku di mode manual, ATAU sebagai manuver
        // kasir di mode otomatis (katup pengaman kalau kondisi fisik meleset
        // dari prediksi sistem).
        await mesinService.alokasi(conn, { transaksi: header, detail: det, mesinId: input.mesin_id, tipe: efek.allocMesin });
      } else if (modePemilihan === 'otomatis_lama_tidak_dipakai') {
        // (jalur lama pilihOtomatis -- digantikan antrian terkunci di atas)
        let kodeMesinAsal = null;
        if (efek.allocMesin === 'dryer') {
          const detCuci = detailForTipe('washer');
          if (detCuci && detCuci.mesin_id) {
            const mesinAsal = await mesinModel.findById(detCuci.mesin_id);
            kodeMesinAsal = mesinAsal ? mesinAsal.kode_mesin : null;
          }
        }
        const dipilih = await mesinService.pilihOtomatis(conn, {
          cabangId: header.cabang_id, tipe: efek.allocMesin, beratKg: header.berat_kg, kodeMesinAsal,
        });
        if (!dipilih) {
          // Semua mesin penuh -> transaksi TETAP di status sekarang (sudah_bayar),
          // ini YANG MENDEFINISIKAN "masuk antrian" (lihat daftarAntrian()).
          // Bukan error aplikasi biasa -- caller (FE) harus render ini sebagai
          // status antre, bukan gagal.
          const e = conflict('Semua mesin sedang penuh, transaksi masuk antrian.', { antrian: true });
          throw e;
        }
        mesinLogId = dipilih.id;
        await detailModel.setMesin(conn, det.id, dipilih.id);
      } else {
        throw badRequest('Pilih mesin terlebih dahulu');
      }
    }

    // mulai: buka usage + mesin jalan; siapkan command IoT
    if (efek.openUsage) {
      const det = detailForTipe(efek.mesinTipe);
      const mesinId = det && det.mesin_id;
      if (!mesinId) throw badRequest('Mesin belum dialokasikan untuk transaksi ini');
      const mesin = await mesinService.mulai(conn, { transaksi: header, detail: det, mesinId, waktu });
      mesinLogId = mesinId;
      const commandKey = efek.mesinTipe === 'washer' ? 'Autorun' : `dry${det._durasi}`;
      if (efek.iotStart) iotJob = { mesin, commandKey };

      // Washer: jadwalkan auto-complete (HANYA ubah status, TIDAK kirim IoT --
      // mesin OFF sendiri secara fisik lewat siklus internalnya).
      if (efek.mesinTipe === 'washer' && det._durasi) {
        scheduleWasherAutoComplete(transaksiId, det._durasi);
      }

      // Exaust fan: nyala begitu ada dryer PERTAMA yang mulai jalan di cabang ini.
      // Kalau sebelumnya udah ada dryer lain yang jalan, fan-nya udah nyala -> skip.
      if (efek.mesinTipe === 'dryer') {
        const jmlDryerJalan = await mesinUsageModel.countAktifByTipe(header.cabang_id, 'dryer', conn);
        if (jmlDryerJalan === 1) {
          const exaustFanList = await mesinModel.findByCabang(header.cabang_id, { tipe: 'exaust_fan' });
          if (exaustFanList[0]) exhaustFanJob = { mesin: exaustFanList[0], commandKey: 'on' };
        }
        // Jadwalkan auto-complete: begitu durasi target tercapai, status otomatis
        // pindah ke "selesai_kering" sendiri (lihat scheduleDryerAutoComplete di atas).
        if (det._durasi) scheduleDryerAutoComplete(transaksiId, det._durasi);
      }
    }

    // selesai: tutup usage + cycle + mesin aktif
    // Untuk dryer dengan Tuya: kirim SW1 pulse (power OFF) setelah commit
    if (efek.closeUsage) {
      const det = detailForTipe(efek.mesinTipe);
      const mesinId = det && det.mesin_id;
      if (mesinId) {
        const mesinSelesai = await mesinService.selesai(conn, { transaksi: header, mesinId, waktu });
        mesinLogId = mesinId;
        cascadeMesinBebas = { cabangId: header.cabang_id, tipe: efek.mesinTipe }; // trigger cascade antrian setelah commit
        // Dryer Tuya: trigger power OFF setelah selesai
        // Perubahan #26: paket >= 45 menit TIDAK dimatikan -- siklus bawaan
        // pengering 45 menit, mesin mati sendiri; pulse tombol power malah
        // menyalakannya lagi (toggle) -> start berikutnya gagal.
        const durasiKeringIni = Number(det._durasi) || 0;
        if (efek.mesinTipe === 'dryer' && mesinSelesai && mesinSelesai.tuya_device_id
            && !(durasiKeringIni >= DRYER_SIKLUS_BAWAAN_MENIT)) {
          iotJob = { mesin: mesinSelesai, commandKey: 'selesai' };
        }
        // Usage udah ditutup (baik lewat auto-complete timer atau manual/early-stop
        // oleh kasir) -> pastikan gak ada timer nyisa yang bakal nembak lagi belakangan.
        if (efek.mesinTipe === 'dryer') cancelDryerAutoComplete(transaksiId);
        if (efek.mesinTipe === 'washer') cancelWasherAutoComplete(transaksiId);

        // Exaust fan: matikan begitu SEMUA dryer di cabang ini udah berhenti.
        // Kalau masih ada dryer lain yang jalan, fan tetap nyala -> skip.
        if (efek.mesinTipe === 'dryer') {
          const jmlDryerJalan = await mesinUsageModel.countAktifByTipe(header.cabang_id, 'dryer', conn);
          if (jmlDryerJalan === 0) {
            const exaustFanList = await mesinModel.findByCabang(header.cabang_id, { tipe: 'exaust_fan' });
            if (exaustFanList[0]) exhaustFanJob = { mesin: exaustFanList[0], commandKey: 'off' };
          }
        }
      }
    }

    // bebaskan keranjang
    if (efek.bebaskanKeranjang && header.keranjang_id) {
      const n = await keranjangService.bebaskan(header.keranjang_id, conn, transaksiId);
      if (!n) logger.warn('Keranjang tidak dibebaskan: tercatat dipakai order lain', { transaksiId, keranjangId: header.keranjang_id });
    }

    // update status + log
    await transaksiModel.setStatus(conn, transaksiId, targetRow.id);
    await statusLogModel.create({
      transaksi_id: transaksiId,
      status_id: targetRow.id,
      karyawan_id: ctx.userId,
      mesin_id: mesinLogId,
      waktu,
      keterangan: input.keterangan || null,
    }, conn);

    if (efek.waNotif) kirimWa = true;
  });

  // ---- Cascade antrian: mesin baru bebas -> coba alokasikan otomatis ke
  // antrian terdepan (kalau cabang ini mode 'otomatis'). Dijalankan SETELAH
  // commit (bukan di dalam transaksi yang sama) -- ini transaksi LAIN punya
  // proses pindahStatus sendiri, biar konsisten reuse logic yang sama persis
  // (termasuk lock anti-race di pilihOtomatis).
  // Antrian terkunci: SETIAP perpindahan status bisa mengubah antrian (mesin
  // bebas, order masuk antrian pengering setelah selesai cuci, dst) ->
  // sinkron + alokasikan kepala antrian mesin yang bebas (no-op mode manual).
  void cascadeMesinBebas;
  await antrianService.refresh(header.cabang_id);

  // ---- efek samping eksternal SETELAH commit (tidak menggagalkan status) ----
  // Setiap percobaan (berhasil ATAU gagal) dicatat ke tabel iot_log -- bisa
  // didiagnosis lewat query DB langsung, gak perlu akses file log server.
  if (iotJob) {
    try {
      await iotService.trigger(iotJob.mesin, iotJob.commandKey);
      await iotLogModel.create({ mesinId: iotJob.mesin.id, commandKey: iotJob.commandKey, sukses: true, transaksiId }).catch(() => {});
    } catch (e) {
      logger.error('IoT trigger gagal', { transaksiId, err: e.message });
      await iotLogModel.create({ mesinId: iotJob.mesin.id, commandKey: iotJob.commandKey, sukses: false, pesanError: e.message, transaksiId }).catch(() => {});
    }
  }
  if (exhaustFanJob) {
    try {
      // Kesimpulan ON/OFF udah diputusin dari DB (hitungan dryer aktif, lihat
      // di atas) -- sebelum beneran kirim command, cek dulu status REAL fan
      // ke Tuya. Kalau udah di posisi yang sama, skip (gak perlu trigger
      // ulang). Kalau gagal cek (null/unknown), tetap lanjut trigger (fail-safe).
      const targetOn = exhaustFanJob.commandKey === 'on';
      const sudahSesuai = exhaustFanJob.mesin.tuya_device_id
        ? await iotService.statusFanSudahSesuai(exhaustFanJob.mesin.tuya_device_id, targetOn)
        : null;
      if (sudahSesuai === true) {
        logger.info('Exaust fan: status real sudah sesuai kesimpulan DB, skip trigger', {
          transaksiId, mesinId: exhaustFanJob.mesin.id, commandKey: exhaustFanJob.commandKey,
        });
      } else {
        await iotService.trigger(exhaustFanJob.mesin, exhaustFanJob.commandKey);
        await iotLogModel.create({ mesinId: exhaustFanJob.mesin.id, commandKey: exhaustFanJob.commandKey, sukses: true, transaksiId }).catch(() => {});
      }
    } catch (e) {
      logger.error('IoT trigger exaust fan gagal', { transaksiId, err: e.message });
      await iotLogModel.create({ mesinId: exhaustFanJob.mesin.id, commandKey: exhaustFanJob.commandKey, sukses: false, pesanError: e.message, transaksiId }).catch(() => {});
    }
  }
  let waOut = null;
  if (kirimWa) {
    try {
      const pelanggan = await pelangganModel.findById(header.pelanggan_id);
      const cabang = await cabangModel.findById(header.cabang_id).catch(() => null);
      const keranjang = header.keranjang_id ? await keranjangModel.findById(header.keranjang_id).catch(() => null) : null;
      const kodeKeranjang = keranjang ? keranjang.kode : null;
      const kodeMesin = await resolveKodeMesinNotif(transaksiId, target, kategoriList, mesinLogId, dropOffQty);
      const posisiManual = header.posisi_cucian_manual || null;
      const antrian = (target === 'selesai_cuci' && kategoriList.includes('kering'))
        ? await infoAntrianWa(header.cabang_id, transaksiId, 'dryer') : null;
      // Perubahan #36: "bayar saat ambil" yang belum lunas -> sertakan tagihan di pesan akhir
      const tagihan = (Number(header.bayar_saat_ambil) && header.status_bayar !== 'lunas') ? Number(header.total) : null;
      const res = await whatsappService.notifStatus({
        antrian,
        telepon: pelanggan && pelanggan.telepon,
        nama: pelanggan && pelanggan.nama,
        noInvoice: header.no_invoice,
        statusKode: target,
        cabang,
        kodeKeranjang,
        kodeMesin,
        kategoriList,
        dropOffQty,
        posisiManual,
        tagihan,
      });
      // sediakan link wa.me untuk dibuka kasir (kirim manual), baik saat API aktif/nonaktif
      const link = (res && res.link)
        || waLink(pelanggan && pelanggan.telepon, whatsappService.buildMessage(target, { nama: pelanggan && pelanggan.nama, noInvoice: header.no_invoice, cabang, kodeKeranjang, kodeMesin, kategoriList, dropOffQty, posisiManual, antrian, tagihan }));
      if (link) waOut = { link, terkirim_api: !!(res && res.sent) };
    } catch (e) { logger.error('WA notif gagal', { transaksiId, err: e.message }); }
  }

  const detail = await getDetail(transaksiId);
  if (waOut) detail.wa = waOut;
  return detail;
}

/**
 * Kasir ganti/switch alokasi mesin cuci/kering dari kartu Pesanan (menu
 * Pesanan, BUKAN dashboard) -- cuma boleh selama transaksi PERSIS di status
 * "alokasi_mesin_cuci"/"alokasi_mesin_kering" (mesin sudah ditunjuk tapi
 * BELUM mulai jalan). Mesin tujuan boleh kosong ATAU masih direservasi
 * order lain (di-swap otomatis di mesinService.realokasiAlokasi), tidak
 * pernah boleh mesin yang sedang jalan.
 * @param {object} input { tipe: 'cuci'|'kering', mesin_id }
 */
// Kode mesin pendek buat teks log ("ZL02-D05" -> "D5") -- SAMA persis
// logicnya dgn tkPendekkanKode() di public/customer/app.js & public/kasir/app.js
// (buang prefix kode cabang + leading zero), biar teks keterangan di
// transaksi_status_log konsisten sama tampilan lain, gak perlu diolah lagi
// di sisi client.
function pendekKode(kode) {
  if (!kode) return kode;
  const parts = String(kode).split('-');
  const tail = parts.length > 1 ? parts.slice(1).join('-') : parts[0];
  const m = tail.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : tail;
}

async function gantiMesin(transaksiId, input, ctx) {
  const tipeKategori = input.tipe === 'kering' ? 'kering' : 'cuci';
  const tipeMesin = tipeKategori === 'kering' ? 'dryer' : 'washer';
  const statusButuh = tipeKategori === 'kering' ? 'alokasi_mesin_kering' : 'alokasi_mesin_cuci';
  const labelStatus = tipeKategori === 'kering' ? 'Alokasi Mesin Kering' : 'Alokasi Mesin Cuci';

  const { header, jasa } = await konteksTransaksi(transaksiId);

  const curStatus = header.status_terakhir_id ? await statusModel.findById(header.status_terakhir_id) : null;
  if (!curStatus || curStatus.kode !== statusButuh) {
    throw conflict(`Alokasi mesin cuma bisa diganti selama status "${labelStatus}" (mesin sudah dialokasikan tapi belum mulai jalan).`);
  }

  const det = jasa.find((d) => d._kategori === tipeKategori);
  if (!det || !det.mesin_id) throw badRequest('Transaksi ini belum punya alokasi mesin untuk diganti');
  if (!input.mesin_id) throw badRequest('Pilih mesin tujuan');

  // Kode mesin ASAL (sebelum ditimpa) -- buat keterangan log di bawah.
  const mesinAsalRow = await mesinModel.findById(det.mesin_id).catch(() => null);
  const kodeAsal = mesinAsalRow ? mesinAsalRow.kode_mesin : `#${det.mesin_id}`;

  const hasil = await db.transaction((conn) => mesinService.realokasiAlokasi(conn, {
    cabangId: header.cabang_id, tipe: tipeMesin, detailId: det.id,
    mesinAsalId: det.mesin_id, mesinTargetId: input.mesin_id,
  }));

  // Catat perubahan alokasi ini ke riwayat (transaksi_status_log) biar
  // kelihatan di timeline customer & kasir -- pakai status_id yang SAMA
  // dengan status sekarang (masih di tahap "alokasi_mesin_X", cuma ganti
  // mesin tujuannya), jadi bukan transisi status baru, cuma event tambahan
  // di status yang sama. `keterangan` yang bawa info swap-nya, dan
  // `mesin_id` diisi mesin TUJUAN (baru) supaya:
  //   1. tampil di timeline customer (lihat findByTransaksi() -> join mesin),
  //   2. jadi entry TERBARU utk kode='alokasi_mesin_cuci/kering' yang dipakai
  //      customer app (renderProsesMesinSection) sebagai fallback kode mesin
  //      begitu status belum lanjut ke "mulai_*" -- otomatis nge-fix kode
  //      mesin yang kelihatan stale (D5) begitu kasir ganti ke D1.
  await statusLogModel.create({
    transaksi_id: transaksiId,
    status_id: curStatus.id,
    karyawan_id: ctx.userId,
    mesin_id: input.mesin_id,
    waktu: now(),
    keterangan: `Perubahan alokasi mesin ${pendekKode(kodeAsal)} ke ${pendekKode(hasil.kodeMesinTarget)} oleh kasir`,
  });

  return {
    transaksi_id: transaksiId,
    mesin_id: input.mesin_id,
    kode_mesin: hasil.kodeMesinTarget,
    swapped: hasil.swapped,
    swapped_transaksi_id: hasil.swappedTransaksiId,
  };
}

/** List transaksi untuk layar kasir (tab + cari) dengan enrichment pelanggan. */
async function list(cabangId, opts = {}) {
  const rows = await transaksiModel.listForKasir(cabangId, opts);
  // Perubahan #14: estimasi mulai untuk order yang sedang antre mesin cuci/kering
  const { kelompokkan } = require('../helpers/kelompok-pesanan');
  const antreTipe = new Map();
  for (const r of rows) {
    const k = kelompokkan({ status_bayar: r.status_bayar, bayar_saat_ambil: !!Number(r.bayar_saat_ambil), status_kode: r.status_kode,
      kategori: r.kategori_list ? String(r.kategori_list).split(',').filter(Boolean) : [] });
    if (k.grup === 'antre_mesin') antreTipe.set(r.id, k.sub === 'kering' ? 'dryer' : 'washer');
  }
  const est = { washer: null, dryer: null };
  for (const tipe of new Set(antreTipe.values())) {
    est[tipe] = await antrianService.estimasiAntre(cabangId, tipe).catch(() => null);
  }
  return rows.map((r) => ({
    antre: antreTipe.has(r.id) && est[antreTipe.get(r.id)]
      ? { tipe: antreTipe.get(r.id) === 'dryer' ? 'kering' : 'cuci', ...(est[antreTipe.get(r.id)].get(Number(r.id)) || { kode_mesin_pendek: null, tunggu_menit: null, siap_tunggu_bongkar: false, perkiraan: true }) }
      : null,
    id: r.id,
    ditahan: !!Number(r.ditahan), ditahan_alasan: r.ditahan_alasan || null, // Perubahan #49
    no_invoice: r.no_invoice,
    kode_keranjang: r.kode_antrian,
    kode_antrian: r.kode_antrian,
    tanggal: r.tanggal,
    total: r.total,
    berat_kg: r.berat_kg,
    status_bayar: r.status_bayar,
    bayar_saat_ambil: !!Number(r.bayar_saat_ambil),
    metode_bayar: r.metode_bayar,
    sumber_pesan: r.sumber_pesan,
    status_kode: r.status_kode,
    status_nama: r.status_nama,
    layanan: r.layanan_list || '',
    layanan_label: r.layanan_list || '',
    mesin_jalan: r.mesin_jalan || '',
    mesin_selesai: r.mesin_selesai || '',
    // Buat kartu 3D (samain dgn role customer) -- lihat komentar di
    // listForKasir() di transaksi.model.js.
    kategori_list: r.kategori_list ? String(r.kategori_list).split(',').filter(Boolean) : [],
    mesin_cuci_kode: r.mesin_cuci_kode || null,
    mesin_kering_kode: r.mesin_kering_kode || null,
    mesin_cuci_mulai: r.mesin_cuci_mulai || null,
    mesin_cuci_selesai: !!r.mesin_cuci_selesai,
    mesin_cuci_durasi_target: r.mesin_cuci_durasi_target != null ? Number(r.mesin_cuci_durasi_target) : null,
    mesin_kering_mulai: r.mesin_kering_mulai || null,
    mesin_kering_selesai: !!r.mesin_kering_selesai,
    mesin_kering_durasi_target: r.mesin_kering_durasi_target != null ? Number(r.mesin_kering_durasi_target) : null,
    pelanggan: {
      id: r.pelanggan_id,
      nama: r.pelanggan_nama,
      telepon: r.pelanggan_telepon,
      point: Number(r.pelanggan_point) || 0,
      kunjungan: Number(r.pelanggan_kunjungan) || 0,
      loyal: (Number(r.pelanggan_kunjungan) || 0) > 1, // >1 kunjungan = pelanggan lama
    },
  }));
}

/**
 * Perubahan #62 -- rekap layanan & barang terjual 1 hari (lunas + belum bayar),
 * untuk kartu "Rekap terjual" di Riwayat kasir. Semua transaksi hari itu
 * (tidak ikut filter tab / pencarian).
 */
async function rekapTerjual(cabangId, ymd) {
  const { today } = require('../helpers/date');
  const tgl = /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? ymd : today();
  const [rows, trx] = await Promise.all([
    db.query(
      `SELECT dt.item_tipe, COALESCE(l.kategori, b.kategori) AS kategori, dt.nama_item, l.satuan_hitung,
              SUM(dt.qty) AS qty, SUM(dt.subtotal) AS nominal
         FROM detail_transaksi dt JOIN transaksi t ON t.id = dt.transaksi_id
         LEFT JOIN layanan l ON l.id = dt.layanan_id LEFT JOIN barang b ON b.id = dt.barang_id
        WHERE t.cabang_id = ? AND DATE(t.tanggal) = ?
        GROUP BY dt.item_tipe, kategori, dt.nama_item, l.satuan_hitung
        ORDER BY qty DESC, nominal DESC, dt.nama_item`, [cabangId, tgl]),
    db.queryOne(
      `SELECT COUNT(*) AS n, SUM(status_bayar = 'lunas') AS lunas, COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(CASE WHEN status_bayar = 'lunas' THEN total ELSE 0 END), 0) AS total_lunas
         FROM transaksi WHERE cabang_id = ? AND DATE(tanggal) = ?`, [cabangId, tgl]),
  ]);
  const SAT = { per_kg: 'kg', per_km: 'km' };
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const grup = { layanan: [], laundry: [], cafe: [] };
  rows.forEach((r) => {
    const item = { nama: r.nama_item, kategori: r.kategori, qty: r2(r.qty), satuan: SAT[r.satuan_hitung] || 'x', nominal: r2(r.nominal) };
    if (r.item_tipe === 'jasa') grup.layanan.push(item);
    else if (r.kategori === 'cafe') grup.cafe.push(item);
    else grup.laundry.push(item);
  });
  const totalItem = r2(rows.reduce((a, r) => a + Number(r.nominal || 0), 0));
  const total = r2(trx && trx.total);
  return {
    tanggal: tgl, transaksi: Number(trx && trx.n) || 0, lunas: Number(trx && trx.lunas) || 0,
    ...grup, total_item: totalItem, potongan: r2(Math.max(0, totalItem - total)), total,
    total_lunas: r2(trx && trx.total_lunas), total_belum: r2(total - Number(trx && trx.total_lunas || 0)),
  };
}

async function riwayat(cabangId, opts = {}) {
  const { today } = require('../helpers/date');
  const ymd = opts.ymd || today();
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  // ambil limit+1 untuk tahu masih ada halaman berikutnya
  const rows = await transaksiModel.listRiwayat(cabangId, {
    ymd, q: opts.q || null, pelanggan: opts.pelanggan || 'semua', limit: limit + 1, offset,
  });
  const adaLagi = rows.length > limit;
  const items = (adaLagi ? rows.slice(0, limit) : rows).map((r) => {
    const baru = r.first_date && String(r.first_date).slice(0, 10) === ymd;
    return {
      id: r.id,
      no_invoice: r.no_invoice,
      tanggal: r.tanggal,
      total: r.total,
      status_bayar: r.status_bayar,
      metode_bayar: r.metode_bayar,
      sumber_pesan: r.sumber_pesan,
      status_kode: r.status_kode,
      status_nama: r.status_nama,
      layanan: r.layanan_list || '',
      pelanggan: {
        id: r.pelanggan_id,
        nama: r.pelanggan_nama,
        telepon: r.pelanggan_telepon,
        point: Number(r.pelanggan_point) || 0,
        kunjungan: Number(r.pelanggan_kunjungan) || 0,
        baru: !!baru,                 // kunjungan pertama hari ini
        loyal: (Number(r.pelanggan_kunjungan) || 0) > 1,
      },
    };
  });
  return { tanggal: ymd, items, ada_lagi: adaLagi, offset, limit };
}

/**
 * Batal pesan: HAPUS TOTAL transaksi (hanya jika BELUM BAYAR).
 * Bebaskan keranjang, kembalikan stok barang, hapus detail + log + kas_kecil terkait.
 */
async function batalPesan(transaksiId, ctx = {}) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (ctx.cabangId && header.cabang_id !== ctx.cabangId) throw conflict('Transaksi bukan dari cabang ini');
  if (header.status_bayar === 'lunas') throw conflict('Transaksi sudah dibayar, tidak bisa dibatalkan');
  // Perubahan #13: bayar saat ambil -- hanya boleh batal selama belum mulai
  // dikerjakan (masih antre, belum pernah masuk mesin).
  const bsa = !!Number(header.bayar_saat_ambil);
  if (bsa) {
    const cur = header.status_terakhir_id ? await statusModel.findById(header.status_terakhir_id) : null;
    const usage = await mesinUsageModel.byTransaksi(transaksiId);
    if ((cur && !['sudah_bayar', 'alokasi_mesin_cuci', 'alokasi_mesin_kering'].includes(cur.kode)) || usage.length) {
      throw conflict('Pesanan sudah mulai dikerjakan, tidak bisa dibatalkan');
    }
  }

  // Kalau transaksi ini sempat kepakai buat sesi QRIS Winpay (kode bayar 4
  // digit / tombol "Bayar Semua") yang masih 'pending', cancel dulu ke
  // Winpay -- best-effort, sama kayak jalur bayar manual, biar gak ada QR
  // yang keliatan masih hidup padahal transaksinya udah dihapus.
  try {
    await require('./pembayaran-qris.service').batalkanSesiPendingUntukTransaksi(transaksiId);
  } catch (e) {
    logger.error('Gagal cancel sesi QRIS pending saat batal pesan (lanjut)', { transaksiId, err: e.message });
  }

  await db.transaction(async (conn) => {
    // kembalikan stok barang -- HANYA kalau memang sudah dipotong (bayar
    // saat ambil). Order belum bayar biasa belum memotong stok (stok dipotong
    // saat bayar), jadi tidak ada yang dikembalikan. (Dulu selalu ditambah ->
    // stok bertambah palsu setiap batal pesan yang ada barangnya.)
    const items = await detailModel.findByTransaksi(transaksiId);
    for (const it of bsa ? items : []) {
      if (it.item_tipe === 'barang' && it.barang_id) {
        const stok = await barangModel.getStokLocked(conn, it.barang_id);
        if (stok == null) continue;
        const sesudah = Number(stok) + (Number(it.qty) || 0);
        await require('../models/stok-mutasi.model').create({
          barang_id: it.barang_id, cabang_id: header.cabang_id, jenis: 'masuk', qty: Number(it.qty) || 0,
          ref_tipe: 'penyesuaian', ref_id: null, stok_sebelum: Number(stok), stok_sesudah: sesudah,
          karyawan_id: ctx.kasirId || null, waktu: now(), keterangan: `Batal pesan ${header.no_invoice}`,
        }, conn);
        await barangModel.setStok(conn, it.barang_id, sesudah);
      }
    }
    // bebaskan keranjang
    if (header.keranjang_id) await keranjangModel.bebaskan(header.keranjang_id, conn, transaksiId);
    // hapus baris terkait (urutan aman thd FK)
    // pembayaran_qris_transaksi WAJIB dihapus duluan -- FK-nya ke transaksi
    // gak punya ON DELETE CASCADE (sengaja, biar riwayat pembayaran_qris
    // gak ikut ke-cascade-hapus), jadi kalau transaksi ini PERNAH nyangkut
    // ke sesi QRIS manapun (pending/failed/canceled/paid), baris transaksi
    // gak akan bisa dihapus tanpa ini duluan (error "row is referenced").
    await conn.execute(`DELETE FROM pembayaran_qris_transaksi WHERE transaksi_id = ?`, [transaksiId]);
    await conn.execute(`DELETE FROM kas_kecil WHERE ref_transaksi_id = ?`, [transaksiId]);
    await conn.execute(`DELETE FROM mesin_usage WHERE transaksi_id = ?`, [transaksiId]);
    await conn.execute(`DELETE FROM transaksi_status_log WHERE transaksi_id = ?`, [transaksiId]);
    await conn.execute(`DELETE FROM detail_transaksi WHERE transaksi_id = ?`, [transaksiId]);
    await conn.execute(`DELETE FROM transaksi WHERE id = ?`, [transaksiId]);
  });

  if (bsa) await antrianService.refresh(header.cabang_id);
  return { id: transaksiId, dibatalkan: true };
}

/**
 * Reservasi poin saat buat pesanan — hanya update diskon & total transaksi.
 * Point pelanggan belum dikurangi, dikurangi nanti saat bayar.
 */
async function reservePoin(transaksiId, input) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (header.status_bayar === 'lunas') throw conflict('Transaksi sudah lunas');
  if (!header.pelanggan_id) throw badRequest('Transaksi tidak punya pelanggan');
  await metodeBayarService.pastikanPoinAktif(header.cabang_id); // #83: penukaran poin bisa dimatikan owner

  const cabang = await cabangModel.findById(header.cabang_id);
  const NILAI_PER_POIN = Number(cabang && cabang.nilai_per_poin) || 10; // fallback Rp10/poin kalau kosong
  const KELIPATAN = 100; // kelipatan diskon tetap Rp1.000 per NILAI_PER_POIN default

  const pelanggan = await pelangganModel.findById(header.pelanggan_id);
  if (!pelanggan) throw notFound('Pelanggan tidak ditemukan');

  const pointTersedia = Number(pelanggan.point) || 0;
  if (pointTersedia < KELIPATAN) throw badRequest(`Poin tidak cukup.`);

  const poinMaksByTotal = Math.floor(header.subtotal / NILAI_PER_POIN);
  const poinMaks = Math.min(pointTersedia, poinMaksByTotal);
  const poinMaksKelipatan = Math.floor(poinMaks / KELIPATAN) * KELIPATAN;

  const poinInput = Number(input && input.poin_dipakai) || poinMaksKelipatan;
  const poinEfektif = Math.min(Math.floor(poinInput / KELIPATAN) * KELIPATAN, poinMaksKelipatan);
  if (poinEfektif < KELIPATAN) throw badRequest(`Minimum tukar ${KELIPATAN} poin.`);

  const potongan = poinEfektif * NILAI_PER_POIN;
  const totalBaru = Math.max(0, header.subtotal - potongan);
  const diskonBaru = Number(header.diskon || 0) + potongan;

  // simpan JUMLAH POIN ASLI (bukan cuma nilai rupiahnya) -- ini kunci biar
  // nanti pas tukar-poin/tampilan struk tidak perlu hitung ulang dari diskon
  // (yang rawan salah kalau nilai_per_poin cabang beda-beda atau berubah).
  await db.pool.execute(
    `UPDATE transaksi SET diskon = ?, poin_dipakai = ?, total = ? WHERE id = ?`,
    [diskonBaru, poinEfektif, totalBaru, transaksiId]
  );

  return { poin_direservasi: poinEfektif, potongan, total_baru: totalBaru };
}

/**
 * Tukar poin pelanggan sebagai potongan pembayaran -- eksekusi FINAL (poin
 * beneran dikurangi dari saldo pelanggan). Dipanggil setelah reserve-poin
 * (yang cuma nge-set diskon/total di transaksi, belum kurangi poin).
 *
 * PENTING: fungsi ini baca `header.poin_dipakai` yang SUDAH DISIMPAN oleh
 * reservePoin() -- BUKAN menghitung ulang dari `diskon` (dulu begini:
 * `Math.round(potongan / NILAI_PER_POIN)`, rawan salah kalau NILAI_PER_POIN
 * berubah/beda per cabang antara saat reserve & saat tukar).
 * @param {number} transaksiId
 * @param {object} input tidak dipakai lagi (poin sudah dari header), disisakan buat kompatibilitas
 */
/**
 * Inti tukar poin (kurangi poin pelanggan + catat biaya loyalty di kas kecil).
 * Perubahan #83: dipisah supaya bisa dipanggil juga dari bayar() Kios-K
 * (callback Winpay) -- dulu poin yg direservasi tidak pernah dipotong kalau
 * dibayar lewat Winpay. conn WAJIB.
 */
async function catatTukarPoin(conn, header, transaksiId) {
  const potongan = Number(header.diskon) || 0;
  const poinEfektif = Number(header.poin_dipakai) || 0;
  if (potongan <= 0 || poinEfektif <= 0) return;
  const nilaiPerPoin = potongan / poinEfektif;
  const metode = ['qris', 'kiosk'].includes(header.metode_bayar) ? header.metode_bayar : 'cash';
    // transaksi diskon/total sudah diupdate oleh reserve-poin, tidak perlu update lagi
    // kurangi poin aktif, tambah point_terpakai (history)
    await conn.execute(
      `UPDATE pelanggan SET point = GREATEST(0, point - ?), point_terpakai = COALESCE(point_terpakai, 0) + ? WHERE id = ?`,
      [poinEfektif, poinEfektif, header.pelanggan_id]
    );
    // catat biaya marketing/loyalty di kas kecil (keluar)
    // COA 54 = Biaya Loyalty / Redeem Poin (7-109)
    // akun ikut metode bayar → ngaruh ke saldo cash/gopay
    // kasir_id: pakai kasir transaksi, fallback ke karyawan pertama cabang jika customer app
    let loyaltyKasirId = header.kasir_id;
    if (!loyaltyKasirId) {
      const [karRow] = await conn.execute(
        `SELECT id FROM karyawan WHERE cabang_id = ? AND status = 'aktif' ORDER BY id ASC LIMIT 1`,
        [header.cabang_id]
      );
      loyaltyKasirId = karRow && karRow[0] ? karRow[0].id : null;
    }
    if (!loyaltyKasirId) throw new Error('Tidak ada karyawan aktif untuk mencatat kas kecil loyalty');
    const loyaltyAkun = metode === 'cash' ? 'cash' : 'gopay'; // #83: qris & kiosk -> gopay
    await kasKecilModel.insert({
      cabang_id: header.cabang_id,
      tanggal: now(),
      akun: loyaltyAkun,
      jenis: 'keluar',
      jenis_mutasi: 'biaya_loyalty',
      coa_id: 54,
      ref_transaksi_id: transaksiId,
      qty: poinEfektif,
      harga_satuan: nilaiPerPoin,
      nominal: potongan,
      metode_asal: metode,
      karyawan_id: loyaltyKasirId,
      keterangan: `Redeem ${poinEfektif} poin @ Rp${nilaiPerPoin} - ${header.no_invoice}`,
    }, conn);
}

async function tukarPoin(transaksiId, input) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (!header.pelanggan_id) throw badRequest('Transaksi tidak punya pelanggan');

  const potongan = Number(header.diskon) || 0;
  const poinEfektif = Number(header.poin_dipakai) || 0;
  if (potongan <= 0 || poinEfektif <= 0) throw badRequest('Tidak ada reservasi poin untuk transaksi ini');

  const cabang = await cabangModel.findById(header.cabang_id);
  const nilaiPerPoin = potongan / poinEfektif; // nilai efektif yang KEBETULAN dipakai saat reserve (buat catatan kas)

  await db.transaction(async (conn) => {
    await catatTukarPoin(conn, header, transaksiId);
  });

  const updated = await transaksiModel.findById(transaksiId);
  const pelangganAfter = await pelangganModel.findById(header.pelanggan_id);
  return {
    ...updated,
    poin_dipakai: poinEfektif,
    potongan,
    total_baru: Number(updated.total),
    sisa_poin: pelangganAfter ? Number(pelangganAfter.point) : 0,
  };
}

/**
 * Ganti pelanggan pada transaksi (koreksi salah input nama saat pesan).
 * Kalau transaksi sudah lunas: rollback poin & frekuensi dari pelanggan lama,
 * lalu hitung ulang & tambahkan ke pelanggan baru.
 * Kalau belum lunas: cukup ganti pelanggan_id (belum ada poin yang ditambahkan).
 */
async function gantiPelanggan(transaksiId, input, ctx = {}) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  if (!input.pelanggan || !input.pelanggan.telepon) {
    throw badRequest('Data pelanggan baru (telepon) wajib diisi');
  }

  const pelangganLamaId = header.pelanggan_id;

  const updated = await db.transaction(async (conn) => {
    // Cari-atau-buat pelanggan baru (pakai logic yang sama dengan createOrder)
    const { pelanggan: pelangganBaru } = await pelangganService.identifikasi({
      cabangId: ctx.cabangId || header.cabang_id,
      telepon: input.pelanggan.telepon,
      nama: input.pelanggan.nama,
      alamat: input.pelanggan.alamat,
    }, conn);

    if (pelangganBaru.id === pelangganLamaId) {
      throw badRequest('Pelanggan baru sama dengan pelanggan saat ini');
    }

    // Kalau transaksi sudah lunas, poin & frekuensi sudah ditambahkan ke pelanggan lama.
    // Rollback dulu, lalu tambahkan ke pelanggan baru.
    if (header.status_bayar === 'lunas') {
      // Perubahan #39: order jatah karyawan tidak dapat poin pelanggan
    const poin = (await jatahService.orderJatah(transaksiId, conn)) ? 0
      : poinTercatat({ total: header.total, poin_didapat: await transaksiModel.getPoinDidapat(transaksiId, conn) }); // #83
      const ymd = String(header.tanggal).slice(0, 10);

      // Cek apakah pelanggan lama masih punya transaksi lain di hari yang sama
      const sudahAdaLainnyaLama = await transaksiModel.adaTransaksiHari(pelangganLamaId, ymd, transaksiId, conn);
      const frekuensiDikurangi = sudahAdaLainnyaLama ? 0 : 1;
      await pelangganModel.tambahPointFrekuensi(pelangganLamaId, -poin, -frekuensiDikurangi, conn);

      // Tambahkan ke pelanggan baru (cek juga apakah dia sudah punya transaksi lain hari itu)
      const sudahAdaBaru = await transaksiModel.adaTransaksiHari(pelangganBaru.id, ymd, transaksiId, conn);
      await pelangganModel.tambahPointFrekuensi(pelangganBaru.id, poin, addFrekuensi(sudahAdaBaru), conn);
    }

    // Ganti pelanggan_id di transaksi
    await transaksiModel.setPelanggan(conn, transaksiId, pelangganBaru.id);

    // Catat di status log untuk audit trail
    await statusLogModel.create({
      transaksi_id: transaksiId,
      status_id: header.status_terakhir_id,
      karyawan_id: ctx.kasirId,
      waktu: now(),
      keterangan: `Ganti pelanggan dari ID ${pelangganLamaId} ke ${pelangganBaru.nama} (${pelangganBaru.telepon})`,
    }, conn);

    return { pelangganBaru };
  });

  const result = await transaksiModel.findById(transaksiId);
  return {
    ...result,
    pelanggan: updated.pelangganBaru,
    pelanggan_lama_id: pelangganLamaId,
    poin_dipindah: header.status_bayar === 'lunas' ? poinTercatat({ total: header.total, poin_didapat: await transaksiModel.getPoinDidapat(transaksiId) }) : 0,
  };
}

/**
 * Tombol "Sudah Diambil" (kasir, buat customer yang nunggu di outlet): jalankan
 * SEMUA sisa step yang berlaku sampai "sudah_diambil" secara berurutan satu-
 * satu (reuse pindahStatus() apa adanya per step -- efek/notifikasi WA/histori
 * IDENTIK persis dengan kalau kasir klik manual satu-satu, cuma dari sisi
 * kasir jadi 1 klik). Kalau transaksi ini pakai antar/antar-jemput (delivery),
 * "sudah_diambil" gak akan pernah ada di pipeline-nya -- loop berhenti wajar
 * begitu next_action habis, caller (FE) tinggal cek `sampai_sudah_diambil`.
 */
async function selesaikanSekaligus(transaksiId, ctx) {
  const h0 = await transaksiModel.findById(transaksiId);
  if (h0 && h0.status_bayar !== 'lunas') throw conflict('Pesanan belum dibayar. Terima pembayaran dulu sebelum cucian diserahkan.');
  const MAX_ITERASI = 20; // safety guard, hindari infinite loop kalau ada bug state-machine
  let iterasi = 0;

  while (iterasi < MAX_ITERASI) {
    const detail = await getDetail(transaksiId);
    const na = detail.next_action || {};
    if (!na.target) break; // sudah di ujung (tipe 'selesai', atau kasus aneh 'bayar')
    // Step yang butuh input/nunggu sesuatu di luar kendali kasir -- JANGAN
    // dipaksa lompat (harusnya emang gak ketemu situasi ini di titik
    // selesai_kering/selesai_cuci ke bawah, tapi safety kalau ada yang aneh).
    if (['pilih_mesin', 'menunggu_otomatis', 'menunggu_gate', 'bayar'].includes(na.tipe)) break;

    await pindahStatus(transaksiId, { status: na.target }, ctx);
    iterasi += 1;
    if (na.target === 'sudah_diambil') break;
  }

  const akhir = await getDetail(transaksiId);
  return {
    sampai_sudah_diambil: akhir.status_kode === 'sudah_diambil',
    status_akhir: akhir.status_kode,
    status_akhir_nama: akhir.status_nama,
    langkah: iterasi,
  };
}

module.exports = {
  rekapTerjual, _internal: { susunItem }, onOffMesin, prosesBayarSaatAmbil, resumeKering, selesaiCuciPopup, _cancelTimer, createOrder, bayar, tukarPoin, reservePoin, getDetail, pindahStatus, gantiMesin, setPosisiManual, konteksTransaksi, list, riwayat, batalPesan, gantiPelanggan, recoverDryerTimers, recoverWasherTimers, mulaiSafetyNetAutoComplete, restartProses, startSetelahAlarm, daftarAntrian, cobaAlokasikanAntrian, selesaikanSekaligus };
