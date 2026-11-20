/* ============================================
   ZLaundry Kasir App v2 - Config

   CATATAN: API_BASE ikut origin halaman (lihat penjelasan di
   public/customer/config.js) supaya jalan di localhost (port berapapun)
   maupun di domain produksi tanpa perlu diubah manual.
   ============================================ */
window.APP_CONFIG = {
  API_BASE: window.location.origin + '/api',

  APP_NAME: 'ZLaundry Kasir',

  // Role yang boleh masuk app kasir
  ALLOWED_ROLES: ['kasir', 'manager', 'owner'],

  // Batas berat per pesanan (kg)
  MAX_BERAT_KG: 15,

  // Key localStorage sesi kasir (token + user)
  LS_TOKEN: 'zl_kasir_token',
  LS_USER: 'zl_kasir_user',
};
