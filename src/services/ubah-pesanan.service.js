/**
 * src/services/ubah-pesanan.service.js
 * =============================================================================
 * Perubahan #6 + #8 (24 Okt 2026) -- KASIR UBAH PESANAN dari popup mesin &
 * menu Pesanan: tambah / hapus layanan, ubah jumlah layanan per-load
 * (Drop-Off), serta tambah / kurangi / hapus BARANG (laundry & cafe).
 *
 * Aturan (keputusan owner):
 *  LAYANAN
 *  - Boleh dihapus/diubah jumlahnya hanya kalau BELUM JALAN (belum dikerjakan /
 *    teralokasi mesin). Yang sedang jalan / sudah selesai tidak bisa.
 *    Layanan PROMO (gratis) tidak bisa dihapus/ditambah. Baris yang pernah
 *    tercatat jalan di mesin (riwayat mesin_usage) juga tidak bisa dihapus.
 *  - Ditambah: aktif, cabang sama, bukan promo, kategorinya belum ada, dan
 *    tahapnya belum terlewati. Harga ikut aturan order baru (tier cuci dsb).
 *  - Jumlah yang bisa diubah: layanan per-load Drop-Off (maks 2).
 *  BARANG (laundry, cafe, dll)
 *  - Bebas ditambah / dikurangi / dihapus (pengembalian = barang belum
 *    dipakai/diambil, kasir yang menilai). Tambah dicek stok.
 *  - Order LUNAS: stok langsung disesuaikan (stok_mutasi penjualan /
 *    penyesuaian retur). Order belum lunas: stok baru berkurang saat bayar.
 *  UANG
 *  - ALASAN WAJIB. Order LUNAS: selisih dicatat ke kas kecil (pendapatan
 *    masuk / keluar) via cash/QRIS pilihan kasir, kasir WAJIB konfirmasi uang
 *    diterima/dikembalikan. Poin customer dihitung ulang dari total baru.
 *  - Order yang SUDAH DISETOR ke manajemen tidak bisa diubah dari kasir.
 * =============================================================================
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { now } = require('../helpers/date');
const { buildStages } = require('../helpers/state-machine');
const { hitungPoinItems, poinTercatat } = require('../helpers/poin');
const { warnaLayanan } = require('../helpers/layanan-ikon');
const { BY_KODE } = require('../constants/status');
const { badRequest, conflict, notFound } = require('../helpers/errors');
const transaksiModel = require('../models/transaksi.model');
const detailModel = require('../models/detail-transaksi.model');
const layananModel = require('../models/layanan.model');
const barangModel = require('../models/barang.model');
const statusModel = require('../models/status-master.model');
const kasKecilModel = require('../models/kas-kecil.model');
const stokMutasiModel = require('../models/stok-mutasi.model');
const kasService = require('./kas.service');
const keranjangService = require('./keranjang.service');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const KATEGORI_CUCIAN = ['cuci', 'kering', 'lipat', 'setrika_lipat', 'drop_off'];
const KATEGORI_ANTAR = ['antar', 'antar_jemput', 'jemput']; // #73
const STATUS_AKHIR = ['sudah_diambil', 'selesai_antar'];
const MAKS_DROP_OFF = 2;
// tahap pertama tiap kategori (layanan hanya boleh DITAMBAH kalau tahap ini belum terlewati)
const TAHAP_AWAL = {
  cuci: 'alokasi_mesin_cuci', kering: 'alokasi_mesin_kering', lipat: 'proses_lipat',
  setrika_lipat: 'proses_setrika', antar: 'proses_antar', antar_jemput: 'proses_jemput', jemput: 'proses_jemput', drop_off: null,
};
const LABEL_KAT = {
  cuci: 'Cuci', kering: 'Kering', drop_off: 'Drop-Off', lipat: 'Lipat',
  setrika_lipat: 'Setrika Lipat', antar: 'Antar', antar_jemput: 'Antar Jemput', jemput: 'Jemput',
};
const urut = (k) => (BY_KODE[k] && BY_KODE[k].urutan) || 0;

async function muatKonteks(transaksiId) {
  const header = await transaksiModel.findById(transaksiId);
  if (!header) throw notFound('Transaksi tidak ditemukan');
  // Perubahan #39: order jatah karyawan tidak bisa diubah (batal lalu pesan ulang)
  if (await require('./jatah.service').orderJatah(transaksiId)) {
    throw require('../helpers/errors').conflict('Pesanan jatah karyawan tidak bisa diubah. Batalkan (kalau belum dibayar) lalu pesan ulang.');
  }
  const st = header.status_terakhir_id ? await statusModel.findById(header.status_terakhir_id) : null;
  const statusKode = st ? st.kode : null;
  const items = await detailModel.findByTransaksi(transaksiId);
  const jasa = [];
  for (const it of items.filter((x) => x.item_tipe === 'jasa' && x.layanan_id)) {
    const L = await layananModel.findById(it.layanan_id);
    jasa.push({
      ...it, kategori: L ? L.kategori : it.layanan_kategori, is_promo: L ? Number(L.is_promo) : 0,
      durasi_menit: L ? L.durasi_menit : null, satuan: L ? L.satuan_hitung : null,
    });
  }
  const barang = items.filter((x) => x.item_tipe === 'barang' && x.barang_id);
  const pernahJalan = new Set((await db.query(
    `SELECT DISTINCT detail_transaksi_id AS id FROM mesin_usage WHERE transaksi_id = ?`, [transaksiId]
  )).map((r) => Number(r.id)));
  return { header, statusKode, items, jasa, barang, pernahJalan };
}

/** Layanan boleh dihapus / diubah jumlahnya? -> { ok, alasan } */
function cekHapus(row, statusKode, pernahJalan) {
  const w = warnaLayanan(row.kategori, statusKode);
  if (w === 'merah') return { ok: false, alasan: 'Sedang berjalan' };
  if (w === 'hijau') return { ok: false, alasan: 'Sudah selesai' };
  if (row.is_promo) return { ok: false, alasan: 'Layanan promo tidak bisa dihapus' };
  if (pernahJalan.has(Number(row.id))) return { ok: false, alasan: 'Pernah dijalankan di mesin' };
  return { ok: true };
}

/** Bisa tambah 1 kategori? (kategoriSisa = kategori setelah penghapusan) */
function cekTambah(kategori, statusKode, kategoriSisa) {
  if (kategoriSisa.has(kategori)) return { ok: false, alasan: `${LABEL_KAT[kategori] || kategori} sudah ada di pesanan` };
  const awal = TAHAP_AWAL[kategori];
  if (awal && urut(statusKode) >= urut(awal)) return { ok: false, alasan: 'Tahapnya sudah terlewati' };
  return { ok: true };
}

function blokirUmum(header, statusKode) {
  if (STATUS_AKHIR.includes(statusKode)) return 'Pesanan sudah selesai';
  if (header.status_bayar === 'lunas' && header.status_setor && header.status_setor !== 'belum_setor') {
    return 'Pesanan sudah disetor ke manajemen, tidak bisa diubah dari kasir';
  }
  return null;
}

const bisaUbahQtyLayanan = (row) => row.kategori === 'drop_off' && row.satuan === 'per_load';

/** Info untuk layar Ubah Pesanan. */
async function info(transaksiId, { cabangId } = {}) {
  const { header, statusKode, jasa, barang, pernahJalan } = await muatKonteks(transaksiId);
  if (cabangId && Number(header.cabang_id) !== Number(cabangId)) throw conflict('Transaksi bukan dari cabang ini');
  const kategoriAda = new Set(jasa.map((j) => j.kategori));
  const [katalog, katalogBarang] = await Promise.all([
    layananModel.findByCabang(header.cabang_id),
    barangModel.findByCabang(header.cabang_id),
  ]);
  const blokir = blokirUmum(header, statusKode);
  const qtyBarang = new Map();
  barang.forEach((b) => qtyBarang.set(Number(b.barang_id), (qtyBarang.get(Number(b.barang_id)) || 0) + Number(b.qty)));
  return {
    transaksi_id: header.id, no_invoice: header.no_invoice, status_kode: statusKode,
    status_bayar: header.status_bayar, status_setor: header.status_setor,
    subtotal: Number(header.subtotal), diskon: Number(header.diskon), total: Number(header.total),
    berat_kg: header.berat_kg, alamat_antar: header.alamat_antar,
    blokir, // null = boleh diubah
    bisa_berat: !blokir, // Perubahan #50: kasir boleh ubah berat cucian
    items: jasa.map((j) => {
      const c = cekHapus(j, statusKode, pernahJalan);
      return {
        detail_id: j.id, layanan_id: j.layanan_id, kategori: j.kategori, nama: j.nama_item,
        harga: Number(j.harga_satuan), qty: Number(j.qty), subtotal: Number(j.subtotal),
        durasi_menit: j.durasi_menit, warna: warnaLayanan(j.kategori, statusKode),
        bisa_hapus: !blokir && c.ok, alasan_tidak: blokir || c.alasan || null,
        bisa_qty: !blokir && c.ok && bisaUbahQtyLayanan(j), qty_maks: j.kategori === 'drop_off' ? MAKS_DROP_OFF : null,
      };
    }),
    katalog: katalog.map((L) => {
      const c = cekTambah(L.kategori, statusKode, kategoriAda);
      return {
        layanan_id: L.id, kategori: L.kategori, nama: L.nama_paket, harga: Number(L.harga),
        satuan: L.satuan_hitung, durasi_menit: L.durasi_menit, berat_maks: L.berat_maks,
        bisa_tambah: !blokir && (c.ok || kategoriAda.has(L.kategori)), alasan_tidak: blokir || (c.ok || kategoriAda.has(L.kategori) ? null : c.alasan),
        kategori_sudah_ada: kategoriAda.has(L.kategori),
        qty_maks: L.kategori === 'drop_off' ? MAKS_DROP_OFF : null,
      };
    }),
    // Perubahan #8: barang (laundry, cafe, dll) + jumlah di pesanan sekarang
    barang: katalogBarang.map((B) => ({
      id: B.id, foto_v: B.foto_v || null, // Perubahan #72: foto kartu barang
      barang_id: B.id, nama: B.nama, kategori: B.kategori, harga: Number(B.harga_jual), satuan: B.satuan,
      stok: Number(B.stok_terkini), qty: qtyBarang.get(Number(B.id)) || 0, urutan: B.urutan,
    })).concat(
      // barang di pesanan yang sudah nonaktif dari katalog tetap tampil (bisa dikurangi)
      barang.filter((b) => !katalogBarang.some((B) => Number(B.id) === Number(b.barang_id)))
        .map((b) => ({ barang_id: b.barang_id, nama: b.nama_item, kategori: 'lainnya', harga: Number(b.harga_satuan), satuan: b.barang_satuan, stok: 0, qty: Number(b.qty), nonaktif: true }))
    ),
  };
}

/**
 * Hitung perubahan (tanpa menulis). Dipakai untuk pratinjau & sebelum simpan.
 * input: {
 *   tambah: [{layanan_id, qty?}], hapus: [detail_id],
 *   qty_layanan: [{detail_id, qty}],       // layanan per-load (Drop-Off)
 *   barang: [{barang_id, qty}],            // jumlah AKHIR per barang (0 = hapus)
 *   alamat_antar?
 * }
 */
async function hitung(transaksiId, input, { cabangId } = {}) {
  const ctx = await muatKonteks(transaksiId);
  const { header, statusKode, jasa, barang, items, pernahJalan } = ctx;
  if (cabangId && Number(header.cabang_id) !== Number(cabangId)) throw conflict('Transaksi bukan dari cabang ini');
  const blokir = blokirUmum(header, statusKode);
  if (blokir) throw conflict(blokir);
  const lunas = header.status_bayar === 'lunas';

  const hapusIds = new Set((input.hapus || []).map(Number).filter(Boolean));
  const tambahSel = (input.tambah || []).filter((t) => t && t.layanan_id);
  const dihapus = [];      // baris detail yang dihapus (layanan & barang)
  const ditambah = [];     // item baru (layanan & barang)
  const diubah = [];       // { row, qtyBaru, subtotalBaru }

  // ---- LAYANAN: hapus ----
  for (const id of hapusIds) {
    const row = jasa.find((j) => Number(j.id) === id);
    if (!row) {
      if (barang.some((b) => Number(b.id) === id)) continue; // barang diatur lewat input.barang
      throw badRequest(`Item #${id} bukan layanan pesanan ini`);
    }
    const c = cekHapus(row, statusKode, pernahJalan);
    if (!c.ok) throw conflict(`${row.nama_item}: ${c.alasan}`);
    dihapus.push(row);
  }

  // ---- LAYANAN: ubah jumlah (Drop-Off) ----
  for (const q of input.qty_layanan || []) {
    const row = jasa.find((j) => Number(j.id) === Number(q.detail_id));
    if (!row || hapusIds.has(Number(row.id))) continue;
    const qtyBaru = Math.round(Number(q.qty) || 0);
    if (qtyBaru === Number(row.qty)) continue;
    if (!bisaUbahQtyLayanan(row)) throw conflict(`${row.nama_item}: jumlahnya tidak bisa diubah`);
    const c = cekHapus(row, statusKode, pernahJalan);
    if (!c.ok) throw conflict(`${row.nama_item}: ${c.alasan}`);
    if (qtyBaru <= 0) { dihapus.push(row); continue; }
    if (qtyBaru > MAKS_DROP_OFF) throw conflict(`${row.nama_item}: maksimal ${MAKS_DROP_OFF}`);
    diubah.push({ row, qtyBaru, subtotalBaru: round2(Number(row.harga_satuan) * qtyBaru) });
  }

  const idDihapus = new Set(dihapus.map((d) => Number(d.id)));
  const sisaJasa = jasa.filter((j) => !idDihapus.has(Number(j.id)));
  const kategoriSisa = new Set(sisaJasa.map((j) => j.kategori));

  // ---- Perubahan #50: BERAT CUCIAN berubah -> tier Cuci & layanan per kg dihitung ulang ----
  const beratLama = Number(header.berat_kg) || 0;
  let beratBaru = beratLama;
  let beratBerubah = false;
  if (input.berat_kg !== undefined && input.berat_kg !== null && input.berat_kg !== '') {
    const b = Math.round(Number(String(input.berat_kg).replace(',', '.')) * 10) / 10;
    if (!(b > 0) || b > 1000) throw badRequest('Berat cucian tidak valid');
    if (b !== beratLama) { beratBaru = b; beratBerubah = true; }
  }
  const bulat = (x) => (x > 0 ? Math.max(1, Math.round(x)) : 0);
  if (beratBerubah) {
    const opsiCuci = await layananModel.findCuciByCabang(header.cabang_id);
    for (const row of sisaJasa) {
      if (row.is_promo) continue;
      if (row.kategori === 'cuci' && opsiCuci.length > 1) {
        const L = opsiCuci.find((r) => r.berat_maks == null || bulat(beratBaru) <= Number(r.berat_maks)) || opsiCuci[opsiCuci.length - 1];
        if (Number(L.id) !== Number(row.layanan_id)) {
          const harga = Number(L.harga); const q = Number(row.qty) || 1;
          diubah.push({ row, qtyBaru: q, subtotalBaru: round2(harga * q), layananBaru: { id: L.id, nama: L.nama_paket, harga } });
        }
      } else if (row.satuan === 'per_kg') {
        const q = bulat(beratBaru);
        if (q !== Number(row.qty)) diubah.push({ row, qtyBaru: q, subtotalBaru: round2(Number(row.harga_satuan) * q) });
      }
    }
  }

  // ---- LAYANAN: tambah (harga ikut aturan order baru: tier cuci, per_kg, drop-off) ----
  if (tambahSel.length) {
    const kategoriBaru = new Set();
    for (const t of tambahSel) {
      const L = await layananModel.findById(t.layanan_id);
      if (!L || Number(L.cabang_id) !== Number(header.cabang_id) || L.status !== 'aktif') throw badRequest(`Layanan #${t.layanan_id} tidak valid untuk cabang ini`);
      if (Number(L.is_promo)) throw badRequest('Layanan promo tidak bisa ditambahkan dari sini');
      const c = cekTambah(L.kategori, statusKode, kategoriSisa);
      if (!c.ok) throw conflict(`${L.nama_paket}: ${c.alasan}`);
      if (kategoriBaru.has(L.kategori)) throw conflict(`Pilih satu saja untuk ${LABEL_KAT[L.kategori] || L.kategori}`);
      kategoriBaru.add(L.kategori);
    }
    const { susunItem } = require('./transaksi.service')._internal;
    const susun = await susunItem(header.cabang_id, {
      berat_kg: beratBaru, layanan: tambahSel.map((t) => ({ layanan_id: t.layanan_id, qty: t.qty })), barang: [],
    });
    ditambah.push(...susun.items);
    if (ditambah.some((it) => KATEGORI_CUCIAN.includes(it.kategori)) && !(Number(beratBaru) > 0)) {
      throw badRequest('Berat cucian pesanan ini belum diisi');
    }
    if (ditambah.some((it) => KATEGORI_ANTAR.includes(it.kategori))
      && !(header.alamat_antar || (input.alamat_antar && String(input.alamat_antar).trim()))) {
      throw badRequest('Alamat antar wajib diisi untuk layanan antar/antar-jemput');
    }
  }

  // ---- BARANG: jumlah akhir per barang ----
  const stokPerlu = []; // { barang_id, nama, tambahQty } untuk cek stok
  for (const sel of input.barang || []) {
    const barangId = Number(sel.barang_id);
    if (!barangId) continue;
    const qtyAkhir = Math.max(0, Math.round(Number(sel.qty) || 0));
    const rows = barang.filter((b) => Number(b.barang_id) === barangId);
    const qtySkrg = rows.reduce((s, b) => s + Number(b.qty), 0);
    if (qtyAkhir === qtySkrg) continue;
    if (!rows.length) {
      const B = await barangModel.findById(barangId);
      if (!B || Number(B.cabang_id) !== Number(header.cabang_id) || B.status !== 'aktif') throw badRequest(`Barang #${barangId} tidak valid untuk cabang ini`);
      const harga = Number(B.harga_jual);
      ditambah.push({
        item_tipe: 'barang', layanan_id: null, barang_id: B.id, kategori: null,
        nama_item: B.nama, harga_satuan: harga, qty: qtyAkhir, subtotal: round2(harga * qtyAkhir),
      });
      stokPerlu.push({ barang_id: B.id, nama: B.nama, tambahQty: qtyAkhir });
      continue;
    }
    // baris utama = baris pertama; baris dobel (jarang) digabung ke baris utama
    const [utama, ...lain] = rows;
    lain.forEach((b) => dihapus.push(b));
    if (qtyAkhir === 0) { dihapus.push(utama); continue; }
    diubah.push({ row: utama, qtyBaru: qtyAkhir, subtotalBaru: round2(Number(utama.harga_satuan) * qtyAkhir), dariGabung: lain });
    if (qtyAkhir > qtySkrg) stokPerlu.push({ barang_id: barangId, nama: utama.nama_item, tambahQty: qtyAkhir - qtySkrg });
  }
  // stok cukup? (dicek ulang dengan lock saat simpan untuk order lunas)
  for (const s of stokPerlu) {
    const B = await barangModel.findById(s.barang_id);
    const stok = B ? Number(B.stok_terkini) : 0;
    if (stok < s.tambahQty) throw conflict(`Stok ${s.nama} tidak cukup (sisa ${stok}, butuh tambahan ${s.tambahQty})`);
  }

  if (!dihapus.length && !ditambah.length && !diubah.length && !beratBerubah) throw badRequest('Belum ada perubahan pesanan');

  const idDihapusAkhir = new Set(dihapus.map((d) => Number(d.id)));
  const ubahMap = new Map(diubah.map((u) => [Number(u.row.id), u]));
  const sisaSemua = items.filter((it) => !idDihapusAkhir.has(Number(it.id)));
  if (!sisaSemua.length && !ditambah.length) throw conflict('Pesanan harus punya minimal 1 item');

  const subtotalBaru = round2(
    sisaSemua.reduce((s, it) => s + (ubahMap.has(Number(it.id)) ? ubahMap.get(Number(it.id)).subtotalBaru : Number(it.subtotal)), 0)
    + ditambah.reduce((s, it) => s + it.subtotal, 0)
  );
  const diskon = Number(header.diskon) || 0;
  const totalBaru = round2(Math.max(subtotalBaru - diskon, 0));
  const totalLama = Number(header.total) || 0;
  const selisih = round2(totalBaru - totalLama);
  const kategoriAkhir = [...new Set([...kategoriSisa, ...ditambah.filter((d) => d.kategori).map((d) => d.kategori)])];
  // Perubahan #83: poin hanya dari layanan mesin (cuci & kering)
  const itemsAkhir = [
    ...sisaSemua.map((it) => ({
      item_tipe: it.item_tipe, kategori: it.kategori || it.layanan_kategori,
      subtotal: ubahMap.has(Number(it.id)) ? ubahMap.get(Number(it.id)).subtotalBaru : Number(it.subtotal),
    })),
    ...ditambah.map((d) => ({ item_tipe: d.item_tipe, kategori: d.kategori, subtotal: d.subtotal })),
  ];
  const jatahOrder = lunas ? await require('./jatah.service').orderJatah(header.id) : false;
  const poinLama = lunas ? poinTercatat({ total: totalLama, poin_didapat: await transaksiModel.getPoinDidapat(header.id) }) : 0;
  const poinBaru = lunas && !jatahOrder ? hitungPoinItems(itemsAkhir, totalBaru) : (lunas ? poinLama : 0);
  return {
    ctx, dihapus, ditambah, diubah, kategoriAkhir, beratBaru, beratBerubah,
    ringkas: {
      transaksi_id: header.id, no_invoice: header.no_invoice, lunas,
      berat_lama: beratLama, berat_baru: beratBaru, berat_berubah: beratBerubah,
      total_lama: totalLama, total_baru: totalBaru, subtotal_baru: subtotalBaru, diskon, selisih,
      arah_uang: !lunas || selisih === 0 ? null : selisih > 0 ? 'terima' : 'kembalikan',
      nominal_uang: lunas ? Math.abs(selisih) : 0,
      poin_lama: poinLama, poin_baru: poinBaru,
      dihapus: dihapus.map((d) => ({ detail_id: d.id, nama: d.nama_item, qty: Number(d.qty), subtotal: Number(d.subtotal) })),
      ditambah: ditambah.map((d) => ({ layanan_id: d.layanan_id, barang_id: d.barang_id, nama: d.nama_item, qty: d.qty, subtotal: d.subtotal })),
      diubah: diubah.map((u) => ({ detail_id: u.row.id, nama: u.row.nama_item, nama_baru: u.layananBaru ? u.layananBaru.nama : null, qty_lama: Number(u.row.qty), qty_baru: u.qtyBaru, subtotal_lama: Number(u.row.subtotal), subtotal_baru: u.subtotalBaru })),
    },
  };
}

/** Pratinjau (tidak menulis apa pun). */
async function pratinjau(transaksiId, input, opt) {
  const h = await hitung(transaksiId, input, opt);
  return h.ringkas;
}

/** Ubah stok 1 barang (order lunas) + catat stok_mutasi. delta < 0 = keluar (jual), > 0 = masuk (retur). */
async function ubahStok(conn, { barangId, delta, header, refId, kasirId, tanggal, nama }) {
  if (!delta) return;
  const sebelum = await barangModel.getStokLocked(conn, barangId);
  if (sebelum === null) return;
  const sesudah = Number(sebelum) + delta;
  if (sesudah < 0) throw conflict(`Stok ${nama} tidak cukup (sisa ${sebelum}, butuh ${-delta})`);
  await stokMutasiModel.create({
    barang_id: barangId, cabang_id: header.cabang_id, jenis: delta < 0 ? 'keluar' : 'masuk', qty: Math.abs(delta),
    ref_tipe: delta < 0 ? 'penjualan' : 'penyesuaian', ref_id: refId || null,
    stok_sebelum: sebelum, stok_sesudah: sesudah, karyawan_id: kasirId, waktu: tanggal,
    keterangan: `${delta < 0 ? 'Tambah' : 'Retur'} ubah pesanan ${header.no_invoice}`,
  }, conn);
  await barangModel.setStok(conn, barangId, sesudah);
}

/**
 * Simpan perubahan.
 * input: { ...hitung, alasan, metode ('cash'|'qris'), konfirmasi_uang (bool) }
 */
async function simpan(transaksiId, input, { cabangId, kasirId }) {
  const alasan = String(input.alasan || '').trim();
  if (!alasan) throw badRequest('Alasan wajib diisi');
  const h = await hitung(transaksiId, input, { cabangId });
  const { header, statusKode } = h.ctx;
  const r = h.ringkas;
  const metode = input.metode === 'qris' ? 'qris' : 'cash';
  if (r.arah_uang) {
    if (!['cash', 'qris'].includes(input.metode)) throw badRequest('Pilih metode uang: cash atau QRIS');
    if (input.konfirmasi_uang !== true) {
      throw badRequest(r.arah_uang === 'terima'
        ? 'Konfirmasi dulu bahwa uang tambahan sudah diterima'
        : 'Konfirmasi dulu bahwa uang sudah dikembalikan ke customer');
    }
  }
  const akun = metode === 'qris' ? 'gopay' : 'cash';
  const tanggal = now();

  // baris kas kecil 1 item (nominal > 0)
  const catatKas = async (conn, { jenis, item, nominal, qty, ket }) => {
    if (!(Number(nominal) > 0)) return;
    const coa = await kasService.coaItem(item);
    await kasKecilModel.insert({
      cabang_id: header.cabang_id, tanggal, akun, jenis, jenis_mutasi: 'pendapatan',
      coa_id: coa, ref_transaksi_id: transaksiId, ref_detail_transaksi_id: jenis === 'masuk' && item.id ? item.id : null,
      qty: qty ?? null, harga_satuan: item.harga_satuan ?? null, nominal: round2(nominal), metode_asal: metode,
      karyawan_id: kasirId, keterangan: ket,
    }, conn);
  };

  await db.transaction(async (conn) => {
    // kunci header supaya 2 kasir tidak mengubah bersamaan
    const [lock] = await conn.execute(`SELECT total, status_bayar, status_setor FROM transaksi WHERE id = ? FOR UPDATE`, [transaksiId]);
    if (!lock[0] || Number(lock[0].total) !== r.total_lama || lock[0].status_bayar !== header.status_bayar) {
      throw conflict('Pesanan baru saja berubah, muat ulang lalu coba lagi');
    }
    let netKas = 0;
    // Perubahan #13: bayar saat ambil -> stok sudah dipotong saat diproses
    // (ikut disesuaikan), tapi kas belum ada (dicatat saat bayar).
    const stokDipotong = r.lunas || !!Number(header.bayar_saat_ambil);

    // 1) hapus item (kas lama tetap sebagai riwayat; referensi detailnya dilepas)
    for (const d of h.dihapus) {
      await conn.execute(`UPDATE kas_kecil SET ref_detail_transaksi_id = NULL WHERE ref_detail_transaksi_id = ?`, [d.id]);
      await conn.execute(`DELETE FROM detail_transaksi WHERE id = ? AND transaksi_id = ?`, [d.id, transaksiId]);
      if (stokDipotong && d.item_tipe === 'barang') {
        await ubahStok(conn, { barangId: d.barang_id, delta: Number(d.qty), header, refId: null, kasirId, tanggal, nama: d.nama_item });
      }
      if (r.lunas) {
        await catatKas(conn, { jenis: 'keluar', item: d, nominal: Number(d.subtotal), qty: d.qty, ket: `Pengembalian ${d.nama_item} - ${header.no_invoice} (${alasan})` });
        netKas -= Number(d.subtotal);
      }
    }

    // 2) ubah jumlah
    for (const u of h.diubah) {
      const qtyLama = Number(u.row.qty) + (u.dariGabung || []).reduce((s, b) => s + Number(b.qty), 0);
      const subLama = Number(u.row.subtotal) + (u.dariGabung || []).reduce((s, b) => s + Number(b.subtotal), 0);
      if (u.layananBaru) {
        // Perubahan #50: tier Cuci berganti karena berat berubah
        await conn.execute(`UPDATE detail_transaksi SET layanan_id = ?, nama_item = ?, harga_satuan = ?, qty = ?, subtotal = ? WHERE id = ?`,
          [u.layananBaru.id, u.layananBaru.nama, u.layananBaru.harga, u.qtyBaru, u.subtotalBaru, u.row.id]);
      } else {
        await conn.execute(`UPDATE detail_transaksi SET qty = ?, subtotal = ? WHERE id = ?`, [u.qtyBaru, u.subtotalBaru, u.row.id]);
      }
      if (stokDipotong && u.row.item_tipe === 'barang') {
        // baris gabungan sudah dikembalikan stoknya di langkah 1 -> hitung dari qty baris utama saja
        await ubahStok(conn, { barangId: u.row.barang_id, delta: Number(u.row.qty) - u.qtyBaru, header, refId: u.row.id, kasirId, tanggal, nama: u.row.nama_item });
      }
      if (r.lunas) {
        const subUtama = Number(u.row.subtotal);
        const delta = round2(u.subtotalBaru - subUtama);
        const ket = (u.layananBaru ? `${u.row.nama_item} → ${u.layananBaru.nama}` : `${u.row.nama_item} ${qtyLama} → ${u.qtyBaru}`) + ` - ${header.no_invoice}${delta < 0 ? ` (${alasan})` : ''}`;
        await catatKas(conn, { jenis: delta > 0 ? 'masuk' : 'keluar', item: u.row, nominal: Math.abs(delta), qty: Math.abs(u.qtyBaru - Number(u.row.qty)), ket });
        netKas += delta;
        void subLama;
      }
    }

    // 3) tambah item
    const itemBaru = [];
    for (const it of h.ditambah) {
      const id = await detailModel.create(conn, { transaksi_id: transaksiId, ...it, mesin_id: null });
      itemBaru.push({ ...it, id });
    }
    if (stokDipotong) {
      for (const it of itemBaru) {
        if (it.item_tipe === 'barang') {
          await ubahStok(conn, { barangId: it.barang_id, delta: -Number(it.qty), header, refId: it.id, kasirId, tanggal, nama: it.nama_item });
        }
      }
    }
    if (r.lunas) {
      if (itemBaru.length) {
        await kasService.catatPendapatanTransaksi(conn, { transaksi: header, items: itemBaru, akun, metode, kasirId, tanggal });
        netKas += itemBaru.reduce((s, it) => s + it.subtotal, 0);
      }
    }

    // 4) keranjang kalau sekarang ada cucian tapi belum punya keranjang
    if (!header.keranjang_id && h.kategoriAkhir.some((k) => KATEGORI_CUCIAN.includes(k))) {
      const krj = await keranjangService.alokasi(conn, header.cabang_id, transaksiId);
      await transaksiModel.setKeranjang(conn, transaksiId, krj.id, krj.kode);
    }
    if (input.alamat_antar && !header.alamat_antar) {
      await conn.execute(`UPDATE transaksi SET alamat_antar = ? WHERE id = ?`, [String(input.alamat_antar).trim(), transaksiId]);
    }

    // 5) total baru (+ berat baru, Perubahan #50)
    await conn.execute(`UPDATE transaksi SET subtotal = ?, total = ? WHERE id = ?`, [r.subtotal_baru, r.total_baru, transaksiId]);
    if (h.beratBerubah) await conn.execute(`UPDATE transaksi SET berat_kg = ? WHERE id = ?`, [h.beratBaru, transaksiId]);

    // 6) status: kalau tahap sekarang hilang (mis. hapus Cuci yang teralokasi) -> mundur
    //    ke tahap terakhir yang masih berlaku & sudah dilewati
    const stages = buildStages(h.kategoriAkhir);
    let statusAkhirKode = statusKode;
    if (statusKode && !stages.includes(statusKode)) {
      const mundur = stages.filter((k) => urut(k) <= urut(statusKode));
      statusAkhirKode = mundur.length ? mundur[mundur.length - 1] : stages[0];
    }
    const stRow = await statusModel.findByKode(statusAkhirKode);
    if (statusAkhirKode !== statusKode) await transaksiModel.setStatus(conn, transaksiId, stRow.id);

    if (r.lunas) {
      // 7) penyesuaian kalau diskon membuat selisih total != selisih item (jarang)
      const koreksi = round2(r.selisih - round2(netKas));
      if (koreksi !== 0) {
        const acuan = itemBaru[0] || h.dihapus[0] || (h.diubah[0] && h.diubah[0].row);
        await catatKas(conn, {
          jenis: koreksi > 0 ? 'masuk' : 'keluar', item: acuan || { item_tipe: 'jasa' }, nominal: Math.abs(koreksi),
          ket: `Penyesuaian diskon ubah pesanan - ${header.no_invoice}`,
        });
      }
      // 8) poin dihitung ulang dari total baru
      const deltaPoin = r.poin_baru - r.poin_lama;
      if (deltaPoin) {
        await conn.execute(`UPDATE pelanggan SET point = GREATEST(0, point + ?) WHERE id = ?`, [deltaPoin, header.pelanggan_id]);
      }
      await transaksiModel.setPoinDidapat(conn, header.id, r.poin_baru); // #83
    }

    // 9) riwayat (timeline) -- alasan wajib
    const ket = [
      ...(h.beratBerubah ? [`Berat ${String(r.berat_lama).replace('.', ',')} → ${String(r.berat_baru).replace('.', ',')} kg`] : []),
      ...h.ditambah.map((d) => `+${d.nama_item}${d.item_tipe === 'barang' || d.qty > 1 ? ` x${d.qty}` : ''}`),
      ...h.diubah.map((u) => (u.layananBaru ? `${u.row.nama_item}→${u.layananBaru.nama}` : `${u.row.nama_item} ${Number(u.row.qty)}→${u.qtyBaru}`)),
      ...h.dihapus.map((d) => `-${d.nama_item}`),
    ].join(', ');
    const uangTxt = r.arah_uang ? `; ${r.arah_uang === 'terima' ? 'terima' : 'kembalikan'} Rp${r.nominal_uang.toLocaleString('id-ID')} via ${metode.toUpperCase()}` : '';
    await conn.execute(
      `INSERT INTO transaksi_status_log (transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan) VALUES (?,?,?,?,?,?)`,
      [transaksiId, stRow.id, kasirId, null, tanggal, `Ubah pesanan: ${ket}${uangTxt}. Alasan: ${alasan}`.slice(0, 255)]
    );
  });

  // QRIS pending lama (order belum lunas) sudah tidak cocok nominalnya -> batalkan (best-effort)
  if (!r.lunas) {
    try { await require('./pembayaran-qris.service').batalkanSesiPendingUntukTransaksi(transaksiId); }
    catch (e) { logger.error('Gagal batalkan QRIS pending setelah ubah pesanan', { transaksiId, err: e.message }); }
  }
  // antrian mesin (layanan cuci/kering bertambah/berkurang)
  await require('./antrian-mesin.service').refresh(header.cabang_id);
  return r;
}

module.exports = { info, pratinjau, simpan };
