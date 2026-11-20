/* ============================================
   ZLaundry Customer App v2 - Config
   ============================================
   "Padanan .env" untuk frontend statis.

   CATATAN PERUBAHAN (agar fleksibel Docker lokal <-> hosting produksi):
   Backend (API) disajikan dari app Express yang SAMA dengan yang menyajikan
   file statis ini (lihat src/app.js: express.static + app.use('/api', ...)).
   Karena itu API selalu berada di origin yang sama dengan halaman ini,
   apapun hostname & port-nya (localhost:3000, localhost:8080, atau domain
   produksi) — jadi cukup pakai window.location.origin, tidak perlu
   hardcode host/port lagi.
   ============================================ */
window.APP_CONFIG = {
  API_BASE: window.location.origin + '/api',

  APP_NAME: 'ZLaundry',

  // Batas berat per pesanan (kg) - selaras dengan operasional
  MAX_BERAT_KG: 15,

  // RADIUS LAYANAN (km). Kalau jarak GPS customer ke cabang terdekat melebihi
  // ini -> tampilkan "layanan belum tersedia". Bisa disesuaikan dgn kondisi real.
  RADIUS_LAYANAN_KM: 5,

  // OSRM routing server (jarak jalan untuk antar-jemput)
  OSRM_BASE: 'https://router.project-osrm.org',

  // Tile peta (OpenStreetMap)
  MAP_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  MAP_ATTRIBUTION: '&copy; OpenStreetMap',

  // Key localStorage untuk "mengingat" nomor HP di device (login implicit)
  LS_HP_KEY: 'zl_customer_hp',
  LS_CABANG_KEY: 'zl_customer_cabang',
};
