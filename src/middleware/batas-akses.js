/**
 * src/middleware/batas-akses.js
 * =============================================================================
 * Rate limit sederhana di memori (tanpa dependency baru) -- Perubahan #78.
 * Dipakai di endpoint publik yang menyentuh Winpay / kode bayar 4 digit:
 *   - GET  /api/kiosk/qris              (tebak kode bayar)
 *   - POST /api/customer/pembayaran-qris (bikin QR di Winpay)
 *   - GET  /api/customer/tagihan-qris    (cek tagihan per no. HP)
 *
 * batasAkses({ nama, maks, jendelaMs, hanyaGagal })
 *   hanyaGagal=true -> yang dihitung cuma respons gagal (status >= 400),
 *   cocok buat kiosk: tablet toko 1 IP dipakai banyak pelanggan, jadi yang
 *   dibatasi hanya salah-tebak kode, bukan pemakaian normal.
 * Lewat batas -> 429 + header Retry-After.
 * Catatan: per proses Node (cukup untuk hosting 1 instance).
 * =============================================================================
 */

const wadah = new Map(); // `${nama}|${ip}` -> { n, mulai }

function ipDari(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function bersihkan(now) {
  if (wadah.size < 5000) return;
  for (const [k, v] of wadah) if (now - v.mulai > v.jendela) wadah.delete(k);
}

function batasAkses({ nama, maks, jendelaMs, hanyaGagal = false, pesan }) {
  return function (req, res, next) {
    const now = Date.now();
    const kunci = `${nama}|${ipDari(req)}`;
    let c = wadah.get(kunci);
    if (!c || now - c.mulai > jendelaMs) {
      c = { n: 0, mulai: now, jendela: jendelaMs };
      wadah.set(kunci, c);
      bersihkan(now);
    }
    if (c.n >= maks) {
      const detik = Math.max(1, Math.ceil((c.mulai + jendelaMs - now) / 1000));
      res.set('Retry-After', String(detik));
      return res.status(429).json({
        success: false,
        message: pesan || `Terlalu banyak percobaan. Coba lagi dalam ${detik} detik.`,
        retry_after: detik,
      });
    }
    if (!hanyaGagal) {
      c.n += 1;
    } else {
      res.on('finish', () => { if (res.statusCode >= 400 && res.statusCode !== 429) c.n += 1; });
    }
    return next();
  };
}

module.exports = { batasAkses, _wadah: wadah };
