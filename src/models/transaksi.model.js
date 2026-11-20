/**
 * src/models/transaksi.model.js
 * =============================================================================
 * Akses tabel `transaksi` (header).
 * Kolom: id, cabang_id, pelanggan_id, kasir_id, keranjang_id, kode_antrian,
 *   status_terakhir_id, no_invoice, tanggal, berat_kg, alamat_antar,
 *   subtotal, diskon, total, metode_bayar, status_bayar, status_setor,
 *   transfer_id, sumber_pesan, created_at, updated_at.
 *
 * Fungsi tulis menerima `conn` (koneksi transaksi) supaya atomik dengan detail,
 * kas_kecil, keranjang, dst.
 * =============================================================================
 */

const db = require('../config/database');

/**
 * Kondisi SQL "beneran lagi antri/nunggu proses MESIN BERIKUTNYA" -- dipakai
 * BARENGAN di listForKasir() (tab antri_mesin, & buat exclude di proses_mesin/
 * proses_non_mesin) DAN ringkasOperasional() (angka kartu "Antri Mesin"), satu
 * sumber definisi biar gak nyimpang kayak bug `direservasi` dulu (status-kode
 * doang tanpa cek kategori layanan transaksinya).
 *
 * Alias WAJIB tersedia di query pemanggil: t = transaksi, s = status_master.
 *
 *   - alokasi_mesin_cuci / alokasi_mesin_kering : status ini CUMA bisa
 *     tercapai kalau kategori terkait memang dipesan (aturan state-machine),
 *     jadi aman dicek langsung dari s.kode tanpa EXISTS tambahan.
 *   - sudah_bayar   : baru nunggu alokasi mesin CUCI -> HANYA relevan kalau
 *     transaksi ini beneran ada kategori cuci ATAU kering. Order cafe/barang
 *     saja (tanpa jasa mesin sama sekali) TIDAK PERNAH antri mesin walau
 *     statusnya masih 'sudah_bayar'.
 *   - selesai_cuci  : nunggu alokasi mesin KERING -> HANYA relevan kalau
 *     transaksi ini ada kategori kering. Untuk "Cuci Saja" (tanpa kering),
 *     selesai_cuci itu udah tahap AKHIR proses mesin (tinggal diambil),
 *     BUKAN nunggu mesin lagi -- jadi jangan masuk antri_mesin.
 */
const ANTRI_MESIN_COND = `(
  s.kode IN ('alokasi_mesin_cuci','alokasi_mesin_kering')
  OR (s.kode = 'sudah_bayar' AND EXISTS (
        SELECT 1 FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
         WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa' AND l.kategori IN ('cuci','kering')
      ))
  OR (s.kode = 'selesai_cuci' AND EXISTS (
        SELECT 1 FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
         WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa' AND l.kategori = 'kering'
      ))
)`;

const FIELDS = `
  id, cabang_id, pelanggan_id, kasir_id, keranjang_id, kode_antrian,
  status_terakhir_id, no_invoice, tanggal, berat_kg, alamat_antar,
  subtotal, diskon, poin_dipakai, total, metode_bayar, status_bayar, bayar_saat_ambil, tanggal_bayar, status_setor,
  transfer_id, sumber_pesan, posisi_cucian_manual, ditahan, ditahan_at, ditahan_alasan, ditahan_oleh, created_at, updated_at
`;

/** Insert header transaksi. conn WAJIB (bagian dari transaksi DB). @returns insertId */
async function create(conn, data) {
  const sql = `INSERT INTO transaksi
    (cabang_id, pelanggan_id, kasir_id, keranjang_id, kode_antrian, status_terakhir_id,
     no_invoice, tanggal, berat_kg, alamat_antar, subtotal, diskon, total,
     metode_bayar, status_bayar, status_setor, sumber_pesan)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    data.cabang_id, data.pelanggan_id, data.kasir_id,
    data.keranjang_id ?? null, data.kode_antrian ?? null, data.status_terakhir_id ?? null,
    data.no_invoice, data.tanggal, data.berat_kg ?? null, data.alamat_antar ?? null,
    data.subtotal, data.diskon ?? 0, data.total,
    data.metode_bayar, data.status_bayar ?? 'belum', data.status_setor ?? 'belum_setor',
    data.sumber_pesan ?? 'kasir',
  ];
  const [r] = await conn.execute(sql, params);
  return r.insertId;
}

async function findById(id) {
  return db.queryOne(`SELECT ${FIELDS} FROM transaksi WHERE id = ? LIMIT 1`, [id]);
}

async function findByInvoice(noInvoice) {
  return db.queryOne(`SELECT ${FIELDS} FROM transaksi WHERE no_invoice = ? LIMIT 1`, [noInvoice]);
}

/** Set total/subtotal/diskon (dipanggil setelah semua item dihitung). */
async function setTotal(conn, id, { subtotal, diskon, total }) {
  await conn.execute(
    `UPDATE transaksi SET subtotal=?, diskon=?, total=? WHERE id=?`,
    [subtotal, diskon, total, id]
  );
}

/** Set status pembayaran + status terakhir (saat bayar). */
async function setBayar(conn, id, { status_bayar, status_terakhir_id, metode_bayar, tanggal_bayar = null }) {
  // tanggal_bayar = waktu uang diterima (Perubahan #13) -- acuan laporan omzet
  await conn.execute(
    `UPDATE transaksi SET status_bayar=?, status_terakhir_id=?, metode_bayar=?,
            tanggal_bayar = IF(? = 'lunas', COALESCE(?, NOW()), tanggal_bayar) WHERE id=?`,
    [status_bayar, status_terakhir_id, metode_bayar, status_bayar, tanggal_bayar, id]
  );
}

/** Perubahan #13: proses dulu, bayar saat ambil -> status sudah_bayar (tahap proses), status_bayar tetap 'belum'. */
async function setBayarSaatAmbil(conn, id, { status_terakhir_id }) {
  await conn.execute(
    `UPDATE transaksi SET bayar_saat_ambil = 1, status_terakhir_id = ? WHERE id = ? AND status_bayar = 'belum'`,
    [status_terakhir_id, id]
  );
}

/** Update status terakhir saja (perpindahan status workflow). */
async function setStatus(conn, id, statusId) {
  await conn.execute(`UPDATE transaksi SET status_terakhir_id=? WHERE id=?`, [statusId, id]);
}

/** Set status pakai pool langsung (tanpa conn transaksi) — untuk update tunggal di luar transaksi. */
async function setStatusPool(id, statusId) {
  await db.query(`UPDATE transaksi SET status_terakhir_id=? WHERE id=?`, [statusId, id]);
}

/** Set keranjang_id + kode_antrian pada header (histori keranjang yang dipakai). */
async function setKeranjang(conn, id, keranjangId, kodeAntrian = null) {
  await conn.execute(
    `UPDATE transaksi SET keranjang_id=?, kode_antrian=? WHERE id=?`,
    [keranjangId, kodeAntrian, id]
  );
}

/**
 * Override MANUAL posisi fisik cucian ('mesin' | 'keranjang' | null utk reset).
 * Dipakai kasir buat kasus: cucian udah kelar diproses tapi pelanggan gak
 * kunjung ambil, jadi mesinnya "dipaksa" dikosongin & cucian dipindah ke
 * keranjang manual -- supaya notif WA & tampilan lokasi ikut akurat,
 * bukan tetap ngomong "masih di mesin X" padahal udah dipindah kasir.
 */
async function setPosisiManual(id, posisi) {
  await db.query(`UPDATE transaksi SET posisi_cucian_manual=? WHERE id=?`, [posisi, id]);
}

/** Apakah pelanggan ini sudah punya transaksi LAIN di tanggal tertentu (untuk frekuensi). */
async function adaTransaksiHari(pelangganId, tanggalYmd, excludeId = null, conn = null) {
  const runner = conn || db.pool;
  let sql = `SELECT 1 FROM transaksi WHERE pelanggan_id=? AND DATE(tanggal)=?`;
  const params = [pelangganId, tanggalYmd];
  if (excludeId !== null) { sql += ` AND id <> ?`; params.push(excludeId); }
  sql += ` LIMIT 1`;
  const [rows] = await runner.execute(sql, params);
  return rows.length > 0;
}

/** Daftar transaksi LUNAS yang belum disetor (FIFO: lama dulu). */
async function findBelumSetor(cabangId, conn = null) {
  const runner = conn || db.pool;
  const [rows] = await runner.execute(
    `SELECT id, no_invoice, tanggal, total, metode_bayar
     FROM transaksi
     WHERE cabang_id = ? AND status_bayar = 'lunas'
       AND status_setor = 'belum_setor' AND transfer_id IS NULL
     ORDER BY tanggal ASC, id ASC`,
    [cabangId]
  );
  return rows;
}

/** Stempel transaksi terpilih jadi sudah_setor + isi transfer_id. */
async function stempelSetor(conn, transferId, ids) {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  await conn.execute(
    `UPDATE transaksi SET status_setor = 'sudah_setor', transfer_id = ?
     WHERE id IN (${ph})`,
    [transferId, ...ids]
  );
}

/** Ringkasan jumlah & nilai transaksi belum setor (untuk dashboard). */
async function ringkasBelumSetor(cabangId) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS jml, COALESCE(SUM(total),0) AS total
     FROM transaksi
     WHERE cabang_id = ? AND status_bayar='lunas' AND status_setor='belum_setor' AND transfer_id IS NULL`,
    [cabangId]
  );
  return { jumlah: Number(row.jml) || 0, total: Number(row.total) || 0 };
}

/** Daftar transaksi yang masih "jalan" (sudah bayar, belum sampai status akhir) hari ini. */
async function transaksiAktif(cabangId, ymd) {
  return db.query(
    `SELECT t.id, t.no_invoice, t.kode_antrian, t.total, t.tanggal,
            s.kode AS status_kode, s.nama AS status_nama,
            p.nama AS pelanggan_nama, p.telepon
     FROM transaksi t
     JOIN status_master s ON s.id = t.status_terakhir_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE t.cabang_id = ? AND DATE(t.tanggal) = ?
       AND s.kode NOT IN ('sudah_diambil','selesai_antar')
       AND t.status_bayar = 'lunas'
     ORDER BY t.tanggal ASC`,
    [cabangId, ymd]
  );
}

/**
 * Sub-query koreksi promo: nilai "gross-up" per transaksi (selisih harga
 * normal vs yang ditagih, khusus item is_promo=1). Dipakai di-JOIN ke
 * `transaksi` (LEFT JOIN, 1 baris per transaksi_id) supaya omzet laporan
 * Performa/Dashboard KONSISTEN sama pengakuan pendapatan di kas/laba-rugi
 * (yang sudah "gross-up" via kas_kecil, lihat services/transaksi.service.js
 * bayar()). Transaksi tanpa item promo -> koreksi NULL -> dianggap 0.
 *
 * SENGAJA TIDAK dipakai di omzetPerMetodeHari (itu rekonsiliasi kas fisik
 * cash/QRIS, harus tetap angka riil) maupun modul forecasting pelanggan.model.js
 * (biar proyeksi tetap berbasis pola pembayaran nyata).
 */
const KOREKSI_PROMO_SUBQUERY = `
  SELECT d.transaksi_id, SUM(l.harga * d.qty - d.subtotal) AS koreksi
  FROM detail_transaksi d
  JOIN layanan l ON l.id = d.layanan_id AND l.is_promo = 1
  GROUP BY d.transaksi_id
`;

/** Jumlah & omzet transaksi pada satu tanggal (omzet sudah gross-up utk item promo). */
async function ringkasHarian(cabangId, ymd) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS jml, COALESCE(SUM(t.total + COALESCE(kp.koreksi,0)),0) AS omzet
     FROM transaksi t
     LEFT JOIN (${KOREKSI_PROMO_SUBQUERY}) kp ON kp.transaksi_id = t.id
     WHERE t.cabang_id = ? AND DATE(t.tanggal_bayar) = ? AND t.status_bayar='lunas'`,
    [cabangId, ymd]
  );
  return { jumlah: Number(row.jml) || 0, omzet: Number(row.omzet) || 0 };
}

/** Omzet + jumlah transaksi dalam rentang tanggal (lunas, omzet sudah gross-up utk item promo). */
async function ringkasRange(cabangId, dari, sampai) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS jml, COALESCE(SUM(t.total + COALESCE(kp.koreksi,0)),0) AS omzet
     FROM transaksi t
     LEFT JOIN (${KOREKSI_PROMO_SUBQUERY}) kp ON kp.transaksi_id = t.id
     WHERE t.cabang_id = ? AND DATE(t.tanggal_bayar) BETWEEN ? AND ? AND t.status_bayar='lunas'`,
    [cabangId, dari, sampai]
  );
  return { jumlah: Number(row.jml) || 0, omzet: Number(row.omzet) || 0 };
}

/**
 * Riwayat transaksi milik 1 pelanggan, filter tab aktif/selesai.
 *
 * Selain kolom header, ikut disertakan (via subquery, dipakai kartu "Pesanan
 * Aktif"/"Pesanan Selesai" di app customer buat nge-render timeline & kode
 * mesin TANPA harus panggil getDetail() per baris):
 *   - kategori_list  : kategori layanan jasa yang dipesan (CSV, mis. "cuci,kering")
 *                       -> dipakai front-end nentuin tahapan mana yang relevan
 *                       ditampilkan (cuci-only ya cuma Sudah Bayar-Proses Cuci-
 *                       Siap Diambil, gak usah munculin Proses Kering/Lipat).
 *   - layanan_label  : nama-nama item jasa (buat baris "Layanan: ...").
 *   - mesin_cuci_kode / mesin_kering_kode : kode mesin washer/dryer transaksi
 *       ini. Diambil dari 2 sumber (COALESCE): mesin_usage (mesin yang SUDAH
 *       MULAI dipakai -- ada begitu status masuk mulai_cuci/mulai_kering),
 *       fallback ke detail_transaksi.mesin_id (mesin yang BARU DIALOKASIKAN
 *       tapi belum "mulai" -- status alokasi_mesin_cuci/kering, lihat
 *       mesinService.alokasi() -> detailModel.setMesin()). Tanpa fallback ini,
 *       kartu di tahap "Alokasi Mesin" bakal kosong walau mesinnya udah
 *       ke-assign, karena sesi mesin_usage-nya belum dibuka.
 */
async function findByPelanggan(pelangganId, { tab = 'aktif', limit = 50 } = {}) {
  // semua = tanpa filter status; selesai = sudah_diambil/selesai_antar; aktif = selain itu
  let kondisiTab = '1=1';
  if (tab === 'selesai') kondisiTab = `s.kode IN ('sudah_diambil','selesai_antar')`;
  else if (tab === 'aktif') kondisiTab = `(s.kode IS NULL OR s.kode NOT IN ('sudah_diambil','selesai_antar'))`;
  // tab === 'semua' -> 1=1 (semua transaksi)
  return db.query(
    `SELECT t.id, t.no_invoice, t.kode_antrian, t.tanggal, t.total, t.status_bayar, t.bayar_saat_ambil, t.metode_bayar, t.berat_kg,
            s.kode AS status_kode, s.nama AS status_nama,
            (SELECT GROUP_CONCAT(DISTINCT l.kategori ORDER BY l.kategori SEPARATOR ',')
               FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
              WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa') AS kategori_list,
            (SELECT GROUP_CONCAT(DISTINCT d.nama_item ORDER BY d.id SEPARATOR ', ')
               FROM detail_transaksi d
              WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa') AS layanan_label,
            COALESCE(
              (SELECT m.kode_mesin FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
                WHERE u.transaksi_id = t.id AND m.tipe = 'washer' ORDER BY u.id DESC LIMIT 1),
              (SELECT m.kode_mesin FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
                JOIN mesin m ON m.id = d.mesin_id
                WHERE d.transaksi_id = t.id AND l.kategori = 'cuci' AND d.mesin_id IS NOT NULL
                ORDER BY d.id DESC LIMIT 1)
            ) AS mesin_cuci_kode,
            COALESCE(
              (SELECT m.kode_mesin FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
                WHERE u.transaksi_id = t.id AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1),
              (SELECT m.kode_mesin FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
                JOIN mesin m ON m.id = d.mesin_id
                WHERE d.transaksi_id = t.id AND l.kategori = 'kering' AND d.mesin_id IS NOT NULL
                ORDER BY d.id DESC LIMIT 1)
            ) AS mesin_kering_kode
     FROM transaksi t
     LEFT JOIN status_master s ON s.id = t.status_terakhir_id
     WHERE t.pelanggan_id = ? AND ${kondisiTab}
     ORDER BY t.tanggal DESC, t.id DESC
     LIMIT ?`,
    [pelangganId, limit]
  );
}

/**
 * List transaksi untuk layar kasir, dengan filter tab + enrichment pelanggan.
 * tab: 'belum_bayar' | 'proses' | 'siap' | 'semua'
 *   belum_bayar : status_bayar='belum'
 *   proses      : lunas & status belum terminal & belum siap diambil
 *   siap        : status 'siap_diambil'
 *   semua       : semua yang belum terminal (default operasional harian)
 * q : cari no_invoice / nama / telepon (opsional)
 */
async function listForKasir(cabangId, { tab = 'semua', sub = null, q = null, limit = 100 } = {}) {
  const TERMINAL = `('sudah_diambil','selesai_antar')`;
  let cond = `t.cabang_id = ?`;
  const params = [cabangId];

  // Perubahan #9: 8 tab baru dikelompokkan di JS (helpers/kelompok-pesanan) -> filter id
  const KP = require('../helpers/kelompok-pesanan');
  if (KP.TAB_BARU.includes(tab)) {
    let ids;
    if (tab === 'sudah_diambil') ids = await idSudahDiambilPada(cabangId, require('../helpers/date').today());
    else ids = (await bahanKelompok(cabangId)).filter((r) => KP.cocokTab(KP.kelompokkan(r), tab, sub)).map((r) => r.id);
    if (!ids.length) return [];
    cond += ` AND t.id IN (${ids.map((x) => Number(x)).join(',')})`;
  } else if (tab === 'siap') cond += ` AND s.kode = 'siap_diambil'`;
  else if (tab === 'proses') cond += ` AND t.status_bayar = 'lunas' AND (s.kode IS NULL OR s.kode NOT IN ${TERMINAL}) AND (s.kode IS NULL OR s.kode <> 'siap_diambil')`;
  else if (tab === 'antri_mesin') cond += ` AND t.status_bayar = 'lunas' AND ${ANTRI_MESIN_COND}`;
  else if (tab === 'proses_mesin') cond += ` AND t.status_bayar = 'lunas' AND (s.kode IS NULL OR s.kode NOT IN ${TERMINAL}) AND (s.kode IS NULL OR s.kode <> 'siap_diambil')
    AND NOT ${ANTRI_MESIN_COND}
    AND EXISTS (SELECT 1 FROM mesin_usage u WHERE u.transaksi_id = t.id AND u.waktu_selesai IS NULL)`;
  else if (tab === 'proses_non_mesin') cond += ` AND t.status_bayar = 'lunas' AND (s.kode IS NULL OR s.kode NOT IN ${TERMINAL}) AND (s.kode IS NULL OR s.kode <> 'siap_diambil')
    AND NOT ${ANTRI_MESIN_COND}
    AND NOT EXISTS (SELECT 1 FROM mesin_usage u WHERE u.transaksi_id = t.id AND u.waktu_selesai IS NULL)`;
  else cond += ` AND (s.kode IS NULL OR s.kode NOT IN ${TERMINAL})`; // semua aktif

  if (q && q.trim()) {
    cond += ` AND (t.no_invoice LIKE ? OR p.nama LIKE ? OR p.telepon LIKE ?)`;
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  params.push(limit);

  return db.query(
    `SELECT t.id, t.no_invoice, t.kode_antrian, t.tanggal, t.total,
            t.status_bayar, t.bayar_saat_ambil, t.metode_bayar, t.berat_kg, t.sumber_pesan, t.ditahan, t.ditahan_alasan,
            s.kode AS status_kode, s.nama AS status_nama,
            p.id AS pelanggan_id, p.nama AS pelanggan_nama, p.telepon AS pelanggan_telepon,
            p.point AS pelanggan_point, p.frekuensi_kedatangan AS pelanggan_kunjungan,
            (SELECT GROUP_CONCAT(dt.nama_item SEPARATOR ', ')
               FROM detail_transaksi dt
              WHERE dt.transaksi_id = t.id AND dt.item_tipe = 'jasa') AS layanan_list,
            (SELECT GROUP_CONCAT(DISTINCT m.kode_mesin SEPARATOR ', ')
               FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
              WHERE u.transaksi_id = t.id AND u.waktu_selesai IS NULL) AS mesin_jalan,
            (SELECT GROUP_CONCAT(DISTINCT m.kode_mesin SEPARATOR ', ')
               FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
              WHERE u.transaksi_id = t.id AND u.waktu_selesai IS NOT NULL) AS mesin_selesai,
            -- Dipakai buat kartu 3D (samain dgn role customer, lihat
            -- findByPelanggan() di atas): kategori jasa yang beneran dipesan
            -- (buat filter tahap timeline) + kode mesin cuci/kering terpisah
            -- (COALESCE alokasi vs mesin_usage, sama kayak customer).
            (SELECT GROUP_CONCAT(DISTINCT l.kategori ORDER BY l.kategori SEPARATOR ',')
               FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
              WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa') AS kategori_list,
            COALESCE(
              (SELECT m.kode_mesin FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
                WHERE u.transaksi_id = t.id AND m.tipe = 'washer' ORDER BY u.id DESC LIMIT 1),
              (SELECT m.kode_mesin FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
                JOIN mesin m ON m.id = d.mesin_id
                WHERE d.transaksi_id = t.id AND l.kategori = 'cuci' AND d.mesin_id IS NOT NULL
                ORDER BY d.id DESC LIMIT 1)
            ) AS mesin_cuci_kode,
            COALESCE(
              (SELECT m.kode_mesin FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
                WHERE u.transaksi_id = t.id AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1),
              (SELECT m.kode_mesin FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
                JOIN mesin m ON m.id = d.mesin_id
                WHERE d.transaksi_id = t.id AND l.kategori = 'kering' AND d.mesin_id IS NOT NULL
                ORDER BY d.id DESC LIMIT 1)
            ) AS mesin_kering_kode,
            (SELECT u.waktu_mulai FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'washer' ORDER BY u.id DESC LIMIT 1) AS mesin_cuci_mulai,
            (SELECT u.waktu_selesai FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'washer' ORDER BY u.id DESC LIMIT 1) AS mesin_cuci_selesai,
            (SELECT u.waktu_mulai FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1) AS mesin_kering_mulai,
            (SELECT u.waktu_selesai FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1) AS mesin_kering_selesai,
            -- Target durasi (menit) dari layanan yang dipesan -- dipakai buat kartu 3D
            -- kasir nunjukin ESTIMASI SISA WAKTU (samain dgn role customer), bukan
            -- cuma "udah jalan berapa lama".
            (SELECT l.durasi_menit FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
               LEFT JOIN layanan l ON l.id = dt.layanan_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'washer' ORDER BY u.id DESC LIMIT 1) AS mesin_cuci_durasi_target,
            (SELECT l.durasi_menit FROM mesin_usage u JOIN mesin m ON m.id = u.mesin_id
               LEFT JOIN detail_transaksi dt ON dt.id = u.detail_transaksi_id
               LEFT JOIN layanan l ON l.id = dt.layanan_id
               WHERE u.transaksi_id = t.id AND m.tipe = 'dryer' ORDER BY u.id DESC LIMIT 1) AS mesin_kering_durasi_target
     FROM transaksi t
     LEFT JOIN status_master s ON s.id = t.status_terakhir_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE ${cond}
     ORDER BY t.tanggal DESC, t.id DESC
     LIMIT ?`,
    params
  );
}

/** Statistik pelanggan yang bertransaksi pada satu tanggal: total, baru, lama. */
async function statPelangganHariIni(cabangId, ymd) {
  const row = await db.queryOne(
    `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(first_date = ?), 0) AS baru,
        COALESCE(SUM(first_date < ?), 0) AS lama
     FROM (
        SELECT pelanggan_id, MIN(DATE(tanggal)) AS first_date
        FROM transaksi
        WHERE cabang_id = ? AND pelanggan_id IS NOT NULL
          AND pelanggan_id IN (
             SELECT DISTINCT pelanggan_id FROM transaksi
             WHERE cabang_id = ? AND DATE(tanggal) = ? AND pelanggan_id IS NOT NULL
          )
        GROUP BY pelanggan_id
     ) sub`,
    [ymd, ymd, cabangId, cabangId, ymd]
  );
  return { total: Number(row && row.total) || 0, baru: Number(row && row.baru) || 0, lama: Number(row && row.lama) || 0 };
}

/**
 * Perubahan #9: bahan pengelompokan 8 kartu/tab kasir.
 * Semua transaksi TERBUKA (belum terminal) + kategori jasanya.
 */
async function bahanKelompok(cabangId) {
  const rows = await db.query(
    `SELECT t.id, t.status_bayar, t.bayar_saat_ambil, s.kode AS status_kode,
            (SELECT GROUP_CONCAT(DISTINCT l.kategori)
               FROM detail_transaksi d JOIN layanan l ON l.id = d.layanan_id
              WHERE d.transaksi_id = t.id AND d.item_tipe = 'jasa') AS kategori_list
       FROM transaksi t
       LEFT JOIN status_master s ON s.id = t.status_terakhir_id
      WHERE t.cabang_id = ?
        AND (s.kode IS NULL OR s.kode NOT IN ('sudah_diambil','selesai_antar'))`,
    [cabangId]
  );
  return rows.map((r) => ({
    id: r.id, status_bayar: r.status_bayar, bayar_saat_ambil: !!Number(r.bayar_saat_ambil), status_kode: r.status_kode,
    kategori: r.kategori_list ? String(r.kategori_list).split(',').filter(Boolean) : [],
  }));
}

/** Perubahan #9: id transaksi yang DITANDAI sudah diambil / selesai antar pada tanggal ymd (dari log status). */
async function idSudahDiambilPada(cabangId, ymd) {
  const rows = await db.query(
    `SELECT DISTINCT t.id
       FROM transaksi t
       JOIN status_master s ON s.id = t.status_terakhir_id
       JOIN transaksi_status_log lg ON lg.transaksi_id = t.id AND lg.status_id = t.status_terakhir_id
      WHERE t.cabang_id = ? AND s.kode IN ('sudah_diambil','selesai_antar')
        AND lg.waktu >= ? AND lg.waktu < DATE_ADD(?, INTERVAL 1 DAY)`,
    [cabangId, ymd, ymd]
  );
  return rows.map((r) => r.id);
}

/**
 * Hitung kartu Transaksi dashboard kasir (Perubahan #9, 8 kartu).
 * Kunci lama (antri_mesin, proses_non_mesin, proses) tetap dikirim untuk
 * kompatibilitas (dashboard manager memakai `proses` & `siap`).
 */
async function ringkasOperasional(cabangId) {
  const { kelompokkan } = require('../helpers/kelompok-pesanan');
  const ymd = require('../helpers/date').today();
  const [bahan, diambil] = await Promise.all([bahanKelompok(cabangId), idSudahDiambilPada(cabangId, ymd)]);
  const o = {
    belum_bayar: 0,
    antre_mesin: { cuci: 0, kering: 0, total: 0 },
    alokasi_mesin: { cuci: 0, kering: 0, total: 0 },
    proses_mesin: { cuci: 0, kering: 0, total: 0 },
    drop_off: 0, lipat: 0, siap: 0, sudah_diambil: diambil.length,
  };
  let prosesLunas = 0;
  for (const r of bahan) {
    const k = kelompokkan(r);
    if (k.drop_off) o.drop_off += 1;
    if (k.belum_bayar && k.grup !== 'belum_bayar') o.belum_bayar += 1; // bayar saat ambil: dobel hitung (Perubahan #13)
    if (!k.grup) continue;
    if (typeof o[k.grup] === 'object') { o[k.grup][k.sub] += 1; o[k.grup].total += 1; }
    else o[k.grup] += 1;
    if (r.status_bayar === 'lunas' && k.grup !== 'siap') prosesLunas += 1;
  }
  // kompatibilitas
  o.antri_mesin = o.antre_mesin.total + o.alokasi_mesin.total;
  o.proses_non_mesin = o.lipat;
  o.proses = prosesLunas;
  return o;
}

/**
 * Riwayat harian kasir: SEMUA transaksi (proses + selesai) pada tanggal tertentu.
 * Filter: q (invoice/nama/hp), pelanggan baru/lama, pagination (limit+offset).
 * baru = kunjungan pertama pelanggan = tanggal ini; lama = pernah datang sebelumnya.
 */
async function listRiwayat(cabangId, { ymd, q = null, pelanggan = 'semua', limit = 20, offset = 0 } = {}) {
  let cond = `t.cabang_id = ? AND DATE(t.tanggal) = ?`;
  const params = [cabangId, ymd];

  if (q && q.trim()) {
    cond += ` AND (t.no_invoice LIKE ? OR p.nama LIKE ? OR p.telepon LIKE ?)`;
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }

  // filter pelanggan baru/lama via first_date
  if (pelanggan === 'baru' || pelanggan === 'lama') {
    const op = pelanggan === 'baru' ? '=' : '<';
    cond += ` AND p.id IS NOT NULL AND (
      SELECT MIN(DATE(t2.tanggal)) FROM transaksi t2
       WHERE t2.cabang_id = t.cabang_id AND t2.pelanggan_id = t.pelanggan_id
    ) ${op} ?`;
    params.push(ymd);
  }

  params.push(Number(limit) || 20, Number(offset) || 0);

  return db.query(
    `SELECT t.id, t.no_invoice, t.tanggal, t.total, t.status_bayar, t.metode_bayar,
            t.sumber_pesan, s.kode AS status_kode, s.nama AS status_nama,
            p.id AS pelanggan_id, p.nama AS pelanggan_nama, p.telepon AS pelanggan_telepon,
            p.point AS pelanggan_point, p.frekuensi_kedatangan AS pelanggan_kunjungan,
            (SELECT MIN(DATE(t3.tanggal)) FROM transaksi t3
              WHERE t3.cabang_id = t.cabang_id AND t3.pelanggan_id = t.pelanggan_id) AS first_date,
            (SELECT GROUP_CONCAT(dt.nama_item SEPARATOR ', ')
               FROM detail_transaksi dt
              WHERE dt.transaksi_id = t.id AND dt.item_tipe = 'jasa') AS layanan_list
     FROM transaksi t
     LEFT JOIN status_master s ON s.id = t.status_terakhir_id
     LEFT JOIN pelanggan p ON p.id = t.pelanggan_id
     WHERE ${cond}
     ORDER BY t.tanggal DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    params
  );
}

/**
 * Perubahan #83: poin yang didapat transaksi (kolom transaksi.poin_didapat).
 * Toleran kalau SQL 2026-11-18 belum dijalankan (kolom belum ada -> null).
 */
async function getPoinDidapat(id, conn = null) {
  try {
    const q = `SELECT poin_didapat FROM transaksi WHERE id = ?`;
    const rows = conn ? (await conn.execute(q, [id]))[0] : await db.query(q, [id]);
    return rows[0] && rows[0].poin_didapat != null ? Number(rows[0].poin_didapat) : null;
  } catch (e) {
    if (e && e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}
async function setPoinDidapat(conn, id, poin) {
  try {
    await conn.execute(`UPDATE transaksi SET poin_didapat = ? WHERE id = ?`, [poin, id]);
  } catch (e) {
    if (!e || e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
}

/** Omzet hari ini dipecah per metode bayar (cash/qris/kiosk) — hanya lunas. */
async function omzetPerMetodeHari(cabangId, ymd) {
  const rows = await db.query(
    `SELECT metode_bayar, COALESCE(SUM(total),0) AS omzet
     FROM transaksi WHERE cabang_id = ? AND DATE(tanggal_bayar) = ? AND status_bayar='lunas'
     GROUP BY metode_bayar`,
    [cabangId, ymd]
  );
  const out = { cash: 0, qris: 0, kiosk: 0 };
  rows.forEach((r) => {
    if (r.metode_bayar === 'qris') out.qris = Number(r.omzet) || 0;
    else if (r.metode_bayar === 'kiosk') out.kiosk = Number(r.omzet) || 0; // #83
    else out.cash += Number(r.omzet) || 0;
  });
  return out;
}

/** Tren omzet harian N hari terakhir (termasuk hari ini, gross-up utk item promo). Return [{tanggal, omzet, jumlah}]. */
async function trenOmzetHarian(cabangId, dari, sampai) {
  return db.query(
    `SELECT DATE(t.tanggal_bayar) AS tanggal, COUNT(*) AS jumlah,
            COALESCE(SUM(t.total + COALESCE(kp.koreksi,0)),0) AS omzet
     FROM transaksi t
     LEFT JOIN (${KOREKSI_PROMO_SUBQUERY}) kp ON kp.transaksi_id = t.id
     WHERE t.cabang_id = ? AND t.status_bayar='lunas' AND DATE(t.tanggal_bayar) BETWEEN ? AND ?
     GROUP BY DATE(t.tanggal_bayar) ORDER BY tanggal ASC`,
    [cabangId, dari, sampai]
  );
}

/**
 * Data harian untuk Performa-Ringkasan dalam rentang [dari, sampai].
 * Mengembalikan 3 set yang digabung per tanggal di service:
 *  - omzet mesin (jasa pakai_mesin) & non-mesin (jasa lain + barang) dari detail_transaksi
 *  - jumlah transaksi (lunas) & pelanggan unik per hari dari transaksi
 */
/* Perubahan #47: fungsi performa menerima 1 cabang ATAU daftar cabang (gabungan owner). */
const cP = (c) => (Array.isArray(c) ? c.map(Number) : [Number(c)]);
const cQ = (c) => cP(c).map(() => '?').join(',');

/** Perubahan #79: omzet total (gross, sama dgn omzetMesinHarian) per tanggal, hanya transaksi
 *  yang dibayar pada/ sebelum jam `jam` ('HH:MM:SS') di tanggal itu. */
async function omzetTotalHarianSampaiJam(cabangId, dari, sampai, jam) {
  const gross = `(CASE WHEN l.is_promo = 1 THEN l.harga * d.qty ELSE d.subtotal END)`;
  return db.query(
    `SELECT DATE(t.tanggal_bayar) AS tanggal, COALESCE(SUM(${gross}),0) AS omzet
     FROM transaksi t
     JOIN detail_transaksi d ON d.transaksi_id = t.id
     LEFT JOIN layanan l ON l.id = d.layanan_id
     WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar='lunas' AND DATE(t.tanggal_bayar) BETWEEN ? AND ?
       AND TIME(t.tanggal_bayar) <= ?
     GROUP BY DATE(t.tanggal_bayar)`,
    [...cP(cabangId), dari, sampai, jam]
  );
}

async function omzetMesinHarian(cabangId, dari, sampai) {
  // gross = harga normal (l.harga) utk item promo, subtotal biasa utk item lain
  const gross = `(CASE WHEN l.is_promo = 1 THEN l.harga * d.qty ELSE d.subtotal END)`;
  return db.query(
    `SELECT DATE(t.tanggal_bayar) AS tanggal,
            COALESCE(SUM(CASE WHEN d.item_tipe='jasa' AND l.kategori='cuci'  THEN ${gross} ELSE 0 END),0) AS omzet_cuci,
            COALESCE(SUM(CASE WHEN d.item_tipe='jasa' AND l.kategori='kering' THEN ${gross} ELSE 0 END),0) AS omzet_kering,
            COALESCE(SUM(CASE WHEN d.item_tipe='jasa' AND l.pakai_mesin=1 THEN ${gross} ELSE 0 END),0) AS omzet_mesin,
            COALESCE(SUM(CASE WHEN NOT (d.item_tipe='jasa' AND l.pakai_mesin=1) THEN ${gross} ELSE 0 END),0) AS omzet_nonmesin
     FROM transaksi t
     JOIN detail_transaksi d ON d.transaksi_id = t.id
     LEFT JOIN layanan l ON l.id = d.layanan_id
     WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar='lunas' AND DATE(t.tanggal_bayar) BETWEEN ? AND ?
     GROUP BY DATE(t.tanggal_bayar) ORDER BY tanggal ASC`,
    [...cP(cabangId), dari, sampai]
  );
}

async function transaksiPelangganHarian(cabangId, dari, sampai) {
  return db.query(
    `SELECT DATE(tanggal) AS tanggal, COUNT(*) AS jumlah_transaksi,
            COUNT(DISTINCT pelanggan_id) AS pelanggan_unik
     FROM transaksi
     WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas' AND DATE(tanggal) BETWEEN ? AND ?
     GROUP BY DATE(tanggal) ORDER BY tanggal ASC`,
    [...cP(cabangId), dari, sampai]
  );
}

/**
 * Per tanggal: jumlah pelanggan BARU (first-timer; kedatangan pertama jatuh di tanggal itu)
 * vs LAMA (sudah pernah datang sebelumnya). Berdasarkan kedatangan (distinct DATE).
 * Dipakai Performa-Pelanggan.
 */
async function pelangganBaruLamaHarian(cabangId, dari, sampai) {
  return db.query(
    `SELECT k.tgl AS tanggal,
            SUM(k.tgl = fp.first_tgl) AS baru,
            SUM(k.tgl <> fp.first_tgl) AS lama
     FROM (
       SELECT DISTINCT pelanggan_id, DATE(tanggal) AS tgl
       FROM transaksi WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas'
     ) k
     JOIN (
       SELECT pelanggan_id, MIN(DATE(tanggal)) AS first_tgl
       FROM transaksi WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas'
       GROUP BY pelanggan_id
     ) fp ON fp.pelanggan_id = k.pelanggan_id
     WHERE k.tgl BETWEEN ? AND ?
     GROUP BY k.tgl ORDER BY k.tgl ASC`,
    [...cP(cabangId), ...cP(cabangId), dari, sampai]
  );
}

/**
 * Jumlah pelanggan baru (first-timer) per tanggal sejak awal data sampai 'sampai'.
 * Dipakai untuk hitung akumulasi total pelanggan (kumulatif) di service.
 */
async function pelangganBaruSejakAwal(cabangId, sampai) {
  return db.query(
    `SELECT first_tgl AS tanggal, COUNT(*) AS baru
     FROM (
       SELECT pelanggan_id, MIN(DATE(tanggal)) AS first_tgl
       FROM transaksi WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas'
       GROUP BY pelanggan_id
     ) fp
     WHERE first_tgl <= ?
     GROUP BY first_tgl ORDER BY first_tgl ASC`,
    [...cP(cabangId), sampai]
  );
}

/** Layanan terlaris dalam rentang (qty & omzet, omzet gross-up utk item promo). */
async function layananTerlaris(cabangId, dari, sampai, limit = 8) {
  return db.query(
    `SELECT d.layanan_id, COALESCE(l.nama_paket, d.nama_item) AS nama,
            SUM(d.qty) AS qty,
            COALESCE(SUM(CASE WHEN l.is_promo = 1 THEN l.harga * d.qty ELSE d.subtotal END),0) AS omzet,
            COUNT(*) AS transaksi
     FROM transaksi t
     JOIN detail_transaksi d ON d.transaksi_id = t.id AND d.item_tipe='jasa'
     LEFT JOIN layanan l ON l.id = d.layanan_id
     WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar='lunas' AND DATE(t.tanggal) BETWEEN ? AND ?
     GROUP BY d.layanan_id, nama
     ORDER BY omzet DESC LIMIT ?`,
    [...cP(cabangId), dari, sampai, limit]
  );
}

/** Barang terlaris dalam rentang (qty & omzet). */
async function barangTerlaris(cabangId, dari, sampai, limit = 8) {
  return db.query(
    `SELECT d.barang_id, COALESCE(b.nama, d.nama_item) AS nama,
            SUM(d.qty) AS qty, COALESCE(SUM(d.subtotal),0) AS omzet
     FROM transaksi t
     JOIN detail_transaksi d ON d.transaksi_id = t.id AND d.item_tipe='barang'
     LEFT JOIN barang b ON b.id = d.barang_id
     WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar='lunas' AND DATE(t.tanggal) BETWEEN ? AND ?
     GROUP BY d.barang_id, nama
     ORDER BY omzet DESC LIMIT ?`,
    [...cP(cabangId), dari, sampai, limit]
  );
}

/** Mesin terlaku dalam rentang (jumlah pemakaian dari detail_transaksi.mesin_id). */
async function mesinTerlaku(cabangId, dari, sampai, limit = 10) {
  return db.query(
    `SELECT d.mesin_id, COALESCE(m.kode_mesin, CONCAT('Mesin #', d.mesin_id)) AS kode,
            m.nama_mesin, m.tipe, COUNT(*) AS pemakaian
     FROM transaksi t
     JOIN detail_transaksi d ON d.transaksi_id = t.id AND d.mesin_id IS NOT NULL
     LEFT JOIN mesin m ON m.id = d.mesin_id
     WHERE t.cabang_id IN (${cQ(cabangId)}) AND t.status_bayar='lunas' AND DATE(t.tanggal) BETWEEN ? AND ?
     GROUP BY d.mesin_id, kode, m.nama_mesin, m.tipe
     ORDER BY pemakaian DESC LIMIT ?`,
    [...cP(cabangId), dari, sampai, limit]
  );
}

/** Distribusi transaksi per jam (0-23) dalam rentang. */
async function jamRamai(cabangId, dari, sampai) {
  return db.query(
    `SELECT HOUR(tanggal) AS jam, COUNT(*) AS jumlah
     FROM transaksi
     WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas' AND DATE(tanggal) BETWEEN ? AND ?
     GROUP BY HOUR(tanggal) ORDER BY jam ASC`,
    [...cP(cabangId), dari, sampai]
  );
}

/** Tanggal transaksi pertama (patokan buka usaha). Return 'YYYY-MM-DD' atau null. */
async function tanggalTransaksiPertama(cabangId) {
  const row = await db.queryOne(
    `SELECT MIN(DATE(tanggal)) AS tgl FROM transaksi WHERE cabang_id IN (${cQ(cabangId)}) AND status_bayar='lunas'`,
    cP(cabangId)
  );
  return row && row.tgl ? String(row.tgl).slice(0, 10) : null;
}

/**
 * Daftar transaksi BELUM LUNAS milik 1 pelanggan di 1 cabang -- dipakai buat
 * checkbox "pilih tagihan yang mau dibayar sekaligus" di fitur QRIS dinamis
 * (Winpay). Cuma transaksi yang belum kepake di sesi pembayaran_qris lain
 * yang masih 'pending' yang muncul (join EXISTS negatif) -- biar gak bisa
 * dipilih dobel buat 2 sesi QR sekaligus.
 */
async function findBelumLunasByPelanggan(pelangganId, cabangId) {
  return db.query(
    `SELECT t.id, t.no_invoice, t.kode_antrian, t.tanggal, t.total, t.berat_kg, t.metode_bayar,
            (SELECT GROUP_CONCAT(DISTINCT d.nama_item ORDER BY d.id SEPARATOR ', ')
               FROM detail_transaksi d WHERE d.transaksi_id = t.id) AS item_label
     FROM transaksi t
     WHERE t.pelanggan_id = ? AND t.cabang_id = ? AND t.status_bayar = 'belum'
       AND NOT EXISTS (
         SELECT 1 FROM pembayaran_qris_transaksi pqt
         JOIN pembayaran_qris pq ON pq.id = pqt.pembayaran_qris_id
         WHERE pqt.transaksi_id = t.id AND pq.status = 'pending'
       )
     ORDER BY t.tanggal ASC, t.id ASC`,
    [pelangganId, cabangId]
  );
}

module.exports = {
  create, findById, findByInvoice,
  setTotal, setBayar, setBayarSaatAmbil, setStatus, setStatusPool, setKeranjang, setPosisiManual, adaTransaksiHari,
  findBelumSetor, stempelSetor,
  ringkasBelumSetor, transaksiAktif, ringkasHarian, ringkasRange,
  findByPelanggan, listForKasir, listRiwayat, statPelangganHariIni, ringkasOperasional,
  omzetPerMetodeHari, trenOmzetHarian, getPoinDidapat, setPoinDidapat,
  omzetMesinHarian, omzetTotalHarianSampaiJam, transaksiPelangganHarian,
  pelangganBaruLamaHarian, pelangganBaruSejakAwal, tanggalTransaksiPertama,
  layananTerlaris, barangTerlaris, mesinTerlaku, jamRamai,
  setPelanggan,
  pernahTransaksiLunasSebelum, sudahPakaiPromoHariIni, posisiPelangganHariIni,
  findBelumLunasByPelanggan,
};

/** Ganti pelanggan pada transaksi (untuk koreksi salah input nama). */
async function setPelanggan(conn, id, pelangganId) {
  await conn.execute(`UPDATE transaksi SET pelanggan_id = ? WHERE id = ?`, [pelangganId, id]);
}

/* ============================================================
   PROMO CUCI GRATIS (dipakai services/promo.service.js)
   Semua fungsi di bawah menerima `conn` (WAJIB) supaya jalan di dalam
   transaksi yang sama dengan lock generateNoInvoice -> anti race-condition.
   ============================================================ */

/**
 * True kalau pelanggan ini SUDAH PERNAH punya transaksi *lunas* sebelum
 * tanggal `ymd` (di cabang manapun). Dipakai buat cek "pelanggan baru".
 * Definisi ini sengaja SAMA dengan yang dipakai laporan performa
 * (statPelangganHariIni/pelangganBaruLamaHarian) -- pakai status_bayar='lunas'
 * sebagai patokan "pernah jadi pelanggan sungguhan", bukan sekadar pernah
 * bikin order yang mungkin batal/tidak jadi dibayar.
 */
async function pernahTransaksiLunasSebelum(conn, pelangganId, ymd) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM transaksi
     WHERE pelanggan_id = ? AND status_bayar = 'lunas' AND DATE(tanggal) < ?
     LIMIT 1`,
    [pelangganId, ymd]
  );
  return rows.length > 0;
}

/**
 * True kalau pelanggan ini SUDAH punya transaksi hari `ymd` (cabang manapun)
 * yang mengandung item layanan promo (is_promo=1). Guard "1 promo/pelanggan/hari".
 * Dicek lewat detail_transaksi + layanan (bukan kolom di transaksi) karena
 * promo sekarang direpresentasikan sebagai baris layanan tersendiri, bukan
 * field/diskon terpisah -- lihat models/layanan.model.js.
 */
async function sudahPakaiPromoHariIni(conn, pelangganId, ymd) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM transaksi t
     JOIN detail_transaksi dt ON dt.transaksi_id = t.id
     JOIN layanan l ON l.id = dt.layanan_id
     WHERE t.pelanggan_id = ? AND DATE(t.tanggal) = ? AND l.is_promo = 1
     LIMIT 1`,
    [pelangganId, ymd]
  );
  return rows.length > 0;
}

/**
 * Posisi urutan kedatangan pelanggan ini di cabang `cabangId` pada tanggal
 * `ymd`, dihitung dari transaksi PERTAMA masing-masing pelanggan hari itu.
 * - Kalau pelanggan ini sudah pernah transaksi hari ini (transaksi ke-2/3 dst
 *   di hari yang sama), posisinya TETAP sama dengan posisi transaksi
 *   pertamanya hari itu (tidak dapat nomor baru).
 * - Kalau ini transaksi PERTAMA pelanggan itu hari ini, posisinya = jumlah
 *   pelanggan lain yang sudah transaksi hari ini + 1.
 * Dipakai untuk kuota "5 pelanggan pertama" promo Jumat.
 */
async function posisiPelangganHariIni(conn, cabangId, ymd, pelangganId) {
  const [rows] = await conn.execute(
    `SELECT pelanggan_id, MIN(tanggal) AS pertama
     FROM transaksi
     WHERE cabang_id = ? AND DATE(tanggal) = ?
     GROUP BY pelanggan_id
     ORDER BY pertama ASC`,
    [cabangId, ymd]
  );
  const idx = rows.findIndex((r) => Number(r.pelanggan_id) === Number(pelangganId));
  return idx >= 0 ? idx + 1 : rows.length + 1;
}
