/* ============================================
   ZLaundry Manager App v2 - Config

   CATATAN: API_BASE ikut origin halaman (lihat penjelasan di
   public/customer/config.js) supaya jalan di localhost (port berapapun)
   maupun di domain produksi tanpa perlu diubah manual.
   ============================================ */
window.APP_CONFIG = {
  API_BASE: window.location.origin + '/api',

  APP_NAME: 'ZLaundry Manager',

  // Hanya manager & owner yang boleh masuk app manager
  ALLOWED_ROLES: ['manager', 'owner'],

  // Key localStorage sesi manager (token + user) — terpisah dari kasir
  LS_TOKEN: 'zl_manager_token',
  LS_USER: 'zl_manager_user',
};
