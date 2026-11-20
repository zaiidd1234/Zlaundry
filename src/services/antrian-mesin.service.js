/**
 * src/services/antrian-mesin.service.js
 * =============================================================================
 * ANTRIAN MESIN TERKUNCI (Perubahan #1, 24 Okt 2026)
 *
 * Aturan (disepakati dengan owner):
 *  - Urutan antrian = urutan KONFIRMASI BAYAR (pengering: urutan selesai cuci).
 *  - Begitu masuk antrian, order langsung dapat MESIN YANG DIJANJIKAN: mesin
 *    yang paling cepat kosong (memperhitungkan antrian yang sudah ada di mesin
 *    itu). Seri -> prioritas mesin lama (cycle terendah / pasangan dryer).
 *  - Mesin DIKUNCI: order tetap menunggu mesin itu walau mesin lain kosong
 *    duluan. Kasir bisa geser urutan di dalam 1 mesin (wajib alasan) saat
 *    mesin berstatus teralokasi (customer ditinggal pergi -> antrian macet).
 *  - Estimasi = sisa waktu mesin + total durasi order di depannya pada mesin
 *    yang sama (cuci = durasi layanan, kering = durasi paket masing-masing).
 *  - Tanpa buffer bongkar: kalau siklus sebelumnya sudah selesai tapi cucian
 *    belum dikeluarkan -> flag `siap_tunggu_bongkar` (bukan angka menit).
 *  - Mesin rusak/nonaktif -> tata ulang otomatis (yang sedang jalan di mesin
 *    itu masuk paling depan, diulang dari awal). Mesin aktif lagi -> tata
 *    ulang lagi.
 *  - HANYA berlaku untuk cabang `pemilihan_mesin = 'otomatis'`. Mode manual
 *    -> semua fungsi di sini no-op (perilaku lama).
 *
 * Penyimpanan: detail_transaksi.antrian_mesin_id / antrian_urutan /
 * antrian_masuk (lihat sql/2026-10-24_antrian_mesin_terkunci.sql). Baris yang
 * SUDAH dialokasikan (status alokasi_mesin_*) memakai detail_transaksi.mesin_id
 * seperti sebelumnya -- kolom antrian dikosongkan saat itu.
 *
 * Semua operasi yang MENGUBAH antrian 1 cabang diserialkan (lihat serial())
 * supaya 2 kasir / timer yang barengan tidak saling tabrak.
 * =============================================================================
 */

const db = require('../config/database');
const logger = require('../config/logger');
const { now } = require('../helpers/date');
const { buildStages, nextStatus } = require('../helpers/state-machine');
const { badRequest, conflict, notFound } = require('../helpers/errors');
const mesinModel = require('../models/mesin.model');
const cabangModel = require('../models/cabang.model');
const statusModel = require('../models/status-master.model');
const mesinLogManualModel = require('../models/mesin-log-manual.model');
const { ikonLayanan } = require('../helpers/layanan-ikon');

// subquery daftar kategori layanan 1 transaksi (alias t wajib ada di query)
const KAT_SQL = `(SELECT GROUP_CONCAT(DISTINCT lk.kategori) FROM detail_transaksi dk JOIN layanan lk ON lk.id = dk.layanan_id WHERE dk.transaksi_id = t.id)`;
// Perubahan #5: durasi paket kering transaksi (ditampilkan di ikon kering)
const KERING_SQL = `(SELECT MAX(lk2.durasi_menit) FROM detail_transaksi dk2 JOIN layanan lk2 ON lk2.id = dk2.layanan_id WHERE dk2.transaksi_id = t.id AND lk2.kategori = 'kering')`;

const TIPE = {
  washer: { kategori: 'cuci', alokasi: 'alokasi_mesin_cuci', mulai: 'mulai_cuci', label: 'cuci' },
  dryer: { kategori: 'kering', alokasi: 'alokasi_mesin_kering', mulai: 'mulai_kering', label: 'kering' },
};
const DEFAULT_DURASI = { washer: 36, dryer: 30 };
const TIPE_LIST = ['washer', 'dryer'];

/* ------------------------------------------------------------------ util */

function wibMs(str) {
  if (!str) return NaN;
  return new Date(String(str).replace(' ', 'T') + '+07:00').getTime();
}

/** Angka TERAKHIR di kode mesin ("ZL02-W05" -> 5). */
function angkaKode(kode) {
  const a = String(kode || '').match(/\d+/g);
  return a && a.length ? Number(a[a.length - 1]) : 0;
}

/** "ZL02-W05" -> "W5" (sama dengan pendekKode() di transaksi.service). */
function kodePendek(kode) {
  if (!kode) return kode;
  const parts = String(kode).split('-');
  const tail = parts.length > 1 ? parts.slice(1).join('-') : parts[0];
  const m = tail.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : tail;
}

/** "ZL02-K-101" -> "K-101" (buang kode cabang di depan). */
function keranjangPendek(kode) {
  if (!kode) return null;
  const parts = String(kode).split('-');
  // Perubahan #5: tanpa strip & tanpa kode cabang ("ZL02-K-114" -> "K114")
  return (parts.length > 1 ? parts.slice(1).join('') : String(kode)).replace(/-/g, '');
}

/** Berat dibulatkan sama seperti aturan input kasir/customer (Math.round, kg bulat). */
function beratBulat(b) {
  const n = Number(b);
  return b == null || b === '' || !(n > 0) ? null : Math.round(n);
}

function durasiOf(row, tipe) {
  const d = Number(row && (row.durasi_menit ?? row.durasi_target));
  return d > 0 ? d : DEFAULT_DURASI[tipe];
}

// Serialisasi per cabang -- satu antrian promise per cabang.
const kunci = new Map();
function serial(cabangId, fn) {
  const key = Number(cabangId);
  const prev = kunci.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  kunci.set(key, run.catch(() => {}));
  return run;
}

async function modeOtomatis(cabangId) {
  const c = await cabangModel.findById(cabangId).catch(() => null);
  return !!(c && c.pemilihan_mesin === 'otomatis');
}

/* ------------------------------------------------------------- queries */

/**
 * Baris jasa (cuci/kering) yang BERHAK antre: lunas, belum punya mesin, dan
 * status transaksinya tepat SEBELUM tahap alokasi mesin tipe ini.
 */
async function barisBerhak(cabangId, tipe) {
  const T = TIPE[tipe];
  const rows = await db.query(
    `SELECT dt.id AS detail_id, dt.transaksi_id, dt.antrian_mesin_id, dt.antrian_urutan, dt.antrian_masuk,
            t.berat_kg, t.tanggal, t.kode_antrian, t.no_invoice, t.pelanggan_id,
            sm.kode AS status_kode,
            p.nama AS nama_pelanggan, p.telepon,
            l.durasi_menit, l.nama_paket,
            (SELECT GROUP_CONCAT(DISTINCT l2.kategori) FROM detail_transaksi d2
               JOIN layanan l2 ON l2.id = d2.layanan_id WHERE d2.transaksi_id = t.id) AS kategori_list,
            ${KERING_SQL} AS durasi_kering,
            (SELECT MAX(sl.waktu) FROM transaksi_status_log sl
               WHERE sl.transaksi_id = t.id AND sl.status_id = t.status_terakhir_id) AS waktu_status
     FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id
     JOIN layanan l ON l.id = dt.layanan_id
     LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE t.cabang_id = ? AND (t.status_bayar = 'lunas' OR t.bayar_saat_ambil = 1) AND l.kategori = ?
       AND dt.mesin_id IS NULL AND COALESCE(t.ditahan, 0) = 0
     ORDER BY dt.id ASC`,
    [cabangId, T.kategori]
  );
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.transaksi_id)) return false; // 1 baris jasa per transaksi per kategori
    const kat = String(r.kategori_list || '').split(',').filter(Boolean);
    const ok = nextStatus(r.status_kode, kat) === T.alokasi;
    if (ok) seen.add(r.transaksi_id);
    return ok;
  });
}

/** Order yang SUDAH dialokasikan (status alokasi_*) tapi belum mulai. */
async function barisTeralokasi(cabangId, tipe) {
  const T = TIPE[tipe];
  return db.query(
    `SELECT dt.id AS detail_id, dt.transaksi_id, dt.mesin_id, dt.antrian_masuk,
            t.kode_antrian, t.no_invoice, t.pelanggan_id, sm.kode AS status_kode, ${KAT_SQL} AS kategori_list, ${KERING_SQL} AS durasi_kering, t.berat_kg,
            p.nama AS nama_pelanggan, p.telepon, l.durasi_menit, l.nama_paket
     FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id
     JOIN status_master sm ON sm.id = t.status_terakhir_id
     JOIN layanan l ON l.id = dt.layanan_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE t.cabang_id = ? AND dt.mesin_id IS NOT NULL AND l.kategori = ? AND sm.kode = ?`,
    [cabangId, T.kategori, T.alokasi]
  );
}

/** Sesi mesin yang sedang jalan (per cabang, tipe). */
async function barisJalan(cabangId, tipe) {
  return db.query(
    `SELECT u.mesin_id, u.detail_transaksi_id, u.transaksi_id, u.waktu_mulai,
            t.kode_antrian, t.no_invoice, p.nama AS nama_pelanggan, p.telepon,
            (SELECT sm2.kode FROM status_master sm2 WHERE sm2.id = t.status_terakhir_id) AS status_kode,
            ${KAT_SQL} AS kategori_list, ${KERING_SQL} AS durasi_kering, t.berat_kg,
            l.durasi_menit, l.nama_paket
     FROM mesin_usage u
     JOIN mesin m ON m.id = u.mesin_id
     JOIN transaksi t ON t.id = u.transaksi_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE m.cabang_id = ? AND m.tipe = ? AND u.waktu_selesai IS NULL`,
    [cabangId, tipe]
  );
}

/**
 * Pengguna SEBELUMNYA tiap mesin = sesi selesai terakhir (bukan transaksi yg
 * sedang jalan/teralokasi di mesin itu) + posisi prosesnya sekarang.
 */
async function penggunaSebelumnya(mesinId, kecualiTransaksiIds = []) {
  const rows = await db.query(
    `SELECT u.transaksi_id, u.waktu_mulai, u.waktu_selesai,
            t.kode_antrian, t.no_invoice, t.posisi_cucian_manual, t.status_bayar, t.bayar_saat_ambil,
            p.nama AS nama_pelanggan, p.telepon, sm.kode AS status_kode, sm.nama AS status_nama,
            ${KAT_SQL} AS kategori_list, ${KERING_SQL} AS durasi_kering, t.berat_kg,
            l.durasi_menit, l.nama_paket
     FROM mesin_usage u
     JOIN transaksi t ON t.id = u.transaksi_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id
     LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
     LEFT JOIN layanan l ON l.id = dt.layanan_id
     WHERE u.mesin_id = ? AND u.waktu_selesai IS NOT NULL
     ORDER BY u.waktu_selesai DESC, u.id DESC LIMIT 30`,
    [mesinId]
  );
  const ex = new Set(kecualiTransaksiIds.map(Number));
  return rows.find((r) => !ex.has(Number(r.transaksi_id))) || null;
}

/** Cucian pengguna sebelumnya (kemungkinan) masih ada di dalam mesin? */
function cucianMasihDiMesin(prev, tipe) {
  if (!prev) return false;
  if (prev.posisi_cucian_manual === 'keranjang') return false;
  if (tipe === 'washer') return ['selesai_cuci', 'alokasi_mesin_kering'].includes(prev.status_kode);
  return prev.status_kode === 'selesai_kering';
}

/* --------------------------------------------------------------- state */

/**
 * Bangun keadaan antrian semua mesin 1 tipe di 1 cabang:
 * per mesin: { mesin, jalan, teralokasi, antrian[], sebelumnya, bebasDalam }.
 * Waktu tunggu tiap order dihitung kumulatif per mesin.
 */
async function bangunState(cabangId, tipe, { denganSebelumnya = false } = {}) {
  const [mesinList, jalanRows, alokRows, berhak] = await Promise.all([
    mesinModel.findByCabang(cabangId, { tipe }),
    barisJalan(cabangId, tipe),
    barisTeralokasi(cabangId, tipe),
    barisBerhak(cabangId, tipe),
  ]);
  const nowMs = Date.now();
  const byId = new Map();
  for (const m of mesinList) {
    byId.set(Number(m.id), {
      mesin: m, aktif: ['aktif', 'jalan'].includes(m.status),
      jalan: null, teralokasi: null, antrian: [], sebelumnya: null, bebasDalam: 0, blokBongkar: false,
    });
  }
  for (const u of jalanRows) {
    const s = byId.get(Number(u.mesin_id)); if (!s) continue;
    const durasi = durasiOf(u, tipe);
    const lewat = Math.max(0, (nowMs - wibMs(u.waktu_mulai)) / 60000);
    s.jalan = { ...u, durasi, lewat_menit: Math.floor(lewat), sisa_menit: Math.max(0, Math.ceil(durasi - lewat)) };
  }
  for (const a of alokRows) {
    const s = byId.get(Number(a.mesin_id)); if (!s) continue;
    if (!s.teralokasi) s.teralokasi = { ...a, durasi: durasiOf(a, tipe) };
  }
  const antre = berhak.filter((r) => r.antrian_mesin_id != null)
    .sort((a, b) => (a.antrian_urutan ?? 0) - (b.antrian_urutan ?? 0)
      || wibMs(a.antrian_masuk) - wibMs(b.antrian_masuk) || a.detail_id - b.detail_id);
  for (const q of antre) {
    const s = byId.get(Number(q.antrian_mesin_id)); if (!s) continue;
    s.antrian.push({ ...q, durasi: durasiOf(q, tipe) });
  }

  // order yang sedang antre / teralokasi lagi (mis. tergusur mesin rusak)
  // bukan "pengguna sebelumnya" -- lewati.
  const masihAntre = [...berhak.map((r) => r.transaksi_id), ...alokRows.map((a) => a.transaksi_id)];
  if (denganSebelumnya) {
    await Promise.all([...byId.values()].map(async (s) => {
      const kecuali = [s.jalan && s.jalan.transaksi_id, ...masihAntre].filter(Boolean);
      s.sebelumnya = await penggunaSebelumnya(s.mesin.id, kecuali).catch(() => null);
    }));
  } else {
    // cukup untuk flag blokBongkar: hanya mesin yg kosong & ada antrian/teralokasi
    await Promise.all([...byId.values()].filter((s) => !s.jalan && (s.teralokasi || s.antrian.length)).map(async (s) => {
      s.sebelumnya = await penggunaSebelumnya(s.mesin.id, masihAntre).catch(() => null);
    }));
  }

  for (const s of byId.values()) hitungTunggu(s, tipe);
  let berpasangan = false;
  if (tipe === 'dryer') {
    const jmlWasher = (await mesinModel.findByCabang(cabangId, { tipe: 'washer' })).length;
    berpasangan = jmlWasher === mesinList.length;
  }
  return { tipe, mesin: [...byId.values()], berhak, berpasangan };
}

/** Isi waktu tunggu kumulatif untuk 1 mesin. */
function hitungTunggu(s, tipe) {
  let t = 0;
  let siap = false; // siklus sebelumnya sudah habis tapi mesin belum dikosongkan
  if (s.jalan) {
    t = s.jalan.sisa_menit;
    if (t <= 0) siap = true;
  } else if (cucianMasihDiMesin(s.sebelumnya, tipe)) {
    siap = true;
  }
  s.blokBongkar = siap;
  if (s.teralokasi) {
    s.teralokasi.tunggu_menit = t;
    s.teralokasi.siap_tunggu_bongkar = siap && t === 0;
    t += s.teralokasi.durasi;
    siap = false;
  }
  for (const q of s.antrian) {
    q.tunggu_menit = t;
    q.siap_tunggu_bongkar = siap && t === 0;
    t += q.durasi;
    siap = false;
  }
  s.bebasDalam = t;
}

/**
 * Tie-break kalau waktu kosong sama (aturan yang disepakati: nomor mesin
 * kecil duluan). Khusus pengering: kalau jumlah washer = dryer (berpasangan),
 * dryer pasangan washer asal (nomor sama / terdekat) didahulukan dulu --
 * mempertahankan aturan pairing lama -- baru nomor kecil.
 */
function urutPrioritas(list, tipe, kodeMesinAsal, berpasangan = false) {
  // Perubahan #22: SAMA PERSIS dengan aturan asli (mesin.service.pilihOtomatis
  // di hosting) -- sempat diganti "nomor kecil" di Perubahan #1 (regresi).
  //  - washer : cycle terendah -> nomor kecil
  //  - dryer  : (berpasangan & ada washer asal) tepat di atas washer asal ->
  //             terdekat -> cycle terendah -> nomor kecil; selain itu cycle terendah.
  const asal = kodeMesinAsal ? angkaKode(kodeMesinAsal) : null;
  const cyc = (s) => Number(s.mesin.total_cycle) || 0;
  return [...list].sort((a, b) => {
    const na = angkaKode(a.mesin.kode_mesin);
    const nb = angkaKode(b.mesin.kode_mesin);
    if (tipe === 'dryer' && berpasangan && asal != null) {
      const da = Math.abs(na - asal);
      const db_ = Math.abs(nb - asal);
      if (da !== db_) return da - db_;
    }
    if (cyc(a) !== cyc(b)) return cyc(a) - cyc(b);
    return na - nb;
  });
}

/** Pilih mesin untuk order baru: paling cepat kosong; seri -> prioritas. */
function pilihMesin(state, { beratKg = null, kodeMesinAsal = null } = {}) {
  let kandidat = state.mesin.filter((s) => s.aktif);
  if (beratKg != null) {
    const muat = kandidat.filter((s) => s.mesin.kapasitas_kg == null || Number(s.mesin.kapasitas_kg) >= Number(beratKg));
    if (muat.length) kandidat = muat;
  }
  if (!kandidat.length) return null;
  kandidat = urutPrioritas(kandidat, state.tipe, kodeMesinAsal, state.berpasangan);
  // stable sort -> seri tetap ikut urutan prioritas
  kandidat.sort((a, b) => a.bebasDalam - b.bebasDalam);
  return kandidat[0];
}

async function kodeMesinCuciTransaksi(transaksiId) {
  const r = await db.queryOne(
    `SELECT m.kode_mesin FROM detail_transaksi dt
     JOIN layanan l ON l.id = dt.layanan_id JOIN mesin m ON m.id = dt.mesin_id
     WHERE dt.transaksi_id = ? AND l.kategori = 'cuci' LIMIT 1`, [transaksiId]);
  return r ? r.kode_mesin : null;
}

/* ------------------------------------------------------------ mutators */

/** Kosongkan antrian semua baris 1 cabang (mode manual). */
async function kosongkanCabang(cabangId) {
  await db.query(
    `UPDATE detail_transaksi dt JOIN transaksi t ON t.id = dt.transaksi_id
     SET dt.antrian_mesin_id = NULL, dt.antrian_urutan = NULL
     WHERE t.cabang_id = ? AND dt.antrian_mesin_id IS NOT NULL`, [cabangId]);
}

/**
 * Sinkron 1 tipe: buang entri basi, masukkan order berhak yang belum punya
 * mesin janji (urut waktu masuk = waktu status terakhirnya, mis. konfirmasi
 * bayar / selesai cuci), dan pindahkan entri dari mesin yang tidak aktif.
 * @returns {boolean} true kalau mesin tidak aktif sempat punya antrian (perlu tata ulang)
 */
async function sinkronTipe(cabangId, tipe) {
  const T = TIPE[tipe];
  // 1) bersihkan entri yang sudah tidak berhak (status maju, dialokasikan manual, dll)
  const berhak = await barisBerhak(cabangId, tipe);
  const idBerhak = new Set(berhak.map((r) => r.detail_id));
  const lama = await db.query(
    `SELECT dt.id FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id JOIN layanan l ON l.id = dt.layanan_id
     WHERE t.cabang_id = ? AND l.kategori = ? AND dt.antrian_mesin_id IS NOT NULL`, [cabangId, T.kategori]);
  const basi = lama.map((r) => r.id).filter((id) => !idBerhak.has(id));
  if (basi.length) {
    await db.query(`UPDATE detail_transaksi SET antrian_mesin_id = NULL, antrian_urutan = NULL
                    WHERE id IN (${basi.map(() => '?').join(',')})`, basi);
  }

  // 2) entri yang terkunci ke mesin tidak aktif -> lepas (masuk ulang di bawah)
  const mesinList = await mesinModel.findByCabang(cabangId, { tipe });
  const aktifIds = new Set(mesinList.filter((m) => ['aktif', 'jalan'].includes(m.status)).map((m) => Number(m.id)));
  const nyasar = berhak.filter((r) => r.antrian_mesin_id != null && !aktifIds.has(Number(r.antrian_mesin_id)));
  for (const r of nyasar) {
    await db.query(`UPDATE detail_transaksi SET antrian_mesin_id = NULL, antrian_urutan = NULL WHERE id = ?`, [r.detail_id]);
  }

  // 3) masukkan yang belum punya mesin janji
  const baru = (await barisBerhak(cabangId, tipe)).filter((r) => r.antrian_mesin_id == null);
  if (!baru.length) return;
  const masukOf = (r) => r.antrian_masuk || r.waktu_status || r.tanggal;
  baru.sort((a, b) => wibMs(masukOf(a)) - wibMs(masukOf(b)) || a.detail_id - b.detail_id);
  await masukkan(cabangId, tipe, baru, masukOf);
}

/** Masukkan daftar baris ke antrian, urut sesuai array (greedy waktu kosong tercepat). */
async function masukkan(cabangId, tipe, baris, masukOf) {
  const state = await bangunState(cabangId, tipe);
  const maxUrut = new Map();
  for (const s of state.mesin) {
    maxUrut.set(Number(s.mesin.id), s.antrian.reduce((mx, q) => Math.max(mx, Number(q.antrian_urutan) || 0), 0));
  }
  for (const r of baris) {
    const kodeAsal = tipe === 'dryer' ? await kodeMesinCuciTransaksi(r.transaksi_id) : null;
    const s = pilihMesin(state, { beratKg: r.berat_kg, kodeMesinAsal: kodeAsal });
    if (!s) { logger.info('Antrian: tidak ada mesin aktif', { cabangId, tipe, transaksiId: r.transaksi_id }); continue; }
    const id = Number(s.mesin.id);
    const urut = (maxUrut.get(id) || 0) + 1;
    maxUrut.set(id, urut);
    await db.query(
      `UPDATE detail_transaksi SET antrian_mesin_id = ?, antrian_urutan = ?, antrian_masuk = COALESCE(antrian_masuk, ?) WHERE id = ?`,
      [id, urut, masukOf(r), r.detail_id]
    );
    const dur = durasiOf(r, tipe);
    s.antrian.push({ ...r, antrian_mesin_id: id, antrian_urutan: urut, durasi: dur });
    s.bebasDalam += dur;
  }
}

/**
 * Alokasikan langsung (tanpa lewat pindahStatus) -- dipakai sistem saat mesin
 * janji sudah bebas. Efek status alokasi_* memang cuma "set mesin_id", jadi
 * cukup: lock mesin, cek masih bebas, set mesin + status + log.
 */
async function alokasiLangsung(conn, { transaksiId, detailId, mesinId, tipe, keterangan = null, karyawanId = null }) {
  const T = TIPE[tipe];
  const [mRows] = await conn.execute(`SELECT id, status, kode_mesin FROM mesin WHERE id = ? FOR UPDATE`, [mesinId]);
  const m = mRows[0];
  if (!m || m.status !== 'aktif') return false;
  const [res] = await conn.execute(
    `SELECT COUNT(*) AS n FROM detail_transaksi dt
     JOIN transaksi t ON t.id = dt.transaksi_id JOIN status_master sm ON sm.id = t.status_terakhir_id
     JOIN layanan l ON l.id = dt.layanan_id
     WHERE dt.mesin_id = ? AND l.kategori = ? AND sm.kode = ?`, [mesinId, T.kategori, T.alokasi]);
  if (Number(res[0].n) > 0) return false;
  const [tRows] = await conn.execute(
    `SELECT t.id, sm.kode AS status_kode,
       (SELECT GROUP_CONCAT(DISTINCT l2.kategori) FROM detail_transaksi d2 JOIN layanan l2 ON l2.id = d2.layanan_id WHERE d2.transaksi_id = t.id) AS kategori_list
     FROM transaksi t LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id WHERE t.id = ? FOR UPDATE`, [transaksiId]);
  const t = tRows[0];
  if (!t) return false;
  const kat = String(t.kategori_list || '').split(',').filter(Boolean);
  if (nextStatus(t.status_kode, kat) !== T.alokasi) return false;
  const st = await statusModel.findByKode(T.alokasi);
  await conn.execute(`UPDATE detail_transaksi SET mesin_id = ?, antrian_mesin_id = NULL, antrian_urutan = NULL WHERE id = ?`, [mesinId, detailId]);
  await conn.execute(`UPDATE transaksi SET status_terakhir_id = ? WHERE id = ?`, [st.id, transaksiId]);
  await conn.execute(
    `INSERT INTO transaksi_status_log (transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan) VALUES (?,?,?,?,?,?)`,
    [transaksiId, st.id, karyawanId, mesinId, now(), keterangan]);
  return true;
}

/** Mesin janji yang sudah bebas -> alokasikan kepala antriannya. */
async function prosesAlokasi(cabangId, tipe) {
  const state = await bangunState(cabangId, tipe);
  for (const s of state.mesin) {
    if (s.mesin.status !== 'aktif' || s.jalan || s.teralokasi || !s.antrian.length) continue;
    const kepala = s.antrian[0];
    try {
      const ok = await db.transaction((conn) => alokasiLangsung(conn, {
        transaksiId: kepala.transaksi_id, detailId: kepala.detail_id, mesinId: s.mesin.id, tipe,
      }));
      if (ok) logger.info('Antrian: alokasi otomatis ke mesin janji', { transaksiId: kepala.transaksi_id, mesin: s.mesin.kode_mesin });
    } catch (e) {
      logger.error('Antrian: alokasi otomatis gagal', { transaksiId: kepala.transaksi_id, err: e.message });
    }
  }
}

/**
 * Kembalikan 1 transaksi ke status SEBELUM alokasi mesin tipe ini (dipakai
 * saat mesin rusak / kasir mendahulukan order lain). conn WAJIB.
 */
async function kembalikanKeAntrian(conn, { transaksiId, detailId, tipe, mesinIdAntrian = null, urutan = null, keterangan, karyawanId = null }) {
  const T = TIPE[tipe];
  const [tRows] = await conn.execute(
    `SELECT (SELECT GROUP_CONCAT(DISTINCT l2.kategori) FROM detail_transaksi d2 JOIN layanan l2 ON l2.id = d2.layanan_id WHERE d2.transaksi_id = ?) AS kategori_list`,
    [transaksiId]);
  const kat = String((tRows[0] && tRows[0].kategori_list) || '').split(',').filter(Boolean);
  const stages = buildStages(kat);
  const idx = stages.indexOf(T.alokasi);
  const sebelum = idx > 0 ? stages[idx - 1] : 'sudah_bayar';
  const st = await statusModel.findByKode(sebelum);
  await conn.execute(
    `UPDATE detail_transaksi SET mesin_id = NULL, antrian_mesin_id = ?, antrian_urutan = ?,
       antrian_masuk = COALESCE(antrian_masuk, ?) WHERE id = ?`,
    [mesinIdAntrian, urutan, now(), detailId]);
  await conn.execute(`UPDATE transaksi SET status_terakhir_id = ? WHERE id = ?`, [st.id, transaksiId]);
  await conn.execute(
    `INSERT INTO transaksi_status_log (transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan) VALUES (?,?,?,?,?,?)`,
    [transaksiId, st.id, karyawanId, null, now(), keterangan]);
}

/** Tata ulang semua order yang belum mulai (antre) 1 tipe; `prioritas` duluan. */
async function tataUlangTipe(cabangId, tipe, prioritasTransaksiIds = []) {
  const berhak = await barisBerhak(cabangId, tipe);
  if (!berhak.length) return;
  const ids = berhak.map((r) => r.detail_id);
  await db.query(`UPDATE detail_transaksi SET antrian_mesin_id = NULL, antrian_urutan = NULL
                  WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const pri = new Set(prioritasTransaksiIds.map(Number));
  const masukOf = (r) => r.antrian_masuk || r.waktu_status || r.tanggal;
  const urut = berhak.map((r) => ({ ...r, antrian_mesin_id: null }))
    .sort((a, b) => (pri.has(Number(b.transaksi_id)) - pri.has(Number(a.transaksi_id)))
      || wibMs(masukOf(a)) - wibMs(masukOf(b)) || a.detail_id - b.detail_id);
  await masukkan(cabangId, tipe, urut, masukOf);
}

/* ------------------------------------------------------------- public */

/**
 * Sinkron + alokasi semua tipe 1 cabang. Aman dipanggil kapan saja (idempotent).
 * Dipanggil setelah bayar, setiap pindah status, ganti mesin, ubah status
 * mesin, dan saat dashboard dimuat.
 */
function refresh(cabangId) {
  return serial(cabangId, async () => {
    if (!(await modeOtomatis(cabangId))) { await kosongkanCabang(cabangId); return; }
    for (const tipe of TIPE_LIST) {
      await sinkronTipe(cabangId, tipe);
      await prosesAlokasi(cabangId, tipe);
    }
  }).catch((e) => { logger.error('Antrian refresh gagal', { cabangId, err: e.message }); });
}

/**
 * Status mesin diubah manager. Rusak (maintenance/nonaktif): order yang
 * sedang jalan di mesin itu dikeluarkan & ditaruh PALING DEPAN (diulang dari
 * awal), yang teralokasi di mesin itu dikembalikan ke antrian, lalu semua
 * antrian tipe ini ditata ulang. Aktif lagi: tata ulang.
 */
function mesinBerubahStatus(mesin, statusBaru) {
  return serial(mesin.cabang_id, async () => {
    if (!(await modeOtomatis(mesin.cabang_id))) return;
    if (!TIPE[mesin.tipe]) return;
    const tipe = mesin.tipe;
    const prioritas = [];
    if (statusBaru === 'maintenance' || statusBaru === 'nonaktif') {
      const transaksiService = require('./transaksi.service');
      const jalan = (await barisJalan(mesin.cabang_id, tipe)).filter((u) => Number(u.mesin_id) === Number(mesin.id));
      for (const u of jalan) {
        transaksiService._cancelTimer(u.transaksi_id, tipe);
        await db.transaction(async (conn) => {
          await conn.execute(`UPDATE mesin_usage SET waktu_selesai = ? WHERE mesin_id = ? AND transaksi_id = ? AND waktu_selesai IS NULL`,
            [now(), mesin.id, u.transaksi_id]);
          await kembalikanKeAntrian(conn, {
            transaksiId: u.transaksi_id, detailId: u.detail_transaksi_id, tipe,
            keterangan: `Mesin ${kodePendek(mesin.kode_mesin)} ${statusBaru} -- proses diulang dari awal di mesin lain`,
          });
          // antrian_masuk sengaja TIDAK direset -> tetap paling awal
        });
        prioritas.push(u.transaksi_id);
      }
      const alok = (await barisTeralokasi(mesin.cabang_id, tipe)).filter((a) => Number(a.mesin_id) === Number(mesin.id));
      for (const a of alok) {
        await db.transaction((conn) => kembalikanKeAntrian(conn, {
          transaksiId: a.transaksi_id, detailId: a.detail_id, tipe,
          keterangan: `Mesin ${kodePendek(mesin.kode_mesin)} ${statusBaru} -- dialokasikan ulang`,
        }));
        prioritas.push(a.transaksi_id);
      }
    }
    await tataUlangTipe(mesin.cabang_id, tipe, prioritas);
    await prosesAlokasi(mesin.cabang_id, tipe);
  });
}

/**
 * Kasir geser urutan antrian 1 mesin (naik/turun 1 posisi). Hanya saat mesin
 * TERALOKASI (ada order teralokasi, belum mulai). Alasan wajib.
 */
function geserAntrian(mesinId, { transaksiId, arah, alasan, karyawanId, cabangId }) {
  if (!alasan || !String(alasan).trim()) return Promise.reject(badRequest('Alasan wajib diisi'));
  if (!['naik', 'turun'].includes(arah)) return Promise.reject(badRequest('Arah harus "naik" atau "turun"'));
  return (async () => {
    const mesin = await mesinModel.findById(mesinId);
    if (!mesin) throw notFound('Mesin tidak ditemukan');
    if (cabangId && Number(mesin.cabang_id) !== Number(cabangId)) throw conflict('Mesin bukan milik cabang ini');
    if (!TIPE[mesin.tipe]) throw badRequest('Mesin ini tidak punya antrian');
    return serial(mesin.cabang_id, async () => {
      const tipe = mesin.tipe;
      const state = await bangunState(mesin.cabang_id, tipe);
      const s = state.mesin.find((x) => Number(x.mesin.id) === Number(mesinId));
      if (!s || !s.teralokasi || s.jalan) throw conflict('Urutan antrian hanya bisa diubah saat mesin berstatus teralokasi');
      const list = [{ ...s.teralokasi, _alok: true }, ...s.antrian];
      const i = list.findIndex((x) => Number(x.transaksi_id) === Number(transaksiId));
      if (i < 0) throw notFound('Transaksi tidak ada di antrian mesin ini');
      const j = arah === 'naik' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) throw conflict(arah === 'naik' ? 'Sudah paling atas' : 'Sudah paling bawah');
      const a = list[Math.min(i, j)];
      const b = list[Math.max(i, j)];
      const ket = `Urutan antrian diubah kasir: ${String(alasan).trim()}`;
      await db.transaction(async (conn) => {
        if (a._alok) {
          // b (antrian 1) naik jadi SEKARANG, a (teralokasi) turun ke posisi b
          await kembalikanKeAntrian(conn, {
            transaksiId: a.transaksi_id, detailId: a.detail_id, tipe,
            mesinIdAntrian: mesin.id, urutan: b.antrian_urutan, keterangan: ket, karyawanId,
          });
          const ok = await alokasiLangsung(conn, {
            transaksiId: b.transaksi_id, detailId: b.detail_id, mesinId: mesin.id, tipe, keterangan: ket, karyawanId,
          });
          if (!ok) throw conflict('Gagal mendahulukan order ini, coba muat ulang');
        } else {
          await conn.execute(`UPDATE detail_transaksi SET antrian_urutan = ? WHERE id = ?`, [b.antrian_urutan, a.detail_id]);
          await conn.execute(`UPDATE detail_transaksi SET antrian_urutan = ? WHERE id = ?`, [a.antrian_urutan, b.detail_id]);
        }
        await mesinLogManualModel.create({
          mesinId: mesin.id, jenisAksi: 'ubah_antrian', transaksiId: Number(transaksiId), command: arah,
          alasan: String(alasan).trim(), karyawanId, cabangId: mesin.cabang_id,
        }, conn);
      });
      const lain = Number(list[j].transaksi_id);
      return { mesin_id: mesin.id, transaksi_id: Number(transaksiId), arah, _lain: lain, _tipe: tipe };
    });
  })().then(async (h) => {
    // Perubahan #36: 2 shortcut WA (order yang digeser & order yang bertukar posisi)
    const naik = h.arah === 'naik' ? h.transaksi_id : h._lain;
    const turun = h.arah === 'naik' ? h._lain : h.transaksi_id;
    const wa = await pesanTerdampak(cabangId || (await mesinModel.findById(mesinId)).cabang_id, h._tipe, [
      { transaksi_id: h.transaksi_id, peran: h.arah === 'naik' ? 'naik' : 'turun', sebab: h.arah === 'naik' ? 'maju' : 'turun' },
      { transaksi_id: h.transaksi_id === naik ? turun : naik, peran: h.transaksi_id === naik ? 'turun' : 'naik', sebab: h.transaksi_id === naik ? 'turun' : 'maju' },
    ]).catch(() => []);
    return { mesin_id: h.mesin_id, transaksi_id: h.transaksi_id, arah: h.arah, wa };
  });
}

/** Info antrian 1 transaksi (untuk next_action / customer / WA). null kalau tidak antre. */
async function infoTransaksi(cabangId, transaksiId, tipe) {
  if (!(await modeOtomatis(cabangId))) return null;
  const state = await bangunState(cabangId, tipe);
  for (const s of state.mesin) {
    const idx = s.antrian.findIndex((q) => Number(q.transaksi_id) === Number(transaksiId));
    if (idx >= 0) {
      const q = s.antrian[idx];
      return {
        mesin_id: s.mesin.id, kode_mesin: s.mesin.kode_mesin, kode_mesin_pendek: kodePendek(s.mesin.kode_mesin),
        posisi: idx + 1 + (s.teralokasi ? 1 : 0), antrian_ke: idx + 1, tunggu_menit: q.tunggu_menit, siap_tunggu_bongkar: !!q.siap_tunggu_bongkar,
      };
    }
    if (s.teralokasi && Number(s.teralokasi.transaksi_id) === Number(transaksiId)) {
      return {
        mesin_id: s.mesin.id, kode_mesin: s.mesin.kode_mesin, kode_mesin_pendek: kodePendek(s.mesin.kode_mesin),
        posisi: 0, teralokasi: true, tunggu_menit: 0, siap_tunggu_bongkar: !!s.teralokasi.siap_tunggu_bongkar,
      };
    }
  }
  return null;
}

/** Estimasi menit sampai ada mesin tipe ini bebas untuk order BARU (customer). */
async function etaOrderBaru(cabangId, tipe) {
  if (!(await modeOtomatis(cabangId))) return null;
  const state = await bangunState(cabangId, tipe);
  const s = pilihMesin(state, {});
  return s ? s.bebasDalam : null;
}

/** Daftar antrian (FIFO per mesin) 1 tipe -- dipakai endpoint /transaksi/antrian. */
async function daftar(cabangId, tipe) {
  const state = await bangunState(cabangId, tipe);
  const out = [];
  for (const s of state.mesin) {
    s.antrian.forEach((q, i) => out.push({
      transaksi_id: q.transaksi_id, no_invoice: q.no_invoice, tanggal: q.tanggal, pelanggan_id: q.pelanggan_id,
      nama_pelanggan: q.nama_pelanggan, kode_keranjang: keranjangPendek(q.kode_antrian),
      mesin_id: s.mesin.id, kode_mesin: s.mesin.kode_mesin, posisi: i + 1,
      tunggu_menit: q.tunggu_menit, siap_tunggu_bongkar: !!q.siap_tunggu_bongkar,
      antrian_masuk: q.antrian_masuk,
    }));
  }
  return out.sort((a, b) => wibMs(a.antrian_masuk) - wibMs(b.antrian_masuk));
}

/* ---------------------------------------- Perubahan #49: hold (tahan) */
const STATUS_BOLEH_TAHAN = ['sudah_bayar', 'selesai_jemput', 'alokasi_mesin_cuci', 'selesai_cuci', 'alokasi_mesin_kering'];

/**
 * Owner menahan / melepas transaksi lunas dari antrian mesin.
 *  tahan : keluar dari antrian; kalau sedang teralokasi, mesin langsung
 *          diberikan ke antrian berikutnya.
 *  lepas : masuk lagi di antrian PALING BELAKANG (waktu masuk = sekarang).
 */
function tahanTransaksi(transaksiId, { tahan, alasan, karyawanId }) {
  return (async () => {
    const t = await db.queryOne(
      `SELECT t.id, t.cabang_id, t.no_invoice, t.status_bayar, t.bayar_saat_ambil, t.ditahan, sm.kode AS status_kode, t.status_terakhir_id
         FROM transaksi t LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id WHERE t.id = ?`, [transaksiId]);
    if (!t) throw notFound('Transaksi tidak ditemukan');
    const ket = String(alasan || '').trim();
    if (tahan && !ket) throw badRequest('Alasan wajib diisi');
    if (tahan && Number(t.ditahan)) throw conflict('Pesanan ini sudah ditahan');
    if (!tahan && !Number(t.ditahan)) throw conflict('Pesanan ini tidak sedang ditahan');
    if (tahan) {
      if (t.status_bayar !== 'lunas' && !Number(t.bayar_saat_ambil)) throw conflict('Hanya pesanan yang sudah bayar yang bisa ditahan');
      if (!STATUS_BOLEH_TAHAN.includes(t.status_kode)) throw conflict('Hanya pesanan yang sedang menunggu mesin yang bisa ditahan');
      const jalan = await db.queryOne('SELECT id FROM mesin_usage WHERE transaksi_id = ? AND waktu_selesai IS NULL LIMIT 1', [transaksiId]);
      if (jalan) throw conflict('Mesin sedang berjalan untuk pesanan ini');
    }
    await serial(t.cabang_id, () => db.transaction(async (conn) => {
      if (tahan) {
        const tipe = t.status_kode === 'alokasi_mesin_cuci' ? 'washer' : t.status_kode === 'alokasi_mesin_kering' ? 'dryer' : null;
        if (tipe) {
          const [d] = await conn.execute(
            `SELECT dt.id FROM detail_transaksi dt JOIN layanan l ON l.id = dt.layanan_id
              WHERE dt.transaksi_id = ? AND l.kategori = ? AND dt.mesin_id IS NOT NULL LIMIT 1`, [transaksiId, TIPE[tipe].kategori]);
          if (d[0]) await kembalikanKeAntrian(conn, { transaksiId, detailId: d[0].id, tipe, keterangan: `Ditahan owner: ${ket}`.slice(0, 255), karyawanId });
        }
        await conn.execute(`UPDATE detail_transaksi SET antrian_mesin_id = NULL, antrian_urutan = NULL, antrian_masuk = NULL WHERE transaksi_id = ? AND mesin_id IS NULL`, [transaksiId]);
        await conn.execute(`UPDATE transaksi SET ditahan = 1, ditahan_at = ?, ditahan_alasan = ?, ditahan_oleh = ? WHERE id = ?`, [now(), ket.slice(0, 255), karyawanId, transaksiId]);
      } else {
        await conn.execute(`UPDATE detail_transaksi SET antrian_mesin_id = NULL, antrian_urutan = NULL, antrian_masuk = ? WHERE transaksi_id = ? AND mesin_id IS NULL`, [now(), transaksiId]);
        await conn.execute(`UPDATE transaksi SET ditahan = 0, ditahan_at = NULL, ditahan_alasan = NULL, ditahan_oleh = NULL WHERE id = ?`, [transaksiId]);
      }
      const [st] = await conn.execute('SELECT status_terakhir_id FROM transaksi WHERE id = ?', [transaksiId]);
      await conn.execute(
        `INSERT INTO transaksi_status_log (transaksi_id, status_id, karyawan_id, mesin_id, waktu, keterangan) VALUES (?,?,?,?,?,?)`,
        [transaksiId, st[0].status_terakhir_id, karyawanId, null, now(),
          (tahan ? `Ditahan owner (keluar antrian): ${ket}` : `Hold dilepas owner, masuk antrian paling belakang${ket ? `: ${ket}` : ''}`).slice(0, 255)]);
    }));
    await refresh(t.cabang_id);
    return { transaksi_id: Number(transaksiId), ditahan: !!tahan };
  })();
}

/* ---------------------------------------- Perubahan #20: pindah mesin */

/** Ringkasan kondisi 1 mesin untuk pilihan pindah. */
function kondisiMesin(s) {
  const kode = kodePendek(s.mesin.kode_mesin);
  if (!s.aktif) return { kondisi: 'nonaktif', teks: `${kode} · tidak aktif` };
  const n = s.antrian.length;
  if (s.jalan) return { kondisi: 'jalan', teks: `${kode} · jalan, sisa ± ${s.jalan.sisa_menit} mnt${n ? ` · ${n} antrian` : ''}` };
  if (s.teralokasi) return { kondisi: 'teralokasi', teks: `${kode} · teralokasi ${s.teralokasi.nama_pelanggan || ''}${n ? ` · ${n} antrian` : ''}`.trim() };
  if (s.blokBongkar) return { kondisi: 'kosong', teks: `${kode} · kosong (cucian sebelumnya belum dikeluarkan)` };
  return { kondisi: 'kosong', teks: `${kode} · kosong — langsung siap` };
}

/** Cari posisi order (antre / teralokasi) di state 1 tipe. */
function cariOrder(state, transaksiId) {
  for (const s of state.mesin) {
    if (s.teralokasi && Number(s.teralokasi.transaksi_id) === Number(transaksiId)) return { s, entri: s.teralokasi, teralokasi: true };
    const q = s.antrian.find((x) => Number(x.transaksi_id) === Number(transaksiId));
    if (q) return { s, entri: q, teralokasi: false };
  }
  return null;
}

async function tipeOrder(cabangId, transaksiId) {
  for (const tipe of TIPE_LIST) {
    const state = await bangunState(cabangId, tipe);
    if (cariOrder(state, transaksiId)) return { tipe, state };
  }
  return null;
}

/** Pilihan mesin tujuan untuk 1 order yang sedang antre/teralokasi. */
async function opsiPindah(cabangId, transaksiId) {
  if (!(await modeOtomatis(cabangId))) throw conflict('Pindah mesin hanya untuk cabang mode antrian otomatis');
  const ada = await tipeOrder(cabangId, transaksiId);
  if (!ada) throw conflict('Order ini tidak sedang antre / teralokasi di mesin');
  const { tipe, state } = ada;
  const asal = cariOrder(state, transaksiId);
  const opsi = state.mesin
    .filter((s) => Number(s.mesin.id) !== Number(asal.s.mesin.id) && s.aktif)
    // paling cepat bisa dipakai dulu: kosong / teralokasi (bisa didahului) -> jalan sisa terkecil
    .sort((a, b) => ((a.jalan ? a.jalan.sisa_menit : 0) - (b.jalan ? b.jalan.sisa_menit : 0))
      || a.bebasDalam - b.bebasDalam || angkaKode(a.mesin.kode_mesin) - angkaKode(b.mesin.kode_mesin))
    .map(barisOpsi);
  // Perubahan #38: SEMUA mesin tipe ini, urut kode (kartu horizontal di kasir)
  const semua = [...state.mesin]
    .sort((a, b) => angkaKode(a.mesin.kode_mesin) - angkaKode(b.mesin.kode_mesin))
    .map((s) => {
      const r = barisOpsi(s);
      if (Number(s.mesin.id) === Number(asal.s.mesin.id)) r.asal = true;
      if (!s.aktif) r.kondisi = s.mesin.status === 'maintenance' ? 'maintenance' : 'nonaktif';
      return r;
    });
  return {
    tipe, transaksi_id: Number(transaksiId),
    asal: { mesin_id: asal.s.mesin.id, kode_pendek: kodePendek(asal.s.mesin.kode_mesin), tunggu_menit: asal.teralokasi ? 0 : Math.round(asal.entri.tunggu_menit || 0), teralokasi: asal.teralokasi },
    nama: asal.entri.nama_pelanggan, opsi, semua,
  };
}

function barisOpsi(s) {
  const k = kondisiMesin(s);
  const sisaJalan = s.jalan ? s.jalan.sisa_menit : 0;
  return {
    mesin_id: s.mesin.id, kode_pendek: kodePendek(s.mesin.kode_mesin), ...k,
    // estimasi mulai kalau dipindah: paling depan / paling belakang
    tunggu_depan: s.jalan ? sisaJalan : 0,
    tunggu_belakang: Math.max(0, Math.round(s.bebasDalam)),
    ada_teralokasi: !!s.teralokasi && !s.jalan,
    nama_teralokasi: s.teralokasi ? s.teralokasi.nama_pelanggan : null,
    sisa_menit: s.jalan ? sisaJalan : null,
    jml_antrian: s.antrian.length,
    blok_bongkar: !!s.blokBongkar,
  };
}

/** Order yang antre / teralokasi di mesin LAIN yang bisa diambil mesin ini. */
async function kandidatAmbil(mesinId, cabangId) {
  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && Number(mesin.cabang_id) !== Number(cabangId)) throw conflict('Mesin bukan milik cabang ini');
  if (!TIPE[mesin.tipe]) throw badRequest('Mesin ini tidak punya antrian');
  if (!(await modeOtomatis(mesin.cabang_id))) throw conflict('Hanya untuk cabang mode antrian otomatis');
  const state = await bangunState(mesin.cabang_id, mesin.tipe);
  const out = [];
  for (const s of state.mesin) {
    if (Number(s.mesin.id) === Number(mesinId)) continue;
    const rows = [...(s.teralokasi && !s.jalan ? [{ ...s.teralokasi, _alok: true }] : []), ...s.antrian];
    rows.forEach((q, i) => out.push({
      transaksi_id: q.transaksi_id, nama: q.nama_pelanggan, kode_keranjang: keranjangPendek(q.kode_antrian),
      berat: beratBulat(q.berat_kg), mesin_asal: kodePendek(s.mesin.kode_mesin),
      posisi: q._alok ? 'teralokasi' : `antrian ${s.teralokasi && !s.jalan ? i : i + 1}`,
      tunggu_menit: q._alok ? 0 : Math.round(q.tunggu_menit || 0), masuk: q.antrian_masuk || q.waktu_status || q.tanggal,
      paket: mesin.tipe === 'dryer' ? (q.nama_paket || null) : null,
    }));
  }
  out.sort((a, b) => wibMs(a.masuk) - wibMs(b.masuk));
  const sini = state.mesin.find((x) => Number(x.mesin.id) === Number(mesinId));
  return { mesin: { id: mesin.id, kode_pendek: kodePendek(mesin.kode_mesin), tipe: mesin.tipe }, kondisi: sini ? kondisiMesin(sini) : null, kandidat: out };
}

/**
 * Pindahkan order (antre / teralokasi) ke mesin lain sejenis.
 *  posisi 'depan'   : jadi giliran berikutnya di mesin tujuan. Mesin tujuan
 *                     kosong -> langsung teralokasi; kalau mesin tujuan
 *                     sedang teralokasi order lain (pelanggan belum datang),
 *                     order itu mundur jadi antrian 1.
 *  posisi 'belakang': paling belakang antrian mesin tujuan.
 * Alasan wajib (tercatat log mesin). Antrian mesin asal maju otomatis.
 */
function pindahMesin(transaksiId, { mesinTujuanId, posisi = 'depan', alasan, karyawanId, cabangId }) {
  if (!alasan || !String(alasan).trim()) return Promise.reject(badRequest('Alasan wajib diisi'));
  if (!['depan', 'belakang'].includes(posisi)) return Promise.reject(badRequest('Posisi harus "depan" atau "belakang"'));
  return (async () => {
    const tujuan = await mesinModel.findById(mesinTujuanId);
    if (!tujuan) throw notFound('Mesin tujuan tidak ditemukan');
    if (cabangId && Number(tujuan.cabang_id) !== Number(cabangId)) throw conflict('Mesin bukan milik cabang ini');
    if (!(await modeOtomatis(tujuan.cabang_id))) throw conflict('Pindah mesin hanya untuk cabang mode antrian otomatis');
    const hasil = await serial(tujuan.cabang_id, async () => {
      const tipe = tujuan.tipe;
      if (!TIPE[tipe]) throw badRequest('Mesin ini tidak punya antrian');
      const state = await bangunState(tujuan.cabang_id, tipe);
      const asal = cariOrder(state, transaksiId);
      if (!asal) throw conflict('Order ini tidak sedang antre / teralokasi di mesin ' + (tipe === 'dryer' ? 'kering' : 'cuci'));
      const t = state.mesin.find((x) => Number(x.mesin.id) === Number(mesinTujuanId));
      if (!t || !t.aktif) throw conflict('Mesin tujuan sedang tidak aktif');
      if (Number(asal.s.mesin.id) === Number(mesinTujuanId)) throw conflict('Order sudah di mesin ini');

      const urutList = t.antrian.map((q) => Number(q.antrian_urutan) || 0);
      const minU = urutList.length ? Math.min(...urutList) : 1;
      const maxU = urutList.length ? Math.max(...urutList) : 0;
      const kodeAsal = kodePendek(asal.s.mesin.kode_mesin);
      const kodeTujuan = kodePendek(tujuan.kode_mesin);
      const ket = `Pindah mesin ${kodeAsal} → ${kodeTujuan} (kasir): ${String(alasan).trim()}`;
      const detailId = asal.entri.detail_id;
      let hasilAkhir = 'antre';
      // Perubahan #36: siapa saja yang terdampak (untuk shortcut WA)
      const pihak = [{ transaksi_id: Number(transaksiId), peran: 'dipindah', dari: kodeAsal }];
      if (!t.jalan && posisi === 'depan' && t.teralokasi) pihak.push({ transaksi_id: t.teralokasi.transaksi_id, peran: 'didahului', sebab: 'didahului' });
      if (asal.teralokasi && asal.s.antrian[0]) pihak.push({ transaksi_id: asal.s.antrian[0].transaksi_id, peran: 'maju', sebab: 'maju' });

      await db.transaction(async (conn) => {
        const urutBaru = posisi === 'depan' ? minU - 1 : maxU + 1;
        if (asal.teralokasi) {
          await kembalikanKeAntrian(conn, { transaksiId, detailId, tipe, mesinIdAntrian: tujuan.id, urutan: urutBaru, keterangan: ket, karyawanId });
        } else {
          await conn.execute(`UPDATE detail_transaksi SET antrian_mesin_id = ?, antrian_urutan = ? WHERE id = ?`, [tujuan.id, urutBaru, detailId]);
        }
        const tujuanBebas = !t.jalan;
        if (tujuanBebas && (posisi === 'depan' || (!t.teralokasi && !t.antrian.length))) {
          if (t.teralokasi) {
            // pelanggan teralokasi di mesin tujuan belum datang -> mundur jadi antrian 1
            await kembalikanKeAntrian(conn, {
              transaksiId: t.teralokasi.transaksi_id, detailId: t.teralokasi.detail_id, tipe,
              mesinIdAntrian: tujuan.id, urutan: urutBaru, keterangan: `Didahului order pindahan dari ${kodeAsal} (kasir): ${String(alasan).trim()}`, karyawanId,
            });
          }
          const ok = await alokasiLangsung(conn, { transaksiId, detailId, mesinId: tujuan.id, tipe, keterangan: ket, karyawanId });
          if (!ok) throw conflict('Mesin tujuan tidak bisa dialokasikan sekarang, coba muat ulang');
          hasilAkhir = 'teralokasi';
        }
        await mesinLogManualModel.create({
          mesinId: tujuan.id, jenisAksi: 'ubah_antrian', transaksiId: Number(transaksiId), command: `pindah_${posisi}`,
          alasan: ket.slice(0, 250), karyawanId, cabangId: tujuan.cabang_id,
        }, conn);
      });
      return { transaksi_id: Number(transaksiId), dari: kodeAsal, ke: kodeTujuan, posisi, hasil: hasilAkhir, _pihak: pihak, _tipe: tipe };
    });
    await refresh(tujuan.cabang_id); // antrian mesin asal maju / alokasi kepala antrian
    const { _pihak, _tipe, ...out } = hasil;
    out.wa = await pesanTerdampak(tujuan.cabang_id, _tipe, _pihak).catch(() => []);
    return out;
  })();
}

/**
 * Perubahan #14: estimasi mulai untuk SEMUA order yang sedang antre 1 tipe.
 *  - mode otomatis: mesin janji + tunggu_menit dari antrian terkunci (sama
 *    dengan popup mesin & WA).
 *  - mode manual: perkiraan kasar -- order antre (FIFO waktu status) diberi
 *    mesin aktif yang paling cepat kosong (sisa jalan + teralokasi + order
 *    di depannya). Tanpa kode mesin (belum ada mesin janji).
 * @returns {Map<number, {kode_mesin_pendek:string|null, tunggu_menit:number, siap_tunggu_bongkar:boolean, perkiraan:boolean}>}
 */
async function estimasiAntre(cabangId, tipe) {
  const out = new Map();
  const otomatis = await modeOtomatis(cabangId);
  const state = await bangunState(cabangId, tipe);
  if (otomatis) {
    for (const s of state.mesin) {
      for (const q of s.antrian) {
        out.set(Number(q.transaksi_id), {
          kode_mesin_pendek: kodePendek(s.mesin.kode_mesin), tunggu_menit: Math.max(0, Math.round(q.tunggu_menit || 0)),
          siap_tunggu_bongkar: !!q.siap_tunggu_bongkar, perkiraan: false,
        });
      }
    }
    return out;
  }
  // kosong dalam = sisa jalan + order teralokasi (tanpa antrian terkunci)
  const bebas = state.mesin.filter((s) => s.aktif).map((s) => (s.jalan ? s.jalan.sisa_menit : 0) + (s.teralokasi ? s.teralokasi.durasi : 0));
  if (!bebas.length) return out;
  const antre = [...state.berhak].sort((a, b) => wibMs(a.waktu_status || a.tanggal) - wibMs(b.waktu_status || b.tanggal) || a.detail_id - b.detail_id);
  for (const q of antre) {
    let i = 0;
    for (let j = 1; j < bebas.length; j++) if (bebas[j] < bebas[i]) i = j;
    out.set(Number(q.transaksi_id), { kode_mesin_pendek: null, tunggu_menit: Math.max(0, Math.round(bebas[i])), siap_tunggu_bongkar: false, perkiraan: true });
    bebas[i] += durasiOf(q, tipe);
  }
  return out;
}

/* ------------------------------------------------------ popup kasir */

const LABEL_STATUS_SEBELUMNYA = {
  selesai_cuci: 'Selesai cuci, cucian masih di mesin',
  alokasi_mesin_kering: 'Selesai cuci, cucian masih di mesin',
  selesai_kering: 'Selesai kering, cucian masih di mesin',
  proses_setrika: 'Proses setrika',
  selesai_setrika: 'Selesai setrika',
  proses_lipat: 'Proses lipat',
  selesai_lipat: 'Selesai lipat',
  proses_antar: 'Sedang diantar',
  selesai_antar: 'Sudah diantar',
  siap_diambil: 'Siap diambil',
  sudah_diambil: 'Sudah diambil',
};

/** Kalimat posisi proses customer SEBELUMNYA sekarang. */
async function posisiSebelumnya(prev, cabangId) {
  if (!prev) return null;
  const base = {
    transaksi_id: prev.transaksi_id, no_invoice: prev.no_invoice,
    nama: prev.nama_pelanggan || 'Walk-in', keranjang: keranjangPendek(prev.kode_antrian),
    telepon: prev.telepon || null, status_kode: prev.status_kode,
    berat_kg: beratBulat(prev.berat_kg),
    layanan: ikonLayanan(prev.kategori_list, prev.status_kode, { durasiKering: prev.durasi_kering }),
  };
  base.cucian_di_mesin = cucianMasihDiMesin(prev, ['selesai_kering'].includes(prev.status_kode) ? 'dryer' : 'washer');
  // Perubahan #44: saklar posisi cucian (di mesin / di keranjang) di kartu PENGGUNA TERAKHIR
  const katPrev = String(prev.kategori_list || '').split(',');
  base.posisi = prev.posisi_cucian_manual === 'keranjang' ? 'keranjang' : 'mesin';
  base.posisi_bisa = (prev.status_bayar === 'lunas' || !!Number(prev.bayar_saat_ambil))
    && ['selesai_cuci', 'alokasi_mesin_kering', 'selesai_kering', 'siap_diambil'].includes(prev.status_kode)
    && !(prev.status_kode === 'siap_diambil' && (katPrev.includes('lipat') || katPrev.includes('setrika_lipat')));
  const kode = prev.status_kode;
  if (prev.posisi_cucian_manual === 'keranjang' && ['selesai_cuci', 'alokasi_mesin_kering', 'selesai_kering'].includes(kode)) {
    return { ...base, keterangan: kode === 'selesai_kering' ? 'Selesai kering, cucian sudah di keranjang' : 'Selesai cuci, cucian sudah di keranjang' };
  }
  if (kode === 'mulai_kering') {
    const u = await db.queryOne(
      `SELECT u.waktu_mulai, m.kode_mesin, l.durasi_menit FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
       LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id LEFT JOIN layanan l ON l.id = dt.layanan_id
       WHERE u.transaksi_id = ? AND u.waktu_selesai IS NULL AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1`, [prev.transaksi_id]);
    if (u) {
      const sisa = Math.max(0, Math.ceil(durasiOf(u, 'dryer') - (Date.now() - wibMs(u.waktu_mulai)) / 60000));
      return { ...base, keterangan: `Proses kering di ${kodePendek(u.kode_mesin)} · sisa ${sisa} mnt` };
    }
  }
  if (kode === 'alokasi_mesin_kering') {
    const r = await db.queryOne(
      `SELECT m.kode_mesin FROM detail_transaksi dt JOIN layanan l ON l.id = dt.layanan_id JOIN mesin m ON m.id = dt.mesin_id
       WHERE dt.transaksi_id = ? AND l.kategori = 'kering' LIMIT 1`, [prev.transaksi_id]);
    return { ...base, keterangan: `Selesai cuci, cucian masih di mesin · teralokasi kering di ${r ? kodePendek(r.kode_mesin) : '-'}` };
  }
  if (kode === 'selesai_cuci') {
    const info = await infoTransaksi(cabangId, prev.transaksi_id, 'dryer').catch(() => null);
    if (info) {
      return { ...base, keterangan: `Selesai cuci, cucian masih di mesin · antre kering di ${info.kode_mesin_pendek}`
        + (info.siap_tunggu_bongkar ? '' : ` ± ${info.tunggu_menit} mnt`) };
    }
  }
  return { ...base, keterangan: LABEL_STATUS_SEBELUMNYA[kode] || prev.status_nama || kode };
}

function barisOrang(r, tipe, extra = {}) {
  return {
    transaksi_id: r.transaksi_id, no_invoice: r.no_invoice,
    nama: r.nama_pelanggan || 'Walk-in', keranjang: keranjangPendek(r.kode_antrian), telepon: r.telepon || null,
    berat_kg: beratBulat(r.berat_kg),
    layanan: ikonLayanan(r.kategori_list, r.status_kode, { durasiKering: r.durasi_kering }),
    durasi_menit: r.durasi || durasiOf(r, tipe), paket: r.nama_paket || null,
    ...extra,
  };
}

/* ---- Perubahan #32/#33/#36: pesan WA per order (popup, pindah, geser) ----
 * Selalu dibangun dari STATUS ORDER SAAT INI + layanan yang dipesan + mode
 * drop-off -- bukan dari mesin yang sedang diklik (bug #36: order yang sudah
 * selesai kering & tanpa lipat dulu dapat kalimat "lanjut ke tahap lipat").
 */
async function infoWa(ids) {
  const out = new Map();
  ids = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT t.id, t.cabang_id, t.no_invoice, t.kode_antrian, t.total, t.status_bayar, t.bayar_saat_ambil,
            sm.kode AS status_kode, t.posisi_cucian_manual, c.nama AS outlet,
            c.link_gmap_review, c.link_ig, c.link_fb, c.link_tiktok,
            p.nama AS nama_pelanggan, p.telepon,
            GROUP_CONCAT(DISTINCT l.kategori) AS kategori,
            SUM(CASE WHEN l.kategori = 'drop_off' THEN d.qty ELSE 0 END) AS drop_off_qty
       FROM transaksi t
       JOIN cabang c ON c.id = t.cabang_id
       LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
       LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id
       LEFT JOIN detail_transaksi d ON d.transaksi_id = t.id AND d.item_tipe = 'jasa'
       LEFT JOIN layanan l ON l.id = d.layanan_id
      WHERE t.id IN (${ph}) GROUP BY t.id`, ids);
  // mesin terakhir per tipe + yang masih jalan (sisa menit)
  const usage = await db.query(
    `SELECT u.transaksi_id, u.waktu_mulai, u.waktu_selesai, m.kode_mesin, m.tipe, l.durasi_menit
       FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
       LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id LEFT JOIN layanan l ON l.id = dt.layanan_id
      WHERE u.transaksi_id IN (${ph}) ORDER BY u.id`, ids);
  const pakai = new Map();
  for (const u of usage) {
    const k = pakai.get(Number(u.transaksi_id)) || {};
    k[u.tipe] = u.kode_mesin;
    if (!u.waktu_selesai) {
      k.jalan = { tipe: u.tipe, kode: u.kode_mesin, sisa: Math.max(0, Math.ceil(durasiOf(u, u.tipe) - (Date.now() - wibMs(u.waktu_mulai)) / 60000)) };
    }
    pakai.set(Number(u.transaksi_id), k);
  }
  for (const r of rows) {
    out.set(Number(r.id), {
      ...r, kategori: String(r.kategori || '').split(',').filter(Boolean), drop_off_qty: Number(r.drop_off_qty || 0),
      pakai: pakai.get(Number(r.id)) || {},
    });
  }
  return out;
}

/** Info antrian sesuai tahap order sekarang ('washer' sebelum cuci, 'dryer' setelah cuci). */
async function antrianTahap(info) {
  const st = info.status_kode;
  const kat = info.kategori;
  let tipe = null;
  if (['sudah_bayar', 'alokasi_mesin_cuci', 'selesai_jemput'].includes(st)) tipe = kat.includes('cuci') ? 'washer' : (kat.includes('kering') ? 'dryer' : null);
  else if (['selesai_cuci', 'alokasi_mesin_kering'].includes(st) && kat.includes('kering')) tipe = 'dryer';
  if (!tipe) return null;
  const a = await infoTransaksi(info.cabang_id, info.id, tipe).catch(() => null);
  return a ? { ...a, tipe } : null;
}

/** Pesan WA status SAAT INI untuk 1 order (info dari infoWa). */
async function pesanStatusOrder(info) {
  if (!info) return null;
  const { buildMessage } = require('./whatsapp.service');
  const st = info.status_kode;
  const args = {
    nama: info.nama_pelanggan, noInvoice: info.no_invoice, cabang: { nama: info.outlet, link_gmap_review: info.link_gmap_review, link_ig: info.link_ig, link_fb: info.link_fb, link_tiktok: info.link_tiktok },
    kodeKeranjang: info.kode_antrian, kategoriList: info.kategori, dropOffQty: info.drop_off_qty,
    posisiManual: info.posisi_cucian_manual || null,
    tagihan: Number(info.bayar_saat_ambil) && info.status_bayar !== 'lunas' ? Number(info.total) : null,
  };
  const pk = info.pakai || {};
  if (pk.jalan && ['mulai_cuci', 'mulai_kering'].includes(st)) {
    return buildMessage('proses_mesin', { ...args, kodeMesin: pk.jalan.kode, sisaMenit: pk.jalan.sisa, tipeMesin: pk.jalan.tipe });
  }
  if (['sudah_bayar', 'alokasi_mesin_cuci', 'selesai_jemput', 'proses_jemput'].includes(st)) {
    return buildMessage('giliran', { ...args, antrian: await antrianTahap(info) });
  }
  if (['selesai_cuci', 'alokasi_mesin_kering'].includes(st)) {
    return buildMessage('selesai_cuci', { ...args, kodeMesin: pk.washer, antrian: await antrianTahap(info) });
  }
  if (st === 'selesai_kering') return buildMessage('selesai_kering', { ...args, kodeMesin: pk.dryer });
  if (st === 'siap_diambil') {
    return buildMessage('siap_diambil', { ...args, kodeMesin: info.kategori.includes('kering') ? pk.dryer : pk.washer });
  }
  if (st === 'menunggu_bayar') return null;
  return buildMessage(st, args);
}

/** Tempelkan pesan_wa (+ telepon) ke baris-baris popup. */
async function tempelPesanWa(rows) {
  rows = rows.filter(Boolean);
  const map = await infoWa(rows.map((r) => r.transaksi_id)).catch(() => new Map());
  const cache = new Map();
  for (const r of rows) {
    const id = Number(r.transaksi_id);
    if (!cache.has(id)) cache.set(id, await pesanStatusOrder(map.get(id)).catch(() => null));
    r.pesan_wa = cache.get(id);
    if (!r.telepon && map.get(id)) r.telepon = map.get(id).telepon || null;
  }
}

/** Kompatibel tes lama: pesan baris (mesin diabaikan, ikut status order). */
async function pesanWaBaris(o) {
  const map = await infoWa([o.transaksi_id]);
  return pesanStatusOrder(map.get(Number(o.transaksi_id)));
}

/**
 * Perubahan #36: pesan WA untuk pihak terdampak pindah mesin / geser antrian.
 * pihak: [{ transaksi_id, peran, sebab, dari? }] -> [{ transaksi_id, nama, peran, telepon, pesan }]
 */
async function pesanTerdampak(cabangId, tipe, pihak) {
  const { pesanPindah, pesanUrutan } = require('./whatsapp.service');
  const map = await infoWa(pihak.map((p) => p.transaksi_id)).catch(() => new Map());
  const out = [];
  const sudah = new Set();
  for (const p of pihak) {
    const id = Number(p.transaksi_id);
    if (!id || sudah.has(id)) continue;
    sudah.add(id);
    const info = map.get(id);
    if (!info) continue;
    const antrian = await infoTransaksi(cabangId, id, tipe).catch(() => null);
    const dasar = { nama: info.nama_pelanggan, noInvoice: info.no_invoice, kodeKeranjang: info.kode_antrian, antrian, tipe };
    const pesan = p.peran === 'dipindah'
      ? pesanPindah({ ...dasar, dari: p.dari })
      : pesanUrutan({ ...dasar, sebab: p.sebab || 'turun' });
    out.push({
      transaksi_id: id, nama: info.nama_pelanggan || 'Walk-in', peran: p.peran, telepon: info.telepon || null,
      keranjang: keranjangPendek(info.kode_antrian), pesan,
      posisi: antrian ? (antrian.teralokasi ? 'teralokasi' : `antrian ${antrian.antrian_ke || antrian.posisi}`) : null,
      mesin: antrian ? antrian.kode_mesin_pendek : null,
    });
  }
  return out;
}

/** Data popup kartu mesin di dashboard kasir. */
async function popupMesin(mesinId, cabangId) {
  const mesin = await mesinModel.findById(mesinId);
  if (!mesin) throw notFound('Mesin tidak ditemukan');
  if (cabangId && Number(mesin.cabang_id) !== Number(cabangId)) throw conflict('Mesin bukan milik cabang ini');
  if (!TIPE[mesin.tipe]) throw badRequest('Mesin ini tidak punya popup antrian');
  const tipe = mesin.tipe;
  const otomatis = await modeOtomatis(mesin.cabang_id);
  const state = await bangunState(mesin.cabang_id, tipe, { denganSebelumnya: true });
  const s = state.mesin.find((x) => Number(x.mesin.id) === Number(mesinId));

  let tampil = 'idle';
  if (mesin.status === 'maintenance' || mesin.status === 'nonaktif') tampil = mesin.status;
  else if (s.jalan || mesin.status === 'jalan') tampil = 'running';
  else if (s.teralokasi) tampil = 'teralokasi';

  const sebelumnya = await posisiSebelumnya(s.sebelumnya, mesin.cabang_id);
  let sekarang = null;
  if (s.jalan) {
    sekarang = barisOrang(s.jalan, tipe, {
      kondisi: 'jalan', lewat_menit: s.jalan.lewat_menit, sisa_menit: s.jalan.sisa_menit,
    });
  } else if (s.teralokasi) {
    sekarang = barisOrang(s.teralokasi, tipe, {
      kondisi: 'teralokasi', siap_tunggu_bongkar: !!s.teralokasi.siap_tunggu_bongkar,
    });
  }
  const antrian = otomatis ? s.antrian.map((q) => barisOrang(q, tipe, {
    tunggu_menit: q.tunggu_menit, siap_tunggu_bongkar: !!q.siap_tunggu_bongkar,
  })) : [];

  let riwayat = null;
  if (tampil === 'idle') {
    const rows = await db.query(
      `SELECT u.transaksi_id, u.waktu_mulai, u.waktu_selesai, t.no_invoice, t.kode_antrian,
              p.nama AS nama_pelanggan, p.telepon, l.durasi_menit, l.nama_paket
       FROM mesin_usage u JOIN transaksi t ON t.id = u.transaksi_id
       LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
       LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id LEFT JOIN layanan l ON l.id = dt.layanan_id
       WHERE u.mesin_id = ? AND DATE(u.waktu_mulai) = DATE(?)
       ORDER BY u.waktu_mulai DESC, u.id DESC`, [mesinId, now()]);
    riwayat = rows.map((r) => ({
      transaksi_id: r.transaksi_id, no_invoice: r.no_invoice, nama: r.nama_pelanggan || 'Walk-in',
      keranjang: keranjangPendek(r.kode_antrian), waktu_mulai: r.waktu_mulai, waktu_selesai: r.waktu_selesai,
      durasi_menit: durasiOf(r, tipe), telepon: r.telepon || null,
    }));
  }
  // Perubahan #32/#33/#36: pesan WA SEMUA baris, dari status order saat ini
  await tempelPesanWa([...(riwayat || []), sebelumnya, sekarang, ...antrian]);
  // Perubahan #63: total transaksi (seluruh transaksi, termasuk barang) tiap baris -- tampilan saja
  {
    const baris = [...(riwayat || []), sebelumnya, sekarang, ...antrian].filter((b) => b && b.transaksi_id);
    const ids = [...new Set(baris.map((b) => Number(b.transaksi_id)))];
    if (ids.length) {
      const tot = await db.query(`SELECT id, total FROM transaksi WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      const m = new Map(tot.map((t) => [Number(t.id), Number(t.total) || 0]));
      baris.forEach((b) => { b.total = m.has(Number(b.transaksi_id)) ? m.get(Number(b.transaksi_id)) : null; });
    }
  }

  return {
    mesin: { id: mesin.id, kode_mesin: mesin.kode_mesin, kode_pendek: kodePendek(mesin.kode_mesin), tipe, status_raw: mesin.status },
    mode_otomatis: otomatis,
    status: tampil,
    sebelumnya, sekarang, antrian, riwayat,
    bisa_geser: otomatis && tampil === 'teralokasi',
  };
}

module.exports = {
  refresh, mesinBerubahStatus, geserAntrian, infoTransaksi, etaOrderBaru, daftar, popupMesin, estimasiAntre,
  opsiPindah, kandidatAmbil, pindahMesin, tahanTransaksi, _pesanWaBaris: pesanWaBaris,
  kodePendek, keranjangPendek,
  // untuk tes
  _bangunState: bangunState, _pilihMesin: pilihMesin, _hitungTunggu: hitungTunggu,
};
