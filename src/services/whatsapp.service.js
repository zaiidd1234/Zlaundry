/**
 * src/services/whatsapp.service.js
 * =============================================================================
 * Kirim notifikasi WhatsApp ke pelanggan saat status tertentu.
 * AMAN: kalau WA_API_URL kosong -> hanya log + balikin wa.me link (fallback manual).
 * TIDAK PERNAH throw -> kegagalan notif tidak menggagalkan perpindahan status.
 * Dipanggil SETELAH commit DB.
 * =============================================================================
 */

const { toWa, waLink } = require('../helpers/phone');
const logger = require('../config/logger');

const WA_API_URL = process.env.WA_API_URL;
const WA_API_TOKEN = process.env.WA_API_TOKEN;
const WEB_URL = process.env.WEB_URL || 'https://laundryku.com';
// Bypass/toggle notif "selesai cuci/kering" tanpa perlu ubah kode -> set 'false' di .env
// kalau mau dimatikan sementara (mis. lagi uji coba, atau WA API lagi bermasalah).
const WA_NOTIF_SELESAI_MESIN = process.env.WA_NOTIF_SELESAI_MESIN !== 'false';

/**
 * Nama usaha SESUAI CABANG transaksi -- murni dari tabel `cabang` (cabang.nama),
 * SAMA PERSIS pola pengambilannya kayak link_fb/link_ig/link_tiktok di buildFooter().
 * TIDAK ada fallback ke .env (biar gak ada cara nyasar balik ke identitas cabang lain).
 * Fallback terakhir cuma string generik kalau data cabang bener-bener kosong.
 */
function namaUsaha(cabang) {
  return (cabang && cabang.nama) || 'kami';
}

/**
 * Footer link untuk pesan penutup (saat cucian selesai diambil/diantar).
 * Ambil dari data cabang: review GMaps, IG, FB, TikTok + web.
 */
function buildFooter(cabang = {}) {
  const baris = [];
  baris.push('');
  baris.push('Pesan & cek status laundry kapan saja di:');
  baris.push(WEB_URL);

  const sos = [];
  if (cabang.link_gmap_review) sos.push(`- Review Google: ${cabang.link_gmap_review}`);
  if (cabang.link_ig) sos.push(`- Instagram: ${cabang.link_ig}`);
  if (cabang.link_fb) sos.push(`- Facebook: ${cabang.link_fb}`);
  if (cabang.link_tiktok) sos.push(`- TikTok: ${cabang.link_tiktok}`);
  if (sos.length) {
    baris.push('');
    baris.push('Dukung kami & ikuti update:');
    baris.push(...sos);
  }
  return baris.join('\n');
}

/**
 * Panggilan ke pelanggan: "Kak {nama}", KECUALI nama sudah mengandung kata
 * "Ibu"/"Bapak" (mis. dari kasir input "Ibu Sri", "Bapak Joko") -- itu udah
 * sopan sendiri, jangan ditumpuk jadi "Kak Ibu Sri".
 */
function sapaanNama(nama) {
  const n = (nama || '').trim();
  if (!n) return 'Kak';
  if (/\b(ibu|bapak)\b/i.test(n)) return n;
  return `Kak ${n}`;
}

/**
 * Buang prefix kode CABANG + leading zero dari kode_mesin sebelum ditampilkan
 * ke pelanggan (mis. "ZL02-W04" -> "W4") -- ID cabang gak relevan buat
 * pelanggan dan malah bikin rancu (dikira nomor lain), leading zero juga gak
 * perlu (pelanggan gak butuh format 2-digit). Kode mesin selalu format
 * "<KODE_CABANG>-<TIPE+NOMOR>" (lihat angkaDariKode() di mesin.service.js).
 * Samain persis sama pendekKode() di transaksi.service.js & tkPendekkanKode()
 * di public/customer/app.js biar konsisten di semua tempat (UI & WA).
 */
function kodeMesinTampil(kode) {
  const k = String(kode || '').trim();
  if (!k) return k;
  const idx = k.lastIndexOf('-');
  const tail = idx === -1 ? k : k.slice(idx + 1);
  const m = tail.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : tail;
}

/**
 * Pendekkan kode_antrian/kode keranjang buat ditampilin ke pelanggan: cukup
 * buang prefix cabang (segmen pertama sebelum dash pertama), SISANYA
 * dipertahankan apa adanya -- beda dari kodeMesinTampil() yang juga buang
 * leading zero, soalnya format keranjang ("ZL02-K-103") punya 2 dash dan
 * bagian "K-103" bukan kode mesin (gak ada leading-zero yang perlu dibuang).
 * Contoh: "ZL02-K-103" -> "K-103".
 */
function kodeKeranjangTampil(kode) {
  const k = String(kode || '').trim();
  if (!k) return k;
  const idx = k.indexOf('-');
  return idx === -1 ? k : k.slice(idx + 1);
}

/**
 * Perubahan #33: arti jumlah Drop-off.
 *   'parsial' = drop-off 1x pada order cuci + kering: customer memasukkan ke
 *               mesin cuci, KARYAWAN memindahkan ke pengering, customer
 *               mengeluarkan sendiri dari pengering (posisi akhir: pengering).
 *   'penuh'   = drop-off 2x (cuci + kering), atau drop-off pada cuci saja /
 *               kering saja: semua dikerjakan karyawan, posisi akhir keranjang.
 *   null      = tanpa drop-off.
 */
function modeDropOff(kategoriList = [], dropOffQty = 0) {
  if (!kategoriList.includes('drop_off')) return null;
  const cuciKering = kategoriList.includes('cuci') && kategoriList.includes('kering');
  return cuciKering && Number(dropOffQty || 1) < 2 ? 'parsial' : 'penuh';
}

/* =============================================================================
 * Perubahan #36 -- semua pesan WA dibuat SINGKAT & sesuai siapa yang bekerja:
 *   - non drop-off : pelanggan sendiri memasukkan cucian, isi sabun & pewangi
 *                    di wadah mesin (bawa sendiri / beli di kasir), tutup pintu.
 *   - drop-off     : petugas yang mengerjakan (lihat modeDropOff di atas).
 * Info mesin dari antrian terkunci: siap dipakai / antrian ke-N ± menit /
 * menunggu pelanggan sebelumnya mengeluarkan cucian.
 * Footer link aplikasi & sosmed hanya di pesan PENUTUP (diambil / sampai).
 * ============================================================================= */
const rp = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`;
const SABUN = 'isi sabun & pewangi di wadah sabun/pewangi mesin (bawa sendiri atau beli di kasir)';

/** Teks kondisi mesin janji dari info antrian. */
function kondisiAntrian(antrian) {
  if (!antrian) return '';
  if (antrian.siap_tunggu_bongkar) return 'menunggu pelanggan sebelumnya mengeluarkan cucian';
  if (antrian.teralokasi) return 'siap dipakai';
  const n = Number(antrian.antrian_ke || antrian.posisi);
  const ke = n > 0 ? `antrian ke-${n}, ` : 'antrian, ';
  return `${ke}± ${Math.max(1, Math.round(antrian.tunggu_menit || 0))} menit`;
}
const siapPakai = (antrian) => !!(antrian && antrian.teralokasi && !antrian.siap_tunggu_bongkar);

function barisMesin(tipe, antrian) {
  if (!antrian || !antrian.kode_mesin_pendek) return '';
  const label = tipe === 'dryer' ? '🌀 Mesin pengering' : '🫧 Mesin cuci';
  return `\n${label}: *${antrian.kode_mesin_pendek}* — ${kondisiAntrian(antrian)}`;
}

/** Instruksi tahap awal (masuk mesin cuci / pengering untuk "kering saja"). */
function instruksiAwal({ kategoriList, dropOffQty, antrian, tipe }) {
  const mode = modeDropOff(kategoriList, dropOffQty);
  if (!kategoriList.includes('cuci') && !kategoriList.includes('kering')) return '';
  if (mode === 'penuh') return '\nCucian dikerjakan petugas kami, Kakak tidak perlu menunggu. Kami kabari saat selesai.';
  const kode = antrian && antrian.kode_mesin_pendek;
  const awalan = kode && !siapPakai(antrian) ? 'Saat mesin siap, silakan' : 'Silakan';
  let t;
  if (tipe === 'dryer') {
    t = kode ? `\n${awalan} masukkan cucian ke pengering ${kode}, tutup pintu rapat, lalu tekan *Mulai Kering* di aplikasi.`
      : '\nSilakan masukkan cucian ke mesin pengering lalu tutup pintu rapat.';
  } else {
    t = kode ? `\n${awalan} masukkan cucian ke mesin ${kode}, ${SABUN}, tutup pintu sampai bunyi klik, lalu tekan *Mulai* di aplikasi.`
      : `\nSilakan masukkan cucian ke mesin cuci, ${SABUN}, lalu tutup pintu sampai bunyi klik.`;
  }
  if (mode === 'parsial') t += '\nSetelah cuci selesai, petugas kami yang memindahkan ke pengering.';
  return t;
}

/** Tipe mesin tahap awal: cuci, atau pengering kalau "kering saja". */
function tipeAwal(kategoriList, antrian) {
  if (antrian && antrian.tipe) return antrian.tipe;
  return !kategoriList.includes('cuci') && kategoriList.includes('kering') ? 'dryer' : 'washer';
}

const lanjutLipat = (kategoriList) => (kategoriList.includes('setrika_lipat')
  ? '\nCucian lanjut disetrika & dilipat petugas, kami kabari saat siap diambil.'
  : '\nCucian lanjut dilipat petugas, kami kabari saat siap diambil.');
const tagihanBaris = (tagihan) => (tagihan != null && Number(tagihan) > 0 ? `\n💳 Tagihan *${rp(tagihan)}* dibayar saat ambil.` : '');

/**
 * Template pesan per status.
 *  antrian  : info mesin janji ({kode_mesin_pendek, teralokasi, posisi, tunggu_menit, siap_tunggu_bongkar, tipe?})
 *             -- mesin cuci saat bayar; mesin PENGERING saat selesai_cuci.
 *  kodeMesin: mesin yang baru selesai / tempat cucian sekarang.
 *  tagihan  : sisa tagihan "bayar saat ambil" (null kalau sudah lunas).
 *  sisaMenit: untuk 'proses_mesin' (sedang jalan).
 */
function buildMessage(statusKode, {
  nama, noInvoice, cabang, kodeKeranjang, kodeMesin, kategoriList = [], posisiManual = null,
  antrian = null, total = null, dropOffQty = 0, tagihan = null, sisaMenit = null, tipeMesin = null,
} = {}) {
  const hai = `Halo ${sapaanNama(nama)} 👋`;
  const inv = noInvoice ? `*${noInvoice}*` : 'Anda';
  const usaha = namaUsaha(cabang);
  const krj = kodeKeranjangTampil(kodeKeranjang);
  const m = kodeMesinTampil(kodeMesin);
  const krjBaris = krj ? `\n🧺 Keranjang: *${krj}*` : '';
  const keKrj = krj ? `keranjang *${krj}*` : 'keranjang';
  const mode = modeDropOff(kategoriList, dropOffQty);
  const adaCuci = kategoriList.includes('cuci');
  const adaKering = kategoriList.includes('kering');
  const adaLipat = kategoriList.includes('lipat') || kategoriList.includes('setrika_lipat');
  const diKeranjang = posisiManual === 'keranjang';

  const badanAwal = () => {
    const tipe = tipeAwal(kategoriList, antrian);
    return `${krjBaris}${barisMesin(tipe, antrian)}${instruksiAwal({ kategoriList, dropOffQty, antrian, tipe })}`;
  };

  switch (statusKode) {
    case 'sudah_bayar':
      return `${hai}\nPembayaran ${inv} LUNAS ✅${badanAwal()}`;
    // Perubahan #13: diproses dulu, bayar saat ambil
    case 'bayar_saat_ambil': {
      const tg = total != null ? `, tagihan *${rp(total)}* dibayar saat ambil` : ', dibayar saat ambil';
      return `${hai}\nPesanan ${inv} kami terima${tg}.${badanAwal()}`;
    }
    // popup mesin: order teralokasi / antre (belum mulai)
    case 'giliran':
      return `${hai}\nPesanan ${inv}${krj ? ` (${krj})` : ''}${barisMesin(tipeAwal(kategoriList, antrian), antrian)}${instruksiAwal({ kategoriList, dropOffQty, antrian, tipe: tipeAwal(kategoriList, antrian) })}`;
    case 'lunas_saat_ambil':
      return `${hai}\nPembayaran ${inv}${total != null ? ` ${rp(total)}` : ''} LUNAS ✅ Terima kasih 🙏`;
    // popup mesin: sedang jalan
    case 'proses_mesin': {
      const kerja = tipeMesin === 'dryer' ? 'dikeringkan' : 'dicuci';
      const sisa = sisaMenit != null ? `, sisa ± ${Math.max(1, Math.round(sisaMenit))} menit` : '';
      return `${hai}\nCucian ${inv} sedang ${kerja}${m ? ` di *${m}*` : ''}${sisa}. Kami kabari saat selesai 🙏`;
    }
    case 'selesai_cuci': {
      if (adaKering) {
        if (diKeranjang) return `${hai}\nCuci ${inv} selesai ✅\nCucian sudah kami pindahkan ke ${keKrj}.`;
        if (mode) {
          const d = antrian && antrian.kode_mesin_pendek;
          return `${hai}\nCuci ${inv} selesai ✅\nPetugas kami memindahkan cucian ke pengering${d ? ` *${d}*` : ''}.`;
        }
        const d = antrian && antrian.kode_mesin_pendek;
        const baris = d ? `\n🌀 Pengering: *${d}* — ${kondisiAntrian(antrian)}` : '';
        const awalan = d && !siapPakai(antrian) ? 'Saat pengering siap, silakan' : 'Silakan';
        const ins = d ? `\n${awalan} pindahkan cucian ke ${d}, tutup pintu rapat, lalu tekan *Mulai Kering* di aplikasi.`
          : '\nSilakan pindahkan cucian ke mesin pengering, tutup pintu rapat, lalu tekan *Mulai Kering* di aplikasi.';
        return `${hai}\nCuci ${inv} selesai${m ? ` di *${m}*` : ''} ✅${baris}${ins}`;
      }
      if (adaLipat) return `${hai}\nCuci ${inv} selesai ✅${lanjutLipat(kategoriList)}`;
      if (mode || diKeranjang) return `${hai}\nCuci ${inv} selesai ✅\n${diKeranjang ? 'Cucian sudah kami pindahkan' : 'Petugas kami memindahkan cucian'} ke ${keKrj}.${tagihanBaris(tagihan)}`;
      return `${hai}\nCuci ${inv} selesai ✅\nCucian ada di mesin${m ? ` *${m}*` : ''}, silakan segera diambil ya.${tagihanBaris(tagihan)}`;
    }
    case 'selesai_kering': {
      if (adaLipat) return `${hai}\nKering ${inv} selesai ✅${lanjutLipat(kategoriList)}`;
      if (diKeranjang) return `${hai}\nKering ${inv} selesai ✅\nCucian sudah kami pindahkan ke ${keKrj}, silakan diambil ya.${tagihanBaris(tagihan)}`;
      if (mode === 'penuh') return `${hai}\nKering ${inv} selesai ✅\nPetugas kami memindahkan cucian ke ${keKrj}.${tagihanBaris(tagihan)}`;
      return `${hai}\nKering ${inv} selesai ✅\nCucian ada di pengering${m ? ` *${m}*` : ''}, silakan dikeluarkan & diambil ya.${tagihanBaris(tagihan)}`;
    }
    // popup: sedang dilipat / disetrika
    case 'proses_lipat':
    case 'proses_setrika':
    case 'selesai_setrika':
    case 'selesai_lipat': {
      const kerja = statusKode === 'selesai_lipat' ? 'sudah selesai dilipat, sedang kami siapkan' : (kategoriList.includes('setrika_lipat') ? 'sedang disetrika & dilipat petugas' : 'sedang dilipat petugas');
      return `${hai}\nCucian ${inv} ${kerja}. Kami kabari saat siap diambil 🙏`;
    }
    case 'siap_diambil': {
      let lok;
      if (diKeranjang || adaLipat || mode === 'penuh' || !m || !(adaCuci || adaKering)) lok = krj ? `Keranjang *${krj}*` : '';
      else lok = adaKering ? `Pengering *${m}*` : `Mesin cuci *${m}*`;
      return `${hai}\nCucian ${inv} SIAP DIAMBIL ✅${lok ? `\n📍 ${lok}` : ''}${tagihanBaris(tagihan)}`;
    }
    case 'proses_antar':
      return `${hai}\nCucian ${inv} sedang diantar ke alamat Kakak 🛵`;
    case 'selesai_antar':
      return `${hai}\nCucian ${inv} sudah sampai ✅ Terima kasih sudah laundry di ${usaha} 🙏${buildFooter(cabang)}`;
    case 'sudah_diambil':
      return `${hai}\nTerima kasih sudah laundry di ${usaha} 🙏 (${inv}). Sampai jumpa lagi!${buildFooter(cabang)}`;
    default:
      return `${hai}\nStatus pesanan ${inv}: ${statusKode}.`;
  }
}

/* ---- Perubahan #36: pindah mesin (#20) & geser antrian (#1) ---- */
const jenisMesin = (tipe) => (tipe === 'dryer' ? 'pengering' : 'mesin');

/** Ke pelanggan yang order-nya DIPINDAH ke mesin lain. */
function pesanPindah({ nama, noInvoice, kodeKeranjang, dari, antrian, tipe }) {
  const krj = kodeKeranjangTampil(kodeKeranjang);
  const ke = antrian && antrian.kode_mesin_pendek;
  const kond = siapPakai(antrian) ? 'siap dipakai sekarang' : kondisiAntrian(antrian);
  return `Halo ${sapaanNama(nama)} 👋\n${tipe === 'dryer' ? 'Pengering' : 'Mesin'} untuk pesanan *${noInvoice}*${krj ? ` (${krj})` : ''} kami pindahkan ke *${ke}* (sebelumnya ${dari})${kond ? ` — ${kond}` : ''}. Mohon maaf atas perubahannya 🙏`;
}

/** Ke pelanggan yang tergeser / urutannya berubah. alasan: 'didahului' | 'naik' | 'turun' | 'maju'. */
function pesanUrutan({ nama, noInvoice, kodeKeranjang, antrian, tipe, sebab = 'turun', mesinPengganti = null }) {
  const krj = kodeKeranjangTampil(kodeKeranjang);
  const hai = `Halo ${sapaanNama(nama)} 👋`;
  const pes = `*${noInvoice}*${krj ? ` (${krj})` : ''}`;
  const kode = antrian && antrian.kode_mesin_pendek;
  if (!kode) return `${hai}\nUrutan mesin untuk pesanan ${pes} berubah. Silakan cek di aplikasi ya 🙏`;
  if (siapPakai(antrian)) {
    return `${hai}\nGiliran pesanan ${pes} dimajukan, ${jenisMesin(tipe)} *${kode}* siap dipakai sekarang. Silakan datang ya 🙏`;
  }
  const menit = Math.max(1, Math.round(antrian.tunggu_menit || 0));
  const n = Number(antrian.antrian_ke || antrian.posisi);
  const ke = n > 0 ? `antrian ke-${n}` : 'antrian';
  if (sebab === 'didahului') {
    return `${hai}\nKarena ${jenisMesin(tipe)} ${kode} sudah siap tapi Kakak belum datang, giliran pesanan ${pes} kami geser ke ${ke} di ${kode}, ± ${menit} menit. Silakan datang sebelum waktu itu ya 🙏`;
  }
  const tunggu = antrian.siap_tunggu_bongkar ? 'menunggu pelanggan sebelumnya mengeluarkan cucian' : `estimasi mulai ± ${menit} menit`;
  return `${hai}\nUrutan antrian pesanan ${pes} di ${jenisMesin(tipe)} ${kode} sekarang *${ke.replace('antrian ', '')}*, ${tunggu}.${sebab === 'turun' ? ' Mohon maaf atas perubahannya 🙏' : ''}`;
}

/**
 * Kirim notifikasi status. Return { sent, skipped, link }.
 */
async function notifStatus({ telepon, nama, noInvoice, statusKode, cabang, kodeKeranjang, kodeMesin, kategoriList, posisiManual, antrian = null, dropOffQty = 0, tagihan = null }) {
  // Bypass: notif selesai cuci/kering bisa dimatikan sementara lewat .env
  // (WA_NOTIF_SELESAI_MESIN=false) tanpa perlu ubah kode / redeploy.
  const isNotifMesin = statusKode === 'selesai_cuci' || statusKode === 'selesai_kering';
  if (isNotifMesin && !WA_NOTIF_SELESAI_MESIN) {
    logger.info(`WA notif "${statusKode}" di-bypass (WA_NOTIF_SELESAI_MESIN=false)`);
    return { sent: false, skipped: true };
  }

  const pesan = buildMessage(statusKode, { nama, noInvoice, cabang, kodeKeranjang, kodeMesin, kategoriList, posisiManual, antrian, dropOffQty, tagihan });
  const tujuan = toWa(telepon);
  if (!tujuan) {
    logger.warn('WA notif dilewati: nomor pelanggan kosong/invalid', { statusKode });
    return { sent: false, skipped: true };
  }

  // Belum ada API WA -> log + sediakan link wa.me untuk dikirim manual
  if (!WA_API_URL) {
    const link = waLink(telepon, pesan);
    logger.info(`[WA disabled] ${tujuan}: ${pesan}`);
    return { sent: false, skipped: true, link };
  }

  try {
    const resp = await fetch(WA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WA_API_TOKEN}` },
      body: JSON.stringify({ to: tujuan, message: pesan }),
    });
    if (!resp.ok) {
      logger.error('WA API gagal', { status: resp.status, statusKode });
      return { sent: false, skipped: false };
    }
    logger.info('WA notif terkirim', { to: tujuan, statusKode });
    return { sent: true, skipped: false };
  } catch (err) {
    logger.error('WA API error', { err: err.message, statusKode });
    return { sent: false, skipped: false };
  }
}

module.exports = { notifStatus, buildMessage, modeDropOff, pesanPindah, pesanUrutan, kodeMesinTampil };
