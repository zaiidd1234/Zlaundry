/**
 * src/services/jatah.service.js
 * =============================================================================
 * Perubahan #39 -- jatah cuci kasir.
 *  - Tiap akun ber-role KASIR punya jatah per minggu (karyawan.jatah_cuci_mingguan,
 *    default Rp20.000 (#45); manager bisa ubah per karyawan, 0 = tidak dapat).
 *  - Minggu = Senin 00:00 s/d Minggu 23:59 WIB. Sisa tidak terbawa (hangus).
 *  - Dipakai lewat kasir › Pesankan › "Pesan untuk saya": hanya layanan cuci &
 *    kering, harga normal. Jatah menanggung sebagian/seluruh harga; kelebihan
 *    jadi tagihan biasa (cash/QRIS -> masuk kas seperti order lain).
 *  - Bagian jatah TIDAK masuk pembukuan: item order disimpan dengan harga
 *    setelah dipotong jatah, jadi omzet/kas/setoran hanya berisi yang dibayar.
 *    Nilai jatahnya tercatat di tabel jatah_cuci_pakai.
 * =============================================================================
 */

const db = require('../config/database');
const { today } = require('../helpers/date');
const { normalizeHp } = require('../helpers/phone');
const { badRequest, forbidden, notFound } = require('../helpers/errors');

const KATEGORI_BOLEH = ['cuci', 'kering'];

/** Senin & Minggu dari minggu yang memuat tanggal ymd (WIB). */
function rentangMinggu(ymd = today()) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7; // Senin = 0
  const senin = new Date(t.getTime() - dow * 86400000);
  const minggu = new Date(senin.getTime() + 6 * 86400000);
  const f = (x) => x.toISOString().slice(0, 10);
  return { mulai: f(senin), akhir: f(minggu) };
}

async function ambilKaryawan(karyawanId, conn = null) {
  const sql = `SELECT k.id, k.cabang_id, k.nama, k.telepon, k.status, k.jatah_cuci_mingguan, r.nama_role AS role
                 FROM karyawan k JOIN role r ON r.id = k.role_id WHERE k.id = ?${conn ? ' FOR UPDATE' : ''}`;
  if (conn) { const [rows] = await conn.execute(sql, [karyawanId]); return rows[0] || null; }
  return db.queryOne(sql, [karyawanId]);
}

async function terpakai(karyawanId, mulai, conn = null) {
  const sql = `SELECT COALESCE(SUM(nominal), 0) AS n FROM jatah_cuci_pakai WHERE karyawan_id = ? AND minggu_mulai = ?`;
  if (conn) { const [rows] = await conn.execute(sql, [karyawanId, mulai]); return Number(rows[0].n) || 0; }
  const r = await db.queryOne(sql, [karyawanId, mulai]);
  return Number(r.n) || 0;
}

/** Status jatah minggu ini untuk 1 karyawan (+ riwayat pemakaian minggu ini). */
async function status(karyawanId) {
  const k = await ambilKaryawan(karyawanId);
  if (!k) throw notFound('Karyawan tidak ditemukan');
  const m = rentangMinggu();
  const berhak = k.role === 'kasir' && Number(k.jatah_cuci_mingguan) > 0;
  const nominal = berhak ? Number(k.jatah_cuci_mingguan) : 0;
  const pakai = await terpakai(k.id, m.mulai);
  const riwayat = await db.query(
    `SELECT j.transaksi_id, j.nilai_order, j.nominal, j.created_at, t.no_invoice, t.total,
            (SELECT GROUP_CONCAT(d.nama_item SEPARATOR ' + ') FROM detail_transaksi d WHERE d.transaksi_id = t.id) AS layanan
       FROM jatah_cuci_pakai j JOIN transaksi t ON t.id = j.transaksi_id
      WHERE j.karyawan_id = ? AND j.minggu_mulai = ? ORDER BY j.id DESC`, [k.id, m.mulai]);
  return {
    karyawan_id: k.id, nama: k.nama, telepon: k.telepon || null, berhak,
    nominal, terpakai: pakai, sisa: Math.max(0, nominal - pakai),
    minggu_mulai: m.mulai, minggu_akhir: m.akhir,
    riwayat: riwayat.map((r) => ({
      transaksi_id: r.transaksi_id, no_invoice: r.no_invoice, waktu: r.created_at,
      layanan: String(r.layanan || '').replace(/ \(jatah\)/g, ''), nilai_order: Number(r.nilai_order) || 0,
      jatah: Number(r.nominal) || 0, dibayar: Number(r.total) || 0,
    })),
  };
}

/** Kasir isi / ganti nomor HP sendiri. */
async function setTelepon(karyawanId, telepon) {
  const hp = normalizeHp(telepon);
  if (!/^08\d{8,12}$/.test(hp)) throw badRequest('Nomor HP tidak valid (contoh 08123456789)');
  await db.query(`UPDATE karyawan SET telepon = ? WHERE id = ?`, [hp, karyawanId]);
  return status(karyawanId);
}

/**
 * Dipanggil di dalam transaksi DB createOrder (sebelum subtotal dihitung).
 * Memotong harga item cuci/kering dengan sisa jatah (urut item), mengubah
 * `items` di tempat. Return { karyawan, nilaiOrder, nominal, minggu }.
 */
async function terapkan(conn, karyawanId, items) {
  const k = await ambilKaryawan(karyawanId, conn);
  if (!k || k.status !== 'aktif') throw forbidden('Akun tidak ditemukan / nonaktif');
  if (k.role !== 'kasir') throw forbidden('Jatah cuci hanya untuk akun kasir');
  if (!(Number(k.jatah_cuci_mingguan) > 0)) throw forbidden('Akun ini tidak mendapat jatah cuci');
  const salah = items.find((it) => it.item_tipe !== 'jasa' || !KATEGORI_BOLEH.includes(it.kategori));
  if (salah) throw badRequest('Pesanan jatah karyawan hanya boleh layanan cuci dan kering');
  const m = rentangMinggu();
  let sisa = Math.max(0, Number(k.jatah_cuci_mingguan) - await terpakai(k.id, m.mulai, conn));
  let nilaiOrder = 0; let nominal = 0;
  const urut = [...items].sort((a, b) => (a.kategori === 'cuci' ? 0 : 1) - (b.kategori === 'cuci' ? 0 : 1));
  for (const it of urut) {
    nilaiOrder += Number(it.subtotal) || 0;
    const potong = Math.min(sisa, Number(it.subtotal) || 0);
    if (potong > 0) {
      it.subtotal = Math.round((Number(it.subtotal) - potong) * 100) / 100;
      it.harga_satuan = Math.round((it.subtotal / (Number(it.qty) || 1)) * 100) / 100;
      it.nama_item = `${it.nama_item} (jatah)`;
      sisa -= potong; nominal += potong;
    }
  }
  return { karyawan: k, nilaiOrder, nominal, minggu: m.mulai };
}

async function catat(conn, { karyawanId, cabangId, transaksiId, minggu, nilaiOrder, nominal }) {
  await conn.execute(
    `INSERT INTO jatah_cuci_pakai (karyawan_id, cabang_id, transaksi_id, minggu_mulai, nilai_order, nominal) VALUES (?,?,?,?,?,?)`,
    [karyawanId, cabangId, transaksiId, minggu, nilaiOrder, nominal]);
}

/** Order jatah? (tidak dapat poin pelanggan, tidak boleh diubah layanannya) */
async function orderJatah(transaksiId, conn = null) {
  const sql = `SELECT id FROM jatah_cuci_pakai WHERE transaksi_id = ? LIMIT 1`;
  if (conn) { const [rows] = await conn.execute(sql, [transaksiId]); return !!rows[0]; }
  return !!(await db.queryOne(sql, [transaksiId]));
}

module.exports = { rentangMinggu, status, setTelepon, terapkan, catat, orderJatah, KATEGORI_BOLEH };
