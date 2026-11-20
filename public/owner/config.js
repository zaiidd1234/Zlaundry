/* ============================================
   ZLaundry Owner App -- Config (Perubahan #47)
   App owner memakai mesin app manager (../manager/app.js) dalam "owner mode":
   menu sendiri (Dashboard, Cabang, Performa, Buku Kas, Customer).
   ============================================ */
window.APP_CONFIG = {
  API_BASE: window.location.origin + '/api',
  APP_NAME: 'ZLaundry Owner',
  OWNER_MODE: true,
  ALLOWED_ROLES: ['owner'],
  LS_TOKEN: 'zl_owner_token',
  LS_USER: 'zl_owner_user',
};
