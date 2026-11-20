/**
 * src/services/mesin.service.js
 * =============================================================================
 * Operasi mesin terkait workflow transaksi. Dipanggil oleh state-machine
 * (transaksi.service.pindahStatus) sesuai efek status:
 *   - alokasi(conn, ...) : pilih/validasi mesin utk baris detail (status alokasi_*)
 *   - mulai(conn, ...)   : buka sesi mesin_usage + set mesin 'jalan' (+IoT ON di service IoT)
 *   - selesai(conn, ...) : tutup sesi + total_cycle+1 + set mesin 'aktif' (+IoT OFF)
 *
 * IoT (publish MQTT) dipisah ke iot.service; di sini fokus state DB.
 * =============================================================================
 */

const mesinModel = require('../models/mesin.model');
const usageModel = require('../models/mesin-usage.model');
const detailModel = require('../models/detail-transaksi.model');
const mesinLogManualModel = require('../models/mesin-log-manual.model');
const iotService = require('./iot.service');
const iotLogModel = require('../models/iot-log.model');
const logger = require('../config/logger');
const { badRequest, conflict, notFound } = require('../helpers/errors');

/**
 * Alokasikan mesin ke baris detail (status alokasi_mesin_cuci/kering).
 * Validasi: mesin ada, cabang sama, tipe cocok, kapasitas cukup, status 'aktif'.
 * Set detail.mesin_id. (Belum dijalankan/IoT.)
 */
async function alokasi(conn, { transaksi, detail, mesinId, tipe }) {
  const m = await mesinModel.lockById(conn, mesinId);
  if (!m) throw notFound('Mesin tidak ditemukan');
  if (m.cabang_id !== transaksi.cabang_id) throw badRequest('Mesin beda cabang');
  if (m.tipe !== tipe) throw badRequest(`Mesin harus tipe ${tipe}`);
  if (m.status !== 'aktif') throw conflict(`Mesin ${m.kode_mesin} sedang ${m.status}, pilih mesin lain`);
  // kapasitas tidak diblok — operator bebas memilih mesin (percaya operator)
  await detailModel.setMesin(conn, detail.id, mesinId);
  return m;
}

/**
 * Mulai pemakaian (status mulai_cuci/kering): buka sesi usage + mesin 'jalan'.
 * Return data mesin (untuk IoT publish command on_off/start_pause).
 */
async function mulai(conn, { transaksi, detail, mesinId, waktu }) {
  const m = await mesinModel.lockById(conn, mesinId);
  if (!m) throw notFound('Mesin tidak ditemukan');
  if (m.status === 'jalan') throw conflict(`Mesin ${m.kode_mesin} sedang jalan`);

  await usageModel.buka({
    mesin_id: mesinId,
    detail_transaksi_id: detail.id,
    transaksi_id: transaksi.id,
    waktu_mulai: waktu,
    cycle: 1,
  }, conn);
  await mesinModel.setStatus(mesinId, 'jalan', conn);
  return m;
}

/**
 * Selesai pemakaian (status selesai_cuci/kering): tutup sesi + cycle+1 + mesin 'aktif'.
 */
async function selesai(conn, { transaksi, mesinId, waktu }) {
  const ditutup = await usageModel.tutup({ mesinId, transaksiId: transaksi.id, waktuSelesai: waktu }, conn);
  // Perubahan #23: cycle hanya bertambah kalau memang ada sesi yang ditutup
  if (ditutup) await mesinModel.tambahCycle(mesinId, 1, conn);
  await mesinModel.setStatus(mesinId, 'aktif', conn);
  // Return data mesin agar caller bisa cek tuya_device_id untuk IoT trigger
  return mesinModel.findById(mesinId);
}

/**
 * Restart proses (kasir): mesin sudah tercatat 'jalan' tapi gagal trigger
 * fisik. Tutup sesi lama TANPA nambah cycle (dianggap gagal, bukan selesai
 * normal) + buka sesi baru dengan waktu_mulai = waktu restart. Status mesin
 * TETAP 'jalan' sepanjang proses ini (sudah jalan sebelumnya, restart tidak
 * mengubah status itu -- cuma "napak tilas" sesi & waktunya).
 */
async function restart(conn, { transaksiId, mesinId, detailTransaksiId, waktu }) {
  const m = await mesinModel.lockById(conn, mesinId);
  if (!m) throw notFound('Mesin tidak ditemukan');
  await usageModel.tutup({ mesinId, transaksiId, waktuSelesai: waktu }, conn);
  await usageModel.buka({
    mesin_id: mesinId, detail_transaksi_id: detailTransaksiId,
    transaksi_id: transaksiId, waktu_mulai: waktu, cycle: 1,
  }, conn);
  return m;
}

/**
 * Ambil angka NOMOR MESIN dari kode_mesin -- pakai angka TERAKHIR dalam
 * string, bukan yang pertama. Penting karena kode_mesin sering diawali
 * kode cabang yang juga mengandung angka (mis. "ZL02-W5" -> nomor mesin
 * yang benar adalah 5, BUKAN 02 dari prefix cabang "ZL02"). Kalau dipakai
 * angka pertama, semua mesin dalam satu cabang bakal "kelihatan" punya
 * nomor yang sama (angka cabangnya) -> pairing washer<->dryer jadi salah
 * total (semua dryer keitung berjarak 0 dari washer manapun).
 * Contoh: "D3" -> 3, "ZL02-W1" -> 1, "ZL02-D05" -> 5, "W15" -> 15.
 */
function angkaDariKode(kodeMesin) {
  const semuaAngka = String(kodeMesin || '').match(/\d+/g);
  return semuaAngka && semuaAngka.length ? Number(semuaAngka[semuaAngka.length - 1]) : 0;
}

/** Urutan default: cycle count paling rendah dulu, tie-break kode_mesin angka terkecil. */
function urutkanCycleTerendah(list) {
  return [...list].sort((a, b) => {
    if (a.total_cycle !== b.total_cycle) return a.total_cycle - b.total_cycle;
    return angkaDariKode(a.kode_mesin) - angkaDariKode(b.kode_mesin);
  });
}

/**
 * Cek ULANG (di dalam transaksi yang sama, setelah lock) apakah mesin ini
 * masih benar-benar bebas -- anti race-condition kalau 2 alokasi otomatis
 * kebetulan bareng milih mesin yang sama persis.
 */
async function masihBebas(conn, mesinId) {
  // Dicocokkan ke kategori layanan baris detail-nya sendiri (cuci vs kering),
  // bukan cuma status transaksi saat ini -- kalau tidak, washer yang sudah
  // kelar cuci ikut kebaca "direservasi" terus begitu transaksi lanjut ke
  // fase alokasi_mesin_kering (lihat catatan sama di mesin.model.js).
  const [rows] = await conn.execute(
    `SELECT m.status,
       EXISTS(
         SELECT 1 FROM detail_transaksi dt
         JOIN transaksi t ON t.id = dt.transaksi_id
         JOIN status_master sm ON sm.id = t.status_terakhir_id
         JOIN layanan l ON l.id = dt.layanan_id
         WHERE dt.mesin_id = m.id
           AND (
             (l.kategori = 'cuci' AND sm.kode = 'alokasi_mesin_cuci')
             OR (l.kategori = 'kering' AND sm.kode = 'alokasi_mesin_kering')
           )
       ) AS direservasi
     FROM mesin m WHERE m.id = ?`,
    [mesinId]
  );
  const r = rows[0];
  return !!r && r.status === 'aktif' && !Number(r.direservasi);
}

/**
 * Urutan prioritas mesin KERING (dryer):
 *  1. Kosong/idle (sudah difilter di caller: status='aktif', belum direservasi).
 *  2. "Tepat di atasnya" -- dryer dengan angka kode_mesin SAMA dengan washer
 *     asal (dianggap satu pasang fisik dengan washer itu), kalau di cabang
 *     ini jumlah washer = jumlah dryer (berpasangan rapi). Ini selisih=0
 *     pada sort jarak di bawah.
 *  3. Terdekat -- selisih angka kode_mesin paling kecil dari washer asal.
 *  4. Cycle count paling rendah -- tie-break TERAKHIR kalau ada beberapa
 *     dryer dengan selisih jarak yang sama persis.
 *  (tie-break paling akhir: kode_mesin angka terkecil, biar deterministik)
 */
function urutkanPrioritasDryer(list, kodeMesinAsal) {
  const angkaAsal = angkaDariKode(kodeMesinAsal);
  return [...list].sort((a, b) => {
    const da = Math.abs(angkaDariKode(a.kode_mesin) - angkaAsal);
    const db_ = Math.abs(angkaDariKode(b.kode_mesin) - angkaAsal);
    if (da !== db_) return da - db_; // #2 (pas pairing) + #3 (terdekat) -- 0 = pasangan persis
    if (a.total_cycle !== b.total_cycle) return a.total_cycle - b.total_cycle; // #4 cycle
    return angkaDariKode(a.kode_mesin) - angkaDariKode(b.kode_mesin); // tie-break akhir
  });
}

/**
 * Pilih mesin OTOMATIS sesuai rules yang disepakati:
 *  1. Kosong (status='aktif', belum direservasi), exclude maintenance/nonaktif
 *     total (sudah otomatis lewat filter status='aktif').
 *  2. Kapasitas berat: cuma validasi cukup/tidak (bukan faktor ranking --
 *     mesin seragam, tidak perlu size-matching).
 *  3. Mesin cuci (washer): cycle count paling rendah dulu, tie-break
 *     kode_mesin angka terkecil.
 *  4. Mesin kering (dryer): kosong -> mesin tepat di atasnya (kode_mesin
 *     sama angka dengan washer asal, kalau jumlah washer = jumlah dryer di
 *     cabang ini) -> terdekat (selisih angka kode_mesin terkecil) -> baru
 *     cycle count paling rendah sebagai tie-break terakhir. Kalau tidak ada
 *     washer asal (kodeMesinAsal kosong) atau cabang tidak berpasangan rapi,
 *     fallback ke rule dasar cycle-rendah.
 *
 * @returns {object|null} baris mesin yang terpilih (sudah di-lock FOR UPDATE
 *   dalam `conn`), atau `null` kalau semua penuh/tidak ada yang cocok --
 *   caller harus perlakukan ini sebagai "masuk antrian", bukan error keras.
 */
async function pilihOtomatis(conn, { cabangId, tipe, beratKg, kodeMesinAsal }) {
  const semua = await mesinModel.findByCabang(cabangId, { tipe });
  let kandidat = semua.filter((m) => m.status === 'aktif' && !m.direservasi
    && (beratKg == null || Number(m.kapasitas_kg) >= Number(beratKg)));
  if (!kandidat.length) return null;

  if (tipe === 'dryer' && kodeMesinAsal) {
    // prasyarat pairing: jumlah washer = jumlah dryer di cabang ini
    const jmlWasher = (await mesinModel.findByCabang(cabangId, { tipe: 'washer' })).length;
    const jmlDryer = semua.length;
    if (jmlWasher === jmlDryer) {
      kandidat = urutkanPrioritasDryer(kandidat, kodeMesinAsal);
    } else {
      kandidat = urutkanCycleTerendah(kandidat);
    }
  } else {
    kandidat = urutkanCycleTerendah(kandidat);
  }

  // coba lock kandidat urut dari yang paling cocok; kalau ternyata sudah
  // kesambar transaksi lain (race), lanjut ke kandidat berikutnya.
  for (const m of kandidat) {
    const locked = await mesinModel.lockById(conn, m.id);
    if (locked && (await masihBebas(conn, m.id))) return locked;
  }
  return null;
}

/**
 * Ganti alokasi mesin untuk transaksi yang SUDAH dialokasi tapi BELUM mulai
 * jalan (status alokasi_mesin_cuci/kering) -- dipakai kasir switch antrian
 * dari kartu Pesanan (menu Pesanan, BUKAN dashboard). Mesin tujuan boleh
 * KOSONG atau MASIH DIRESERVASI order lain yang juga belum jalan -- kalau
 * ternyata sedang direservasi order lain, lakukan SWAP (order lain itu
 * dilempar ke mesin asal kita), supaya order itu tidak pernah kehilangan
 * alokasinya sama sekali. Mesin yang SEDANG JALAN/maintenance/nonaktif
 * tidak pernah boleh jadi tujuan.
 */
async function realokasiAlokasi(conn, { cabangId, tipe, detailId, mesinAsalId, mesinTargetId }) {
  if (Number(mesinAsalId) === Number(mesinTargetId)) throw badRequest('Mesin tujuan sama dengan mesin sekarang');
  const target = await mesinModel.lockById(conn, mesinTargetId);
  if (!target) throw notFound('Mesin tidak ditemukan');
  if (target.cabang_id !== cabangId) throw badRequest('Mesin beda cabang');
  if (target.tipe !== tipe) throw badRequest(`Mesin harus tipe ${tipe}`);
  if (target.status !== 'aktif') {
    throw conflict(`Mesin ${target.kode_mesin} sedang ${target.status === 'jalan' ? 'jalan' : target.status}, tidak bisa dipilih`);
  }

  // cek apakah mesin tujuan lagi direservasi order lain (belum jalan) -- lock
  // baris detail_transaksi-nya juga biar aman dari race kalau ada kasir lain
  // yang barengan nge-switch mesin yang sama. Dicocokkan ke kategori layanan
  // baris itu sendiri (cuci vs kering) juga -- lihat catatan di mesin.model.js.
  const [rows] = await conn.execute(
    `SELECT dt.id AS detail_transaksi_id, dt.transaksi_id
     FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id
     JOIN status_master sm ON sm.id = t.status_terakhir_id
     JOIN layanan l ON l.id = dt.layanan_id
     WHERE dt.mesin_id = ?
       AND (
         (l.kategori = 'cuci' AND sm.kode = 'alokasi_mesin_cuci')
         OR (l.kategori = 'kering' AND sm.kode = 'alokasi_mesin_kering')
       )
       AND dt.id != ?
     LIMIT 1 FOR UPDATE`,
    [mesinTargetId, detailId]
  );
  const reservasiLain = rows[0] || null;

  if (reservasiLain) {
    // swap: order lain yang kehilangan mesin tujuan sekarang dapat mesin asal kita
    await detailModel.setMesin(conn, reservasiLain.detail_transaksi_id, mesinAsalId);
  }
  await detailModel.setMesin(conn, detailId, mesinTargetId);
  return {
    swapped: !!reservasiLain,
    swappedTransaksiId: reservasiLain ? reservasiLain.transaksi_id : null,
    kodeMesinTarget: target.kode_mesin,
  };
}

module.exports = {
  alokasi, mulai, selesai, restart, triggerManual, switchMesin, ubahStatus, daftarCommand, setIotProvider,
  pilihOtomatis, prediksiMesin, realokasiAlokasi, rilisManualMacet,
  // dipakai antrian-mesin.service sebagai tie-break waktu kosong yang sama
  _urutkanCycleTerendah: urutkanCycleTerendah, _urutkanPrioritasDryer: urutkanPrioritasDryer,
};

/**
 * Preview (READ-ONLY, TANPA lock) mesin yang KEMUNGKINAN kepilih kalau
 * pilihOtomatis() dijalankan sekarang -- dipakai buat nampilin prediksi ke
 * customer/kasir SEBELUM alokasi beneran terjadi (mis. "Alokasi Mesin Kering
 * di D03"). Bisa saja beda dari hasil final kalau kebetulan ada yang
 * nyerobot bersamaan (jarang) -- makanya HANYA buat label tampilan, jangan
 * dijadikan acuan mengikat apa pun (alokasi beneran tetap lewat
 * pilihOtomatis() yang pakai lock).
 * @returns {string|null} kode_mesin, atau null kalau semua penuh
 */
async function prediksiMesin(cabangId, tipe, beratKg, kodeMesinAsal) {
  const semua = await mesinModel.findByCabang(cabangId, { tipe });
  let kandidat = semua.filter((m) => m.status === 'aktif' && !m.direservasi
    && (beratKg == null || Number(m.kapasitas_kg) >= Number(beratKg)));
  if (!kandidat.length) return null;

  if (tipe === 'dryer' && kodeMesinAsal) {
    const jmlWasher = (await mesinModel.findByCabang(cabangId, { tipe: 'washer' })).length;
    if (jmlWasher === semua.length) {
      kandidat = urutkanPrioritasDryer(kandidat, kodeMesinAsal);
    } else {
      kandidat = urutkanCycleTerendah(kandidat);
    }
  } else {
    kandidat = urutkanCycleTerendah(kandidat);
  }
  return kandidat[0].kode_mesin;
}

/* ============================================================
   AKSI MANAGER (dipanggil dari controller mesin manager)
   ============================================================ */
const db = require('../config/database');
const { now } = require('../helpers/date');

/** Daftar command key yang tersedia untuk mesin (dari command JSON). */
async function daftarCommand(mesinId, cabangId) {
  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && mesin.cabang_id !== cabangId) throw conflict('Mesin bukan milik cabang ini');
  return {
    mesin_id: mesinId,
    kode_mesin: mesin.kode_mesin,
    punya_sn: !!mesin.sn,
    commands: iotService.availableCommands(mesin),
  };
}

/** Trigger IoT manual: paksa jalankan command tertentu (atau 'start'). */
// Timer manual-trigger dryer & washer (terpisah dari timer transaksi asli di
// transaksi.service.js, karena trigger manual gak punya transaksiId).
const manualDryerTimers = new Map();  // mesinId -> Timeout handle
const manualWasherTimers = new Map(); // mesinId -> Timeout handle

// Mesin cuci OFF sendiri secara fisik (siklus internal) -- gak pernah ada
// command "stop" yang dikirim balik ke sistem. Jadi trigger manual start di
// washer dijadwalkan auto-kembali idle setelah durasi tetap ini, supaya
// mesin gak nyangkut permanen di status 'jalan' (yang bikin gak bisa
// dipilih customer/kasir DAN gak bisa direset lewat "Ubah Status").
const WASHER_MANUAL_DURASI_MENIT = 36;

function cancelManualDryerTimer(mesinId) {
  const h = manualDryerTimers.get(mesinId);
  if (h) { clearTimeout(h); manualDryerTimers.delete(mesinId); }
}

function cancelManualWasherTimer(mesinId) {
  const h = manualWasherTimers.get(mesinId);
  if (h) { clearTimeout(h); manualWasherTimers.delete(mesinId); }
}

/**
 * Tutup 1 "siklus manual" (dipicu trigger manual, BUKAN transaksi customer):
 * balikin status mesin ke 'aktif' + tambah total_cycle, TAPI cuma kalau
 * status TERKINI di DB masih 'jalan' -- cek ulang ke DB (bukan percaya
 * snapshot lama) supaya gak dobel nambah cycle kalau race antara timer
 * auto-off sama manager yang kebetulan kirim command stop hampir bersamaan.
 */
async function selesaikanSiklusManual(mesinId) {
  const cur = await mesinModel.findById(mesinId);
  if (cur && cur.status === 'jalan') {
    await mesinModel.setStatus(mesinId, 'aktif');
    await mesinModel.tambahCycle(mesinId, 1);
  }
}

/**
 * Self-heal mesin yang "nyangkut" di status 'jalan' gara-gara trigger manual,
 * padahal harusnya udah auto-idle lewat timer. Timer auto-idle di
 * triggerManual() cuma hidup di MEMORI proses Node -- kalau server di-restart
 * (deploy, crash, dst) SELAGI ada mesin yang lagi "ditrigger manual", timer-nya
 * ikut hilang dan mesin itu nyangkut running selamanya di sistem walau
 * fisiknya udah lama berhenti (mesin cuci OFF sendiri / dryer abis durasinya).
 *
 * Dipanggil dari dashboard.service.papanMesin() tiap kali dashboard dimuat
 * (kasir & manager, ini satu-satunya sumber papan status mesin) -- jadi gak
 * perlu nunggu admin benerin manual lewat database, cukup buka dashboard lagi.
 *
 * Logikanya:
 *  1. Cari mesin washer/dryer di cabang ini yang status='jalan' TAPI TIDAK
 *     punya sesi mesin_usage aktif (kalau ADA usage aktif, itu transaksi
 *     customer beneran yang lagi jalan -- JANGAN disentuh).
 *  2. Buat tiap mesin begitu, cari log trigger_manual TERAKHIRnya. Kalau gak
 *     ketemu (bukan dari trigger manual, entah gimana caranya) -> skip, jangan
 *     asal ubah (aman lebih penting daripada rapi).
 *  3. Hitung durasi seharusnya: command dryN -> N menit; command lain
 *     (start/Autorun/dst, termasuk washer) -> WASHER_MANUAL_DURASI_MENIT.
 *  4. Kalau sudah lewat durasi itu dari waktu trigger -> selesaikan (balik
 *     'aktif' + cycle+1), sama seperti kalau timernya beneran nyala.
 */
async function rilisManualMacet(cabangId) {
  const [semua, usageAktif] = await Promise.all([
    mesinModel.findByCabang(cabangId),
    usageModel.aktifByCabang(cabangId),
  ]);
  const adaUsageAktif = new Set(usageAktif.map((u) => Number(u.mesin_id)));
  const kandidat = semua.filter((m) => (m.tipe === 'washer' || m.tipe === 'dryer')
    && m.status === 'jalan' && !adaUsageAktif.has(Number(m.id)));
  if (!kandidat.length) return;

  await Promise.all(kandidat.map(async (m) => {
    try {
      const log = await mesinLogManualModel.lastTriggerManual(m.id);
      if (!log) return; // bukan dari trigger manual -- jangan disentuh, aman lebih penting
      const dryMatch = /^dry(\d+)$/.exec(log.command || '');
      const durasiMenit = dryMatch ? Number(dryMatch[1]) : WASHER_MANUAL_DURASI_MENIT;
      const mulaiMs = new Date(String(log.created_at).replace(' ', 'T') + '+07:00').getTime();
      if (isNaN(mulaiMs)) return;
      const lewatMs = Date.now() - mulaiMs;
      if (lewatMs >= durasiMenit * 60 * 1000) {
        await selesaikanSiklusManual(m.id);
        logger.info('Self-heal: mesin nyangkut jalan (timer hilang, mis. server restart) -> diselesaikan', {
          mesinId: m.id, kodeMesin: m.kode_mesin, command: log.command, durasiMenit,
        });
      }
    } catch (e) {
      logger.error('Self-heal rilisManualMacet gagal utk 1 mesin', { mesinId: m.id, err: e.message });
    }
  }));
}

/** Cari & trigger exaust fan 1 cabang, gak nge-block/gagal-in apapun kalau error. */
async function triggerExaustFan(cabangId, commandKey, mesinIdKonteks) {
  try {
    const list = await mesinModel.findByCabang(cabangId, { tipe: 'exaust_fan' });
    if (!list[0]) return;
    await iotService.trigger(list[0], commandKey);
    await iotLogModel.create({ mesinId: list[0].id, commandKey, sukses: true }).catch(() => {});
  } catch (e) {
    logger.error('Trigger manual: exaust fan gagal', { cabangId, commandKey, mesinIdKonteks, err: e.message });
    const list = await mesinModel.findByCabang(cabangId, { tipe: 'exaust_fan' }).catch(() => []);
    if (list[0]) await iotLogModel.create({ mesinId: list[0].id, commandKey, sukses: false, pesanError: e.message }).catch(() => {});
  }
}

/**
 * Trigger IoT manual: paksa jalankan command tertentu (atau 'start').
 *
 * Selain kirim command fisik, endpoint ini juga menyinkronkan status &
 * total_cycle mesin ke kondisi fisik sebenarnya (KHUSUS washer/dryer, bukan
 * exaust_fan) -- soalnya kalau tidak, mesin yang lagi dites/dipakai manual
 * masih kebaca 'aktif' (kosong) di sistem dan bisa aja ikut ditawarkan ke
 * customer/kasir lain buat order baru, padahal fisiknya lagi jalan:
 *  - Command "start"-like (dryN/start/Autorun/on/dst, selain STOP_KEYS di
 *    bawah) -> status jadi 'jalan' (dikeluarkan dari pilihan mesin).
 *  - Command STOP_KEYS ('selesai'/'force_off'/'off') -> balik 'aktif' +
 *    total_cycle+1 (dianggap 1 siklus beneran kepakai).
 *
 * Auto-kembali idle dijadwalkan pakai TIMER (bukan nunggu command stop
 * manual dari manager), supaya gak ada resiko mesin nyangkut permanen di
 * status 'jalan':
 *  - Dryer: durasi dari command-nya sendiri (dry15/dry30/dst dalam menit).
 *  - Washer: mesin cuci OFF sendiri secara fisik (siklus internal, gak ada
 *    command stop yang dikirim balik) -> durasi TETAP WASHER_MANUAL_DURASI_MENIT
 *    (36 menit) dihitung dari saat trigger start dikirim.
 * Khusus dryer, exaust fan juga diikutkan nyala/mati (mirip alur transaksi
 * asli), CUMA dimatikan kalau gak ada dryer LAIN yang beneran lagi jalan
 * dari transaksi customer (dicek ke mesin_usage).
 */
async function triggerManual(mesinId, commandKey, cabangId, { alasan, karyawanId } = {}) {
  if (!alasan || !alasan.trim()) throw badRequest('Alasan trigger manual wajib diisi');

  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && mesin.cabang_id !== cabangId) throw conflict('Mesin bukan milik cabang ini');
  const key = commandKey || 'start';

  // catat audit SEBELUM eksekusi -- kalau IoT gagal pun, jejak "siapa nyoba
  // trigger apa & kenapa" tetap ada.
  await mesinLogManualModel.create({
    mesinId, jenisAksi: 'trigger_manual', transaksiId: null, command: key,
    alasan: alasan.trim(), karyawanId, cabangId: mesin.cabang_id,
  });

  await iotService.trigger(mesin, key);

  const STOP_KEYS = new Set(['selesai', 'force_off', 'off']);
  const isStop = STOP_KEYS.has(key);
  const dryMatch = /^dry(\d+)$/.exec(key);

  if (mesin.tipe === 'dryer') {
    if (dryMatch) {
      const durasiMenit = Number(dryMatch[1]);
      cancelManualDryerTimer(mesinId); // jaga-jaga jangan sampai numpuk timer lama
      if (mesin.status === 'aktif') await mesinModel.setStatus(mesinId, 'jalan');

      // Nyalakan exaust fan (best-effort, gak nge-block trigger dryer-nya)
      triggerExaustFan(mesin.cabang_id, 'on', mesinId);

      const handle = setTimeout(async () => {
        manualDryerTimers.delete(mesinId);
        try {
          // Perubahan #26: >= 45 menit = siklus bawaan, mesin mati sendiri -> jangan di-pulse
          if (durasiMenit < (Number(process.env.DRYER_SIKLUS_BAWAAN_MENIT) || 45)) {
            await iotService.trigger(mesin, 'selesai');
            logger.info('Trigger manual dryer: auto-OFF terkirim', { mesinId, durasiMenit });
          }
        } catch (e) {
          logger.error('Trigger manual dryer: auto-OFF gagal', { mesinId, err: e.message });
        }
        await selesaikanSiklusManual(mesinId).catch((e) => logger.error('Trigger manual dryer: gagal sinkron status/cycle', { mesinId, err: e.message }));
        // matiin exaust fan CUMA kalau gak ada dryer lain (dari transaksi asli) yang jalan
        const jmlDryerJalan = await usageModel.countAktifByTipe(mesin.cabang_id, 'dryer').catch(() => 0);
        if (jmlDryerJalan === 0) triggerExaustFan(mesin.cabang_id, 'off', mesinId);
      }, durasiMenit * 60 * 1000);
      handle.unref();
      manualDryerTimers.set(mesinId, handle);
    } else if (isStop) {
      // Manager matiin manual lebih awal -> batalkan timer auto-off yang nyisa
      cancelManualDryerTimer(mesinId);
      await selesaikanSiklusManual(mesinId);
      const jmlDryerJalan = await usageModel.countAktifByTipe(mesin.cabang_id, 'dryer').catch(() => 0);
      if (jmlDryerJalan === 0) triggerExaustFan(mesin.cabang_id, 'off', mesinId);
    }
  } else if (mesin.tipe === 'washer') {
    if (isStop) {
      // Manager matiin manual lebih awal (jarang -- biasanya washer OFF
      // sendiri) -> batalkan timer 36 menit yang nyisa, langsung selesaikan.
      cancelManualWasherTimer(mesinId);
      await selesaikanSiklusManual(mesinId);
    } else {
      // command start-like (start/Autorun/on/dst)
      cancelManualWasherTimer(mesinId); // jaga-jaga jangan sampai numpuk timer lama
      if (mesin.status === 'aktif') await mesinModel.setStatus(mesinId, 'jalan');

      const handle = setTimeout(async () => {
        manualWasherTimers.delete(mesinId);
        await selesaikanSiklusManual(mesinId).catch((e) => logger.error('Trigger manual washer: gagal sinkron status/cycle', { mesinId, err: e.message }));
        logger.info('Trigger manual washer: auto-idle setelah durasi tetap', { mesinId, durasiMenit: WASHER_MANUAL_DURASI_MENIT });
      }, WASHER_MANUAL_DURASI_MENIT * 60 * 1000);
      handle.unref();
      manualWasherTimers.set(mesinId, handle);
    }
  }

  return { mesin_id: mesinId, kode_mesin: mesin.kode_mesin, command: key };
}

/** Ubah status mesin manual: aktif | maintenance | nonaktif. */
async function ubahStatus(mesinId, status, cabangId) {
  const ALLOWED = ['aktif', 'maintenance', 'nonaktif'];
  if (!ALLOWED.includes(status)) throw badRequest('Status tidak valid');
  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && mesin.cabang_id !== cabangId) throw conflict('Mesin bukan milik cabang ini');
  if (mesin.status === 'jalan') {
    // Mesin rusak di tengah jalan: kalau yang jalan itu ORDER customer (ada
    // sesi mesin_usage aktif) DAN cabang mode antrian otomatis -> boleh
    // di-maintenance/nonaktif-kan; order-nya dikeluarkan & ditaruh paling
    // depan antrian (diulang dari awal di mesin lain), lihat
    // antrian-mesin.service.mesinBerubahStatus(). Selain itu (trigger manual
    // / mode manual) tetap seperti dulu: switch dulu.
    const usageAktif = await usageModel.aktifByCabang(mesin.cabang_id);
    const adaOrder = usageAktif.some((u) => Number(u.mesin_id) === Number(mesinId));
    const cabang = await require('../models/cabang.model').findById(mesin.cabang_id).catch(() => null);
    const otomatis = cabang && cabang.pemilihan_mesin === 'otomatis';
    if (!(adaOrder && otomatis && status !== 'aktif')) {
      throw conflict('Mesin sedang jalan, tidak bisa ubah status. Lakukan switch dulu.');
    }
  }
  await mesinModel.setStatus(mesinId, status);
  // Antrian terkunci: mesin rusak/aktif lagi -> tata ulang otomatis (no-op di mode manual)
  if (status !== mesin.status) {
    await require('./antrian-mesin.service').mesinBerubahStatus({ ...mesin, status }, status)
      .catch((e) => logger.error('Tata ulang antrian setelah ubah status mesin gagal', { mesinId, err: e.message }));
  }
  return { mesin_id: mesinId, status, tipe: mesin.tipe, cabang_id: mesin.cabang_id };
}

/**
 * Switch transaksi yang sedang jalan dari mesin asal -> mesin tujuan (tipe sama).
 * - usage di mesin asal ditutup TANPA nambah cycle (mesin asal tidak jadi kerja)
 * - usage baru dibuka di mesin tujuan (transaksi lanjut dari titik yang sama)
 * - detail_transaksi.mesin_id dipindah ke mesin tujuan
 * - mesin tujuan -> 'jalan'; mesin asal TIDAK diubah (manager set status manual)
 * - cycle akan bertambah di mesin tujuan saat sesi diselesaikan (selesai())
 */
async function switchMesin(dariId, keId, cabangId) {
  if (Number(dariId) === Number(keId)) throw badRequest('Mesin tujuan sama dengan asal');
  const [dari, ke] = await Promise.all([mesinModel.findById(dariId), mesinModel.findById(keId)]);
  if (!dari) throw notFound('Mesin asal tidak ditemukan');
  if (!ke) throw notFound('Mesin tujuan tidak ditemukan');
  if (cabangId && (dari.cabang_id !== cabangId || ke.cabang_id !== cabangId)) throw conflict('Mesin bukan milik cabang ini');
  if (dari.tipe !== ke.tipe) throw badRequest(`Tipe mesin beda (${dari.tipe} -> ${ke.tipe})`);
  if (ke.status === 'jalan') throw conflict('Mesin tujuan sedang jalan');
  if (ke.status === 'maintenance' || ke.status === 'nonaktif') throw conflict('Mesin tujuan tidak aktif');

  // usage aktif di mesin asal
  const aktif = await usageModel.aktifByCabang(dari.cabang_id);
  const sesi = aktif.find((u) => Number(u.mesin_id) === Number(dariId));
  if (!sesi) throw conflict('Tidak ada transaksi yang sedang jalan di mesin asal');

  const waktu = now();
  return db.transaction(async (conn) => {
    // tutup usage asal (tanpa nambah cycle — mesin asal tidak jadi kerja)
    await usageModel.tutup({ mesinId: dariId, transaksiId: sesi.transaksi_id, waktuSelesai: waktu }, conn);
    // buka usage di mesin tujuan (transaksi lanjut)
    await usageModel.buka({
      mesin_id: keId, detail_transaksi_id: sesi.detail_transaksi_id || null,
      transaksi_id: sesi.transaksi_id, waktu_mulai: waktu, cycle: 1,
    }, conn);
    // pindah mesin_id di detail (kalau ada baris jasa yg pakai mesin asal)
    const detail = await detailModel.findByTransaksi(sesi.transaksi_id);
    const detMesin = detail.find((d) => Number(d.mesin_id) === Number(dariId));
    if (detMesin) await detailModel.setMesin(conn, detMesin.id, keId);
    // status: tujuan jadi 'jalan'; asal dilepas ke 'aktif' (idle) agar tidak nyangkut "jalan".
    // (manager dapat mengubah asal ke 'maintenance' manual sesudah ini bila rusak)
    await mesinModel.setStatus(keId, 'jalan', conn);
    await mesinModel.setStatus(dariId, 'aktif', conn);
    return {
      transaksi_id: sesi.transaksi_id, no_invoice: sesi.no_invoice,
      dari: dari.kode_mesin, ke: ke.kode_mesin,
    };
  });
}

/** Update iot_provider mesin */
async function setIotProvider(mesinId, provider, cabangId) {
  const ALLOWED = ['tuya', 'hallo', 'bypass'];
  if (!ALLOWED.includes(provider)) throw badRequest(`Provider tidak valid: ${provider}`);
  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && mesin.cabang_id !== cabangId) throw conflict('Mesin bukan milik cabang ini');
  await mesinModel.updateIotProvider(mesinId, provider);
  return { mesin_id: mesinId, kode_mesin: mesin.kode_mesin, iot_provider: provider };
}
