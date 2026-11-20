/**
 * src/constants/status.js
 * =============================================================================
 * Definisi 18 status workflow + aturan pemicu + efek (untuk state-machine).
 * Selaras dengan tabel status_master (kode & urutan), tapi 'trigger' & 'efek'
 * adalah logika aplikasi yang tidak disimpan di DB.
 *
 * trigger:
 *   'always'  -> selalu ada (menunggu_bayar, sudah_bayar)
 *   'pickup'  -> hanya jika TIDAK diantar (siap_diambil, sudah_diambil)
 *   [kategori]-> ada jika salah satu kategori layanan terpilih
 *
 * efek (flag yang dibaca service saat pindah status):
 *   allocMesin: 'washer'|'dryer'  -> wajib pilih mesin saat masuk status ini
 *   iotStart / openUsage          -> trigger IoT ON + buka sesi mesin_usage
 *   iotStop / closeUsage / addCycle -> trigger IoT OFF + tutup sesi + total_cycle+1
 *   bebaskanKeranjang             -> set keranjang kosong
 *   waNotif                       -> kirim notifikasi WhatsApp ke pelanggan
 *   mesinTipe                     -> tipe mesin terkait (untuk usage)
 * =============================================================================
 */

const STATUS = [
  { kode: 'menunggu_bayar',      urutan: 1,  trigger: 'always',                       efek: {} },
  { kode: 'sudah_bayar',         urutan: 2,  trigger: 'always',                       efek: { kas: true } },
  { kode: 'proses_jemput',       urutan: 3,  trigger: ['antar_jemput', 'jemput'],               efek: {} },
  { kode: 'selesai_jemput',      urutan: 4,  trigger: ['antar_jemput', 'jemput'],               efek: {} },
  { kode: 'alokasi_mesin_cuci',  urutan: 5,  trigger: ['cuci'],                       efek: { allocMesin: 'washer' } },
  { kode: 'mulai_cuci',          urutan: 6,  trigger: ['cuci'],                       efek: { iotStart: true, openUsage: true, mesinTipe: 'washer' } },
  { kode: 'selesai_cuci',        urutan: 7,  trigger: ['cuci'],                       efek: { iotStop: true, closeUsage: true, addCycle: true, mesinTipe: 'washer', waNotif: true } },
  { kode: 'alokasi_mesin_kering',urutan: 8,  trigger: ['kering'],                     efek: { allocMesin: 'dryer' } },
  { kode: 'mulai_kering',        urutan: 9,  trigger: ['kering'],                     efek: { iotStart: true, openUsage: true, mesinTipe: 'dryer' } },
  { kode: 'selesai_kering',      urutan: 10, trigger: ['kering'],                     efek: { iotStop: true, closeUsage: true, addCycle: true, mesinTipe: 'dryer', waNotif: true } },
  { kode: 'proses_setrika',      urutan: 11, trigger: ['setrika_lipat'],              efek: {} },
  { kode: 'selesai_setrika',     urutan: 12, trigger: ['setrika_lipat'],              efek: {} },
  { kode: 'proses_lipat',        urutan: 13, trigger: ['lipat'],                      efek: {} },
  { kode: 'selesai_lipat',       urutan: 14, trigger: ['lipat'],                      efek: {} },
  { kode: 'proses_antar',        urutan: 15, trigger: ['antar', 'antar_jemput'],      efek: { bebaskanKeranjang: true, waNotif: true } },
  { kode: 'selesai_antar',       urutan: 16, trigger: ['antar', 'antar_jemput'],      efek: { waNotif: true } },
  { kode: 'siap_diambil',        urutan: 17, trigger: 'pickup',                       efek: { waNotif: true } },
  { kode: 'sudah_diambil',       urutan: 18, trigger: 'pickup',                       efek: { bebaskanKeranjang: true, waNotif: true } },
];

// Index by kode untuk akses cepat
const BY_KODE = STATUS.reduce((m, s) => { m[s.kode] = s; return m; }, {});

// Kategori yang berarti "diantar" (maka tidak ada siap/sudah diambil)
const KATEGORI_DELIVERY = ['antar', 'antar_jemput']; // Perubahan #73: 'jemput' BUKAN delivery (pelanggan ambil sendiri)

module.exports = { STATUS, BY_KODE, KATEGORI_DELIVERY };
