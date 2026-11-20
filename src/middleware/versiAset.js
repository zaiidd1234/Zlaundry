/**
 * src/middleware/versiAset.js
 * =============================================================================
 * Supaya HP / browser SELALU memakai tampilan terbaru setelah upload, tanpa
 * kasir/customer harus hapus cache:
 *
 *  1. Halaman index.html tiap app (kasir, customer, manager, kiosk, owner)
 *     dikirim dengan header "Cache-Control: no-cache" -> browser selalu cek
 *     ke server dulu sebelum memakai salinan lama.
 *  2. Di dalam halaman itu, <script src="app.js"> / "config.js" / file .css
 *     lokal otomatis diberi penanda versi "?v=<waktu file diubah>". Begitu
 *     file baru di-upload, penandanya berubah -> browser mengambil file baru.
 *     Tidak perlu menaikkan versi manual setiap rilis.
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');

const APPS = ['kasir', 'customer', 'manager', 'kiosk', 'owner'];
const cache = new Map(); // file html -> { mtimeKey, html }

function versiFile(dir, nama) {
  try {
    return Math.floor(fs.statSync(path.join(dir, nama)).mtimeMs).toString(36);
  } catch (e) {
    return null;
  }
}

function sisipkanVersi(html, dir) {
  // src="app.js" | href="style.css" (lokal, tanpa http/https, tanpa ?v= sebelumnya)
  return html.replace(/(\s(?:src|href)=")(?!https?:|\/\/|data:|#)([^"?#]+\.(?:js|css))(")/g, (m, a, file, b) => {
    const v = versiFile(dir, file);
    return v ? `${a}${file}?v=${v}${b}` : m;
  });
}

function versiAset(publicDir) {
  return function versiAsetMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = req.path.match(/^\/([a-z]+)\/(index\.html)?$/);
    if (!m || !APPS.includes(m[1])) return next();
    const dir = path.join(publicDir, m[1]);
    const file = path.join(dir, 'index.html');
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return next(); }

    // kunci cache: waktu ubah index.html + semua file js/css di folder app
    let kunci = String(stat.mtimeMs);
    try {
      for (const f of fs.readdirSync(dir)) if (/\.(js|css)$/.test(f)) kunci += '|' + f + versiFile(dir, f);
      // Perubahan #47: app owner memakai ../manager/app.js
      if (m[1] === 'owner') { const md = path.join(publicDir, 'manager'); for (const f of fs.readdirSync(md)) if (/\.(js|css)$/.test(f)) kunci += '|m/' + f + versiFile(md, f); }
      // Perubahan #35: aset bersama public/shared ikut menentukan versi
      const shared = path.join(publicDir, 'shared');
      if (fs.existsSync(shared)) for (const f of fs.readdirSync(shared)) if (/\.(js|css)$/.test(f)) kunci += '|s/' + f + versiFile(shared, f);
    } catch (e) { /* abaikan */ }

    let entri = cache.get(file);
    if (!entri || entri.kunci !== kunci) {
      entri = { kunci, html: sisipkanVersi(fs.readFileSync(file, 'utf8'), dir) };
      cache.set(file, entri);
    }
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(entri.html);
  };
}

module.exports = { versiAset, _sisipkanVersi: sisipkanVersi };
