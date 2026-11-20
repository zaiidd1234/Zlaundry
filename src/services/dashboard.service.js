/**
 * src/services/dashboard.service.js
 * =============================================================================
 * Data ringkas untuk layar dashboard (angka saja; UI menyusul).
 *
 * dashboardKasir(cabangId):
 *   - saldo cash & gopay (kas_kecil)
 *   - ringkasan transaksi hari ini (jumlah, omzet)
 *   - transaksi yang masih "jalan" (belum diambil/diantar)
 *   - jumlah & nilai belum setor
 *   - papan keranjang (kosong/terpakai)
 *
 * dashboardOwner({cabangId?}):
 *   - performa cabang vs target + saldo kas besar + laba rugi bulan berjalan
 * =============================================================================
 */

const transaksiModel = require('../models/transaksi.model');
const kasKecilModel = require('../models/kas-kecil.model');
const kasBesarModel = require('../models/kas-besar.model');
const mesinModel = require('../models/mesin.model');
const mesinUsageModel = require('../models/mesin-usage.model');
const mesinService = require('./mesin.service');
const keranjangService = require('./keranjang.service');
const laporanService = require('./laporan.service');
const { today } = require('../helpers/date');

/** Papan status mesin per cabang: tiap mesin + status + keranjang yg sedang dipakai. */
async function papanMesin(cabangId) {
  // Self-heal DULU (best-effort, jangan sampai dashboard gagal load gara-gara
  // ini) -- mesin yang nyangkut 'jalan' dari trigger manual (timer di memori
  // hilang, mis. server restart) diselesaikan di sini sebelum papan dibangun,
  // supaya dashboard selalu nunjukin status terkini tanpa perlu benerin manual
  // lewat database. Lihat mesinService.rilisManualMacet().
  await mesinService.rilisManualMacet(cabangId).catch((e) => {
    require('../config/logger').error('Self-heal mesin macet gagal (dashboard tetap lanjut)', { cabangId, err: e.message });
  });

  // Antrian terkunci: sinkron dulu (order berhak yang belum punya mesin janji,
  // termasuk order lama sebelum fitur ini ada) -- no-op di mode manual.
  await require('./antrian-mesin.service').refresh(cabangId);

  const [mesin, usageAktif, reservasiAktif, antreRows] = await Promise.all([
    mesinModel.findByCabang(cabangId),
    mesinUsageModel.aktifByCabang(cabangId),
    mesinModel.reservasiAktifByCabang(cabangId),
    // Perubahan #56: jumlah pesanan yang MENGANTRE per mesin (antrian otomatis;
    // di luar yang sedang jalan / teralokasi). Hanya baca. Mode manual -> 0.
    require('../config/database').query(
      `SELECT dt.antrian_mesin_id AS mesin_id, COUNT(DISTINCT dt.transaksi_id) AS n
         FROM detail_transaksi dt JOIN transaksi t ON t.id = dt.transaksi_id
        WHERE t.cabang_id = ? AND dt.antrian_mesin_id IS NOT NULL AND dt.mesin_id IS NULL AND COALESCE(t.ditahan, 0) = 0
        GROUP BY dt.antrian_mesin_id`, [cabangId]).catch(() => []),
  ]);
  const antreMap = new Map(antreRows.map((r) => [Number(r.mesin_id), Number(r.n) || 0]));
  // Perubahan #4: ikon layanan + warna status untuk customer di kartu mesin jalan/teralokasi
  const trxIds = [...new Set([...usageAktif, ...reservasiAktif].map((x) => Number(x.transaksi_id)).filter(Boolean))];
  const layananMap = new Map();
  if (trxIds.length) {
    const rows = await require('../config/database').query(
      `SELECT t.id, sm.kode AS status_kode,
              (SELECT GROUP_CONCAT(DISTINCT l.kategori) FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id WHERE d.transaksi_id = t.id) AS kategori_list
       FROM transaksi t LEFT JOIN status_master sm ON sm.id = t.status_terakhir_id
       WHERE t.id IN (${trxIds.map(() => '?').join(',')})`, trxIds);
    const { ikonLayanan } = require('../helpers/layanan-ikon');
    rows.forEach((r) => layananMap.set(Number(r.id), ikonLayanan(r.kategori_list, r.status_kode)));
  }
  const usageMap = new Map();
  usageAktif.forEach((u) => usageMap.set(u.mesin_id, u));
  const reservasiMap = new Map();
  reservasiAktif.forEach((r) => reservasiMap.set(r.mesin_id, r));
  return mesin.map((m) => {
    const u = usageMap.get(m.id) || null;
    const r = reservasiMap.get(m.id) || null;
    // status tampilan: maintenance/nonaktif -> apa adanya; jalan -> running;
    // 'aktif' TAPI sudah direservasi (dipilih alokasi otomatis/manual, belum
    // "mulai") -> teralokasi (kuning, biar kelihatan beda dari kosong beneran);
    // sisanya -> idle
    let tampil = 'idle';
    if (m.status === 'maintenance' || m.status === 'nonaktif') tampil = m.status;
    else if (m.status === 'jalan' || u) tampil = 'running';
    else if (m.direservasi) tampil = 'teralokasi';
    let usageOut = null;
    if (u) {
      // waktu_mulai string WIB -> hitung durasi menit (tag +07:00 supaya bebas TZ container)
      const startMs = new Date(String(u.waktu_mulai).replace(' ', 'T') + '+07:00').getTime();
      const durasiMenit = isNaN(startMs) ? null : Math.max(0, Math.floor((Date.now() - startMs) / 60000));
      usageOut = {
        transaksi_id: u.transaksi_id, no_invoice: u.no_invoice,
        kode_keranjang: u.kode_antrian, waktu_mulai: u.waktu_mulai, durasi_menit: durasiMenit,
        durasi_target: u.durasi_target ? Number(u.durasi_target) : null,
        nama_pelanggan: u.nama_pelanggan || null,
        layanan: layananMap.get(Number(u.transaksi_id)) || [],
      };
    }
    const reservasiOut = r ? {
      transaksi_id: r.transaksi_id, no_invoice: r.no_invoice,
      kode_keranjang: r.kode_antrian, nama_pelanggan: r.nama_pelanggan || null,
      layanan: layananMap.get(Number(r.transaksi_id)) || [],
    } : null;
    return {
      id: m.id, kode_mesin: m.kode_mesin, nama_mesin: m.nama_mesin,
      tipe: m.tipe, status: tampil, status_raw: m.status, kapasitas_kg: m.kapasitas_kg,
      total_cycle: Number(m.total_cycle) || 0,
      antre: antreMap.get(Number(m.id)) || 0,
      iot_provider: m.iot_provider || 'bypass',
      usage: usageOut,
      reservasi: reservasiOut,
    };
  });
}

async function dashboardKasir(cabangId, opts = {}) {
  const ymd = today();
  const awalBulan = `${ymd.slice(0, 7)}-01`;
  const [saldo, hariIni, bulanIni, aktif, belumSetor, papan, mesin, pelanggan, ops] = await Promise.all([
    kasKecilModel.saldo(cabangId),
    transaksiModel.ringkasHarian(cabangId, ymd),
    transaksiModel.ringkasRange(cabangId, awalBulan, ymd),
    transaksiModel.transaksiAktif(cabangId, ymd),
    transaksiModel.ringkasBelumSetor(cabangId),
    keranjangService.papan(cabangId),
    papanMesin(cabangId),
    transaksiModel.statPelangganHariIni(cabangId, ymd),
    transaksiModel.ringkasOperasional(cabangId),
  ]);
  // Perubahan #65/#66: transaksi hari ini per jam (lunas + bayar saat ambil yang sudah dikonfirmasi kasir)
  const tpj = await transaksiPerJam(cabangId, ymd, ymd, { pembanding: opts.pembanding !== false }); // #75: refresh latar tanpa riwayat
  const perJam = tpj.per_jam;

  return {
    tanggal: ymd,
    transaksi_per_jam: perJam,
    transaksi_per_jam_pembanding: tpj.pembanding || null, // Perubahan #68
    saldo,
    transaksi_hari_ini: hariIni,            // { jumlah, omzet }
    transaksi_bulan_ini: bulanIni,          // { jumlah, omzet }
    pelanggan_hari_ini: pelanggan,
    operasional: ops,
    sedang_proses: { jumlah: aktif.length, daftar: aktif },
    belum_setor: belumSetor,
    keranjang: { total: papan.total, kosong: papan.kosong, terpakai: papan.terpakai },
    mesin,
  };
}

async function dashboardOwner({ cabangId }) {
  const [performa, labaRugi, saldoKasBesar] = await Promise.all([
    laporanService.performaCabang(cabangId, {}),
    laporanService.labaRugi(cabangId, {}),
    kasBesarModel.saldo({}),
  ]);

  return {
    performa,
    laba_rugi_bulan_berjalan: {
      periode: labaRugi.periode,
      pendapatan: labaRugi.pendapatan,
      laba_kotor: labaRugi.laba_kotor,
      laba_bersih: labaRugi.laba_bersih,
    },
    saldo_kas_besar: saldoKasBesar,
  };
}

/**
 * Dashboard MANAGER (1 cabang): omzet hari ini per metode, transaksi (proses/siap/selesai),
 * laba kotor hari ini, tren omzet 7 hari, dan papan mesin lengkap (dengan total_cycle).
 */
async function dashboardManager(cabangId) {
  const ymd = today();
  // rentang 7 hari terakhir (termasuk hari ini) — hitung dari ymd (WIB), bukan TZ container
  const base = new Date(ymd + 'T00:00:00+07:00');
  base.setDate(base.getDate() - 6);
  const dari = new Date(base.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const awalBulan = `${ymd.slice(0, 7)}-01`;
  // akhir bulan (samakan dengan range default Kas Besar -> laba bersih konsisten)
  const [yy, mm] = ymd.slice(0, 7).split('-').map(Number);
  const akhirHari = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const akhirBulan = `${ymd.slice(0, 7)}-${String(akhirHari).padStart(2, '0')}`;

  const [hariIni, perMetode, ops, labaHari, tren, papan, omzetBulan, labaBulan] = await Promise.all([
    transaksiModel.ringkasHarian(cabangId, ymd),
    transaksiModel.omzetPerMetodeHari(cabangId, ymd),
    transaksiModel.ringkasOperasional(cabangId),
    laporanService.labaRugi(cabangId, { dari: ymd, sampai: ymd }),
    transaksiModel.trenOmzetHarian(cabangId, dari, ymd),
    papanMesin(cabangId),
    transaksiModel.ringkasRange(cabangId, awalBulan, ymd),
    laporanService.labaRugi(cabangId, { dari: awalBulan, sampai: akhirBulan }),
  ]);

  // ringkas selesai hari ini (jumlah lunas - proses - siap kira-kira; pakai data ops + hariIni)
  return {
    tanggal: ymd,
    omzet_hari_ini: {
      total: hariIni.omzet,
      cash: perMetode.cash,
      qris: perMetode.qris,
      kiosk: perMetode.kiosk || 0, // #83
      jumlah_transaksi: hariIni.jumlah,
    },
    operasional: ops,                         // { belum_bayar, proses, siap }
    laba_hari_ini: {
      pendapatan: labaHari.pendapatan,
      beban: Math.round(((labaHari.cogs || 0) + (labaHari.cos || 0) + (labaHari.opex || 0)) * 100) / 100,
      laba_kotor: labaHari.laba_kotor,
      laba_bersih: labaHari.laba_bersih,
    },
    bulan_ini: {
      omzet: omzetBulan.omzet,
      jumlah_transaksi: omzetBulan.jumlah,
      laba_bersih: labaBulan.laba_bersih,
    },
    tren_omzet_7hari: tren.map((r) => ({
      tanggal: String(r.tanggal).slice(0, 10),
      omzet: Number(r.omzet) || 0,
      jumlah: Number(r.jumlah) || 0,
    })),
    mesin: papan,                             // [{ kode_mesin, tipe, status, status_raw, total_cycle, usage }]
  };
}

/**
 * Perubahan #66: jumlah transaksi per jam (0..23) dalam rentang tanggal.
 * Dihitung: transaksi LUNAS + BELUM BAYAR yang sudah dikonfirmasi kasir (bayar saat ambil).
 * Jam = waktu konfirmasi (status 'sudah_bayar' pertama; fallback tanggal bayar / tanggal).
 * Pesanan customer yang belum dikonfirmasi (menunggu bayar) tidak dihitung.
 */
async function transaksiPerJam(cabangId, dari, sampai, opts = {}) {
  const db = require('../config/database');
  const ids = (Array.isArray(cabangId) ? cabangId : [cabangId]).map(Number);
  const hitung = async (d1, d2) => {
    const rows = await db.query(
      `SELECT HOUR(x.wk) AS jam, SUM(x.lunas) AS lunas, SUM(1 - x.lunas) AS bsa FROM (
         SELECT t.status_bayar = 'lunas' AS lunas,
                COALESCE((SELECT MIN(l.waktu) FROM transaksi_status_log l JOIN status_master sm ON sm.id = l.status_id
                           WHERE l.transaksi_id = t.id AND sm.kode = 'sudah_bayar'), t.tanggal_bayar, t.tanggal) AS wk
           FROM transaksi t
          WHERE t.cabang_id IN (${ids.map(() => '?').join(',')})
            AND (t.status_bayar = 'lunas' OR t.bayar_saat_ambil = 1)
            AND t.tanggal >= ? - INTERVAL 3 DAY AND t.tanggal < ? + INTERVAL 1 DAY) x
        WHERE DATE(x.wk) BETWEEN ? AND ?
        GROUP BY jam`, [...ids, d1, d2, d1, d2]).catch(() => []);
    const per = Array.from({ length: 24 }, (_, h) => ({ jam: h, jumlah: 0, lunas: 0, bayar_saat_ambil: 0 }));
    rows.forEach((r) => {
      if (r.jam == null) return;
      const o = per[Number(r.jam)]; o.lunas = Number(r.lunas) || 0; o.bayar_saat_ambil = Number(r.bsa) || 0; o.jumlah = o.lunas + o.bayar_saat_ambil;
    });
    return per;
  };
  const geser = (ymd, hari) => new Date(Date.parse(`${ymd}T00:00:00Z`) - hari * 86400000).toISOString().slice(0, 10);
  const per = await hitung(dari, sampai);
  const total = per.reduce((a, x) => a + x.jumlah, 0);
  const nHari = Math.round((Date.parse(sampai) - Date.parse(dari)) / 86400000) + 1;
  const hasil = { dari, sampai, hari: nHari, total, bayar_saat_ambil: per.reduce((a, x) => a + x.bayar_saat_ambil, 0), per_jam: per };
  // Perubahan #68: pembanding = rata-rata rentang yang sama 1..4 minggu sebelumnya
  if (opts.pembanding !== false) {
    const minggu = [1, 2, 3, 4].map((w) => ({ dari: geser(dari, 7 * w), sampai: geser(sampai, 7 * w) }));
    const hasilM = await Promise.all(minggu.map((m) => hitung(m.dari, m.sampai)));
    const r1 = (n) => Math.round(n * 10) / 10;
    hasil.pembanding = {
      minggu,
      per_jam: per.map((_, h) => ({ jam: h, rata: r1(hasilM.reduce((a, m) => a + m[h].jumlah, 0) / 4) })),
      total_rata: r1(hasilM.reduce((a, m) => a + m.reduce((x, y) => x + y.jumlah, 0), 0) / 4),
    };
  }
  return hasil;
}

module.exports = { transaksiPerJam, dashboardKasir, dashboardOwner, dashboardManager, papanMesin };
