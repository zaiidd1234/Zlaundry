#!/usr/bin/env node
/**
 * src/tools/winpay-tes-sandbox.js  -- Perubahan #78
 * =============================================================================
 * Tes koneksi Winpay SNAP QRIS dari server hosting, TANPA menyentuh database
 * dan TANPA mengubah winpay_aktif. Rahasia (private key, partner ID) tidak
 * pernah dicetak utuh.
 *
 * Cara pakai (dari folder aplikasi, mis. ~/zlaundry_app):
 *   node src/tools/winpay-tes-sandbox.js                 # cek .env + generate QR Rp1.000 + query + cancel
 *   node src/tools/winpay-tes-sandbox.js 2500            # nominal lain
 *   node src/tools/winpay-tes-sandbox.js --biarkan       # QR tidak di-cancel (buat coba bayar di sandbox)
 *   node src/tools/winpay-tes-sandbox.js --debug         # tampilkan isi request (tanpa rahasia)
 *   node src/tools/winpay-tes-sandbox.js --coba          # coba beberapa variasi header/format, cari yang lolos
 *   node src/tools/winpay-tes-sandbox.js --cek-callback=https://zlaundry.biz.id
 *        # cek URL callback bisa diakses dari luar (harus ditolak 401 "Invalid signature")
 * =============================================================================
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const winpayConfig = require('../config/winpay');
const winpayService = require('../services/winpay.service');

const args = process.argv.slice(2);
const biarkan = args.includes('--biarkan');
if (args.includes('--debug')) process.env.WINPAY_DEBUG = '1';
const argCb = args.find((a) => a.startsWith('--cek-callback'));
const nominal = Number(args.find((a) => /^\d+$/.test(a)) || 1000);

const garis = () => console.log('-'.repeat(60));
const ok = (m) => console.log('  ✅ ' + m);
const gagal = (m) => console.log('  ❌ ' + m);

async function cekCallback(base) {
  const url = base.replace(/\/+$/, '') + '/api/winpay/v1.0/qr/qr-mpm-notify';
  console.log('\n[CALLBACK] POST tanpa signature ke ' + url);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tes: true }) });
    const t = await r.text();
    if (r.status === 401 && /Invalid signature/i.test(t)) ok('URL callback bisa diakses & menolak request tanpa signature (benar).');
    else gagal(`Respons tidak sesuai: HTTP ${r.status} ${t.slice(0, 200)}`);
  } catch (e) {
    gagal('Tidak bisa mengakses URL callback: ' + e.message);
  }
}

async function cobaVariasi() {
  const VARIASI = [
    { nama: 'A. sekarang (ext-id 16 digit, channel 95221)', env: {}, ch: null },
    { nama: 'B. ext-id 10 digit (spt contoh docs)', env: { WINPAY_EXTERNAL_ID_LEN: '10' }, ch: null },
    { nama: 'C. channel WEB (spt contoh docs)', env: { WINPAY_EXTERNAL_ID_LEN: '10' }, ch: 'WEB' },
    { nama: 'D. header huruf besar (X-TIMESTAMP dst)', env: { WINPAY_EXTERNAL_ID_LEN: '10', WINPAY_HEADER_BESAR: '1' }, ch: 'WEB' },
    { nama: 'E. nominal tanpa desimal', env: { WINPAY_EXTERNAL_ID_LEN: '10', WINPAY_AMOUNT_BULAT: '1' }, ch: 'WEB' },
    { nama: 'F. ext-id 22 digit (versi lama)', env: { WINPAY_EXTERNAL_ID_LEN: '22' }, ch: null },
    { nama: 'G. validityPeriod format UTC "…Z" (spt tabel docs)', env: { WINPAY_EXTERNAL_ID_LEN: '10', WINPAY_VALIDITY_UTC: '1' }, ch: 'WEB' },
  ];
  const chAsli = winpayConfig.WINPAY_CHANNEL_ID;
  console.log('\n[COBA VARIASI] tiap variasi bikin 1 QR Rp' + nominal.toLocaleString('id-ID') + ' (yang lolos langsung di-cancel)');
  const lolos = [];
  for (const v of VARIASI) {
    const simpan = {};
    for (const [k, val] of Object.entries(v.env)) { simpan[k] = process.env[k]; process.env[k] = val; }
    winpayConfig.WINPAY_CHANNEL_ID = v.ch || chAsli;
    const ref = `ZLTES${Date.now()}`;
    try {
      const qr = await winpayService.generateQr({ partnerReferenceNo: ref, amount: nominal, validityMinutes: 15 });
      ok(`${v.nama} -> ${qr.raw.responseCode} ${qr.raw.responseMessage || ''}`);
      lolos.push(v.nama);
      await winpayService.cancel({ partnerReferenceNo: ref, contractId: qr.contractId, reason: 'Tes koneksi' }).catch(() => {});
    } catch (e) {
      const r = e.winpayResponse || {};
      gagal(`${v.nama} -> ${r.responseCode || ''} ${r.responseMessage || e.message}`);
    }
    for (const k of Object.keys(v.env)) { if (simpan[k] === undefined) delete process.env[k]; else process.env[k] = simpan[k]; }
    await new Promise((r) => setTimeout(r, 1100)); // ext-id 10 digit = per detik
  }
  winpayConfig.WINPAY_CHANNEL_ID = chAsli;
  garis();
  console.log(lolos.length ? 'LOLOS: ' + lolos.join(' | ') : 'Semua variasi masih ditolak -> kirim hasil ini + X-External-ID ke admin Winpay.');
}

(async () => {
  garis();
  console.log('TES WINPAY SNAP QRIS');
  garis();
  const r = winpayConfig.ringkasanKonfigurasi();
  console.log('[KONFIGURASI .env]');
  console.log('  WINPAY_BASE_URL   :', r.base_url || '(kosong)');
  console.log('  WINPAY_PARTNER_ID :', r.partner_id || '(kosong)');
  console.log('  WINPAY_CHANNEL_ID :', r.channel_id);
  const pk = r.private_key, pub = r.public_key_winpay;
  console.log('  WINPAY_PRIVATE_KEY:', !pk.ada ? '(kosong)' : pk.valid ? `OK (${pk.tipe} ${pk.bit} bit)` : 'TIDAK VALID -> ' + pk.error);
  console.log('  WINPAY_PUBLIC_KEY :', !pub.ada ? '(kosong)' : pub.valid ? `OK (${pub.tipe} ${pub.bit} bit)` : 'TIDAK VALID -> ' + pub.error);
  if (r.base_url && /bmstaging|sandbox/i.test(r.base_url)) console.log('  Mode              : SANDBOX');
  else if (r.base_url && /snap\.winpay\.id/i.test(r.base_url)) console.log('  Mode              : PRODUCTION (hati-hati, transaksi nyata!)');
  else if (r.base_url) console.log('  Mode              : LAIN (bukan alamat Winpay resmi -- mock/tes?)');

  if (argCb) {
    const base = argCb.split('=')[1];
    if (!base) gagal('Pakai format --cek-callback=https://domain-anda');
    else await cekCallback(base);
  }

  if (!r.siap_kirim || !pk.valid) {
    gagal('Konfigurasi belum lengkap/valid untuk kirim request. Perbaiki .env lalu jalankan lagi.');
    process.exit(1);
  }

  if (args.includes('--coba')) { await cobaVariasi(); return; }

  const ref = `ZLTES${Date.now()}`;
  console.log(`\n[1] GENERATE QR  ref=${ref}  nominal=Rp${nominal.toLocaleString('id-ID')}`);
  let qr;
  try {
    qr = await winpayService.generateQr({ partnerReferenceNo: ref, amount: nominal, validityMinutes: 15 });
    ok(`Berhasil (responseCode ${qr.raw.responseCode} ${qr.raw.responseMessage || ''})`);
    console.log('     contractId :', qr.contractId);
    console.log('     qrUrl      :', qr.qrUrl && qr.qrUrl.length > 120 ? qr.qrUrl.slice(0, 60) + '… (' + qr.qrUrl.length + ' char)' : qr.qrUrl);
    console.log('     qrContent  :', qr.qrContent ? qr.qrContent.slice(0, 40) + '…' : '(kosong)');
    console.log('     expiredAt  :', qr.expiredAt);
  } catch (e) {
    gagal('Generate gagal: ' + e.message);
    if (e.winpayResponse && e.winpayResponse.cloudflare) {
      console.log('     DIBLOKIR CLOUDFLARE (bukan error API Winpay). Ray ID:', e.winpayResponse.cloudflare.ray_id || '-', '| IP terlihat:', e.winpayResponse.cloudflare.ip || '-');
      console.log('     -> Kirim Ray ID & IP ini ke Support Winpay, minta IP server di-whitelist di Cloudflare sandbox.');
    } else if (e.winpayResponse) console.log('     respons Winpay:', JSON.stringify(e.winpayResponse).slice(0, 400));
    try {
      const ip4 = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => '-');
      const ipAny = await fetch('https://api64.ipify.org').then((r) => r.text()).catch(() => '-');
      console.log('     IPv4 server ini        :', ip4, '<- ini yang harus ada di IP Whitelist Winpay');
      console.log('     IP default (bisa IPv6) :', ipAny);
      console.log('     Koneksi ke Winpay dipaksa:', process.env.WINPAY_IP_FAMILY ? 'IPv' + process.env.WINPAY_IP_FAMILY : 'IPv4 (default)');
    } catch (x) { /* abaikan */ }
    console.log('\n  Petunjuk: 401 / "Unauthorized" / signature -> cek public key KITA di dashboard Winpay');
    console.log('            cocok dengan winpay_private.pem, Partner ID benar, dan IP whitelist = IP server ini.');
    process.exit(1);
  }

  console.log('\n[2] QUERY STATUS');
  try {
    const q = await winpayService.queryStatus({ partnerReferenceNo: ref, contractId: qr.contractId });
    ok(`responseCode ${q.responseCode}, latestTransactionStatus=${q.latestTransactionStatus} (${q.transactionStatusDesc || '01=Initiated / 03=Pending wajar untuk QR baru'})`);
  } catch (e) {
    gagal('Query gagal: ' + e.message);
    if (e.winpayResponse) console.log('     respons Winpay:', JSON.stringify(e.winpayResponse));
  }

  if (biarkan) {
    console.log('\n[3] CANCEL dilewati (--biarkan). QR berlaku 15 menit untuk dicoba bayar di sandbox.');
    console.log('    Kalau dibayar, Winpay akan memanggil URL callback. Ref ZLTES... tidak ada di database,');
    console.log('    jadi aplikasi cuma mencatat di log (tidak ada transaksi yang berubah).');
  } else {
    console.log('\n[3] CANCEL QR tes');
    try {
      const c = await winpayService.cancel({ partnerReferenceNo: ref, contractId: qr.contractId, reason: 'Tes koneksi' });
      ok(`responseCode ${c.responseCode} ${c.responseMessage || ''}`);
    } catch (e) {
      gagal('Cancel gagal: ' + e.message);
      if (e.winpayResponse) console.log('     respons Winpay:', JSON.stringify(e.winpayResponse));
    }
  }
  garis();
  console.log('Selesai.');
})();
