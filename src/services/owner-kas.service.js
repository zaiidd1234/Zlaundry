/**
 * src/services/owner-kas.service.js
 * =============================================================================
 * Perubahan #47 -- Buku Kas owner (pantau saja, tanpa input).
 * Per cabang + gabungan, rentang tanggal (default bulan berjalan):
 *  - Kas Besar : saldo s/d akhir rentang (sama dengan saldo cabang di Kas Besar
 *                manager: tanpa akrual), masuk / keluar per sumber, mutasi.
 *  - Kas Kecil : saldo cash / gopay saat ini, masuk / keluar per jenis mutasi.
 * =============================================================================
 */
const db = require('../config/database');
const kasBesarModel = require('../models/kas-besar.model');
const kasKecilModel = require('../models/kas-kecil.model');
const { today } = require('../helpers/date');
const { badRequest } = require('../helpers/errors');

const LABEL_BESAR = {
  setor_penjualan: 'Setor penjualan', reimburse: 'Reimburse belanja', opex: 'Biaya operasional', akrual: 'Beban akrual',
  biaya_loyalty: 'Biaya loyalty/promo', distribusi: 'Distribusi', winpay_mdr: 'Biaya MDR Winpay',
  winpay_titip: 'Dana Kios-K masuk Winpay', winpay_tarik: 'Tarik dana Winpay', // #83
};
const LABEL_KECIL = {
  modal: 'Modal', pendapatan: 'Pendapatan', konversi: 'Konversi', belanja_ops: 'Belanja operasional',
  setor: 'Setoran', reimburse: 'Reimburse', biaya_loyalty: 'Biaya loyalty/promo',
};
const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function bukuKas(q = {}) {
  const t = today();
  const dari = ymdOk(q.dari) ? q.dari : `${t.slice(0, 7)}-01`;
  const sampai = ymdOk(q.sampai) ? q.sampai : t;
  if (dari > sampai) throw badRequest('Rentang tanggal tidak valid');
  let cabang = await db.query(`SELECT id, kode, nama FROM cabang WHERE status = 'aktif' ORDER BY kode`);
  if (q.cabang_ids) {
    const ids = String(q.cabang_ids).split(',').map(Number).filter(Boolean);
    if (ids.length) cabang = cabang.filter((c) => ids.includes(Number(c.id)));
  }
  if (!cabang.length) return { dari, sampai, cabang: [], total: null, mutasi_besar: [] };
  const ids = cabang.map((c) => Number(c.id));
  const ph = ids.map(() => '?').join(',');

  const [besar, kecil, mutasi] = await Promise.all([
    db.query(`SELECT ref_cabang_id AS cabang_id, jenis, sumber, SUM(nominal) AS n FROM kas_besar
               WHERE ref_cabang_id IN (${ph}) AND DATE(tanggal) BETWEEN ? AND ? GROUP BY ref_cabang_id, jenis, sumber`, [...ids, dari, sampai]),
    db.query(`SELECT cabang_id, jenis, jenis_mutasi, SUM(nominal) AS n FROM kas_kecil
               WHERE cabang_id IN (${ph}) AND DATE(tanggal) BETWEEN ? AND ? AND COALESCE(metode_asal, '') <> 'kiosk'
               GROUP BY cabang_id, jenis, jenis_mutasi`, [...ids, dari, sampai]), // #83: Kios-K bukan kas kecil
    db.query(`SELECT kb.id, kb.tanggal, kb.jenis, kb.sumber, kb.nominal, kb.keterangan, kb.ref_cabang_id AS cabang_id,
                     c.kode AS cabang_kode, co.kode AS coa_kode, co.nama AS coa_nama
                FROM kas_besar kb LEFT JOIN cabang c ON c.id = kb.ref_cabang_id LEFT JOIN coa co ON co.id = kb.coa_id
               WHERE kb.ref_cabang_id IN (${ph}) AND DATE(kb.tanggal) BETWEEN ? AND ?
               ORDER BY kb.tanggal DESC, kb.id DESC LIMIT 500`, [...ids, dari, sampai]),
  ]);

  const per = await Promise.all(cabang.map(async (c) => {
    const [saldoBesar, saldoKecil] = await Promise.all([
      kasBesarModel.saldoCabang(c.id, { sampai }),
      kasKecilModel.saldo(c.id),
    ]);
    const kb = besar.filter((r) => Number(r.cabang_id) === Number(c.id));
    const kk = kecil.filter((r) => Number(r.cabang_id) === Number(c.id));
    const rinci = (rows, kunci, label) => rows.map((r) => ({ jenis: r.jenis, kode: r[kunci], label: label[r[kunci]] || r[kunci], nominal: Number(r.n) || 0 }))
      .sort((a, b) => (a.jenis === b.jenis ? b.nominal - a.nominal : a.jenis === 'masuk' ? -1 : 1));
    const sum = (rows, jenis) => rows.filter((r) => r.jenis === jenis).reduce((s, r) => s + (Number(r.n) || 0), 0);
    return {
      cabang_id: c.id, kode: c.kode, nama: c.nama,
      kas_besar: { saldo: saldoBesar, masuk: sum(kb, 'masuk'), keluar: sum(kb, 'keluar'), rinci: rinci(kb, 'sumber', LABEL_BESAR) },
      kas_kecil: { saldo: saldoKecil, masuk: sum(kk, 'masuk'), keluar: sum(kk, 'keluar'), rinci: rinci(kk, 'jenis_mutasi', LABEL_KECIL) },
    };
  }));
  const tot = (f) => per.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  return {
    dari, sampai, cabang: per,
    total: {
      kas_besar: { saldo: tot((x) => x.kas_besar.saldo), masuk: tot((x) => x.kas_besar.masuk), keluar: tot((x) => x.kas_besar.keluar) },
      kas_kecil: { saldo: tot((x) => x.kas_kecil.saldo.total), masuk: tot((x) => x.kas_kecil.masuk), keluar: tot((x) => x.kas_kecil.keluar) },
    },
    mutasi_besar: mutasi.map((m) => ({ ...m, nominal: Number(m.nominal) || 0, sumber_label: LABEL_BESAR[m.sumber] || m.sumber })),
  };
}

module.exports = { bukuKas };
