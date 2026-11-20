/* ============================================================
   ZLaundry Kasir App v2 — app.js
   Tahap 1: Login (JWT) + Dashboard.
   ============================================================ */
const CFG = window.APP_CONFIG;
const API = CFG.API_BASE;
const $ = (id) => document.getElementById(id);

const S = { token: null, user: null, currentPage: 'dashboard' };

/* ---------- sesi (localStorage) ---------- */
function saveSession() {
  try { localStorage.setItem(CFG.LS_TOKEN, S.token || ''); localStorage.setItem(CFG.LS_USER, JSON.stringify(S.user || null)); localStorage.setItem('zl_kasir_backdate', S.allowBackdate ? '1' : '0'); } catch (e) {}
}
function loadSession() {
  try {
    S.token = localStorage.getItem(CFG.LS_TOKEN) || null;
    const u = localStorage.getItem(CFG.LS_USER);
    S.user = u ? JSON.parse(u) : null;
    S.allowBackdate = localStorage.getItem('zl_kasir_backdate') === '1';
  } catch (e) { S.token = null; S.user = null; S.allowBackdate = false; }
}
function clearSession() {
  try { localStorage.removeItem(CFG.LS_TOKEN); localStorage.removeItem(CFG.LS_USER); localStorage.removeItem('zl_kasir_backdate'); } catch (e) {}
  S.token = null; S.user = null; S.allowBackdate = false;
}

/* ---------- API helper (auto Bearer) ---------- */
async function api(path, { method = 'GET', body = null, auth = true } = {}) {
  const opt = { method, headers: {} };
  if (auth && S.token) opt.headers['Authorization'] = 'Bearer ' + S.token;
  if (auth && window.OwnerCabang) Object.assign(opt.headers, window.OwnerCabang.headers(S.user)); // Perubahan #47
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(API + path, opt);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (res.status === 401) { handleExpired(json); throw new Error((json && json.message) || 'Sesi berakhir'); }
  if (res.status === 403 && json && json.code === 'ABSEN_WAJIB') absenDitolakServer();
  if (!res.ok) {
    const err = new Error((json && json.message) || `Error ${res.status}`);
    err.code = json && json.code;
    err.details = json && json.details;
    throw err;
  }
  return json;
}
function handleExpired(json) {
  clearSession();
  if (typeof closeSheet === 'function') { try { closeSheet(); } catch (e) {} }
  const pw = $('login-password'); if (pw) pw.value = '';
  showScreen('login');
  // Perubahan #82: password diganti di perangkat lain / direset atasan
  if (json && json.code === 'PASSWORD_DIGANTI') toast(json.message || 'Password sudah diganti, silakan login ulang.', 'warning');
  else toast('Sesi berakhir, silakan login lagi', 'warning');
}

/* ---------- UI util ---------- */
function showScreen(name) {
  ['login', 'app'].forEach((s) => { const el = $('screen-' + s); if (el) el.classList.toggle('active', s === name); });
}
function toast(msg, type = '', ms = 3000) {
  const w = $('toast-wrap'); const t = document.createElement('div');
  t.className = 'toast-zl' + (type ? ' t-' + type : '');
  t.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'times-circle' : type === 'warning' ? 'exclamation-circle' : 'info-circle'}"></i><span>${esc(msg)}</span>`;
  w.appendChild(t); setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rupiah(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }

/* ---------- privasi nominal dashboard (kartu Saldo Kas Kecil) ----------
   Default disembunyikan (kasir kerja di depan pelanggan) -- diungkap per
   klik icon mata, disimpen di localStorage biar preferensinya nempel
   walau reload/logout-login lagi (per-device, bukan per-sesi doang). */
const LS_RUPIAH_HIDDEN = 'zl_kasir_rupiah_hidden';
function isRupiahHidden() {
  try { const v = localStorage.getItem(LS_RUPIAH_HIDDEN); return v === null ? true : v === '1'; } catch (e) { return true; }
}
function maskRupiah(n) { return isRupiahHidden() ? 'Rp ••••••' : rupiah(n); }
function toggleRupiahVisibility() {
  try { localStorage.setItem(LS_RUPIAH_HIDDEN, isRupiahHidden() ? '0' : '1'); } catch (e) {}
  if (DASH.data) renderDashboard(DASH.data); // re-render instan pakai data yang sudah ada, gak perlu hit API lagi
}
function fmtDate(s, withTime = true) {
  if (!s) return '-';
  const d = (s instanceof Date) ? s : new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return s;
  const opt = withTime ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleString('id-ID', opt);
}
// Cuma jam:menit -- buat baris "Mulai 19.08" di kartu 3D, biar gak ngulang
// tanggal yang udah ada di baris invoice.
function fmtJam(s) {
  if (!s) return '-';
  const d = (s instanceof Date) ? s : new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return '-';
  return d.toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function rupiahK(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000000) return 'Rp ' + (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'jt';
  if (Math.abs(v) >= 1000) return 'Rp ' + Math.round(v / 1000) + 'rb';
  return 'Rp ' + v;
}
function spinner() { return '<div class="spinner-zl"></div>'; }
function emptyState(t, icon = 'fa-inbox') { return `<div class="empty-zl"><i class="fas ${icon}"></i><p>${esc(t)}</p></div>`; }
function btnLoad(btn, on) {
  if (!btn) return;
  if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Memproses...'; }
  else { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
}
function openSheet(html) { $('sheet-content').innerHTML = html; $('sheet-bg').classList.add('active'); }
function closeSheet() { $('sheet-bg').classList.remove('active'); }
function closeSheetBackdrop(e) { if (e.target.id === 'sheet-bg') closeSheet(); }

/* ---------- LOGIN ---------- */
async function doLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) { toast('Username & password wajib diisi', 'warning'); return; }
  const btn = $('btn-login'); btnLoad(btn, true);
  try {
    const res = await api('/auth/login', { method: 'POST', auth: false, body: { username, password } });
    const { token, user, app } = res.data;
    if (!CFG.ALLOWED_ROLES.includes(user.role)) {
      toast('Akun ini tidak punya akses kasir', 'danger'); btnLoad(btn, false); return;
    }
    S.token = token; S.user = user; S.allowBackdate = !!(app && app.allow_backdate); saveSession();
    enterApp();
  } catch (e) {
    toast(e.message || 'Login gagal', 'danger');
  } finally { btnLoad(btn, false); }
}

function doLogout() {
  clearSession(); closeSheet(); showScreen('login');
  if (window.OwnerCabang) window.OwnerCabang.terapkan(null); setKunciAbsen(false);
  $('login-username').value = ''; $('login-password').value = '';
}

function openProfil() {
  const u = S.user || {};
  openSheet(`
    <h3>Profil</h3>
    <div class="card-zl">
      <div style="font-size:16px;font-weight:700;">${esc(u.nama || '-')}</div>
      <div style="font-size:12px;color:var(--text-muted);">@${esc(u.username || '-')} · ${esc(u.role || '-')}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;"><i class="fas fa-store"></i> ${esc(u.cabang_nama || '-')}</div>
    </div>
    <button class="btn-zl gp-btn" onclick="GantiPassword.buka()"><i class="fas fa-key"></i> Ganti Password</button>
    <button class="btn-zl btn-danger-zl" onclick="doLogout()"><i class="fas fa-right-from-bracket"></i> Keluar</button>`);
}

/* ---------- MASUK APP ---------- */
function enterApp() {
  showScreen('app');
  if (window.OwnerCabang) window.OwnerCabang.terapkan(S.user, S.token, API); // Perubahan #47: owner pilih cabang
  $('dash-nama').textContent = (S.user && S.user.nama) ? S.user.nama : 'Kasir';
  $('dash-outlet').textContent = (S.user && S.user.cabang_nama) ? S.user.cabang_nama : '-';
  // Perubahan #27: kasir wajib absen masuk dulu
  cekGerbangAbsen().then((boleh) => navTo(boleh ? 'dashboard' : 'absensi'));
}

/* ---------- NAV ---------- */
function navTo(page) {
  if (S.absenKunci && page !== 'absensi') page = 'absensi'; // Perubahan #27: belum absen masuk
  S.currentPage = page;
  const ab = document.getElementById('od-action-bar'); if (ab) ab.remove();
  const tb = document.getElementById('psn-total-bar'); if (tb) tb.remove();
  document.querySelectorAll('.app-page').forEach((p) => p.classList.remove('active'));
  const pg = $('page-' + page); if (pg) pg.classList.add('active');
  document.querySelectorAll('#footer-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === 'dashboard') loadDashboard();
  else if (page === 'pesanan') {
    // isi hitungan tab dari data dashboard yang sudah ada (instant), reload kalau cache di-invalidate
    if (DASH && DASH.data && DASH.data.operasional) updatePesananTabCounts(DASH.data.operasional);
    else loadDashboard();
    loadPesanan();
  }
  else if (page === 'pesankan') loadPesankan();
  else if (page === 'kas') loadKas();
  else if (page === 'riwayat') rwReload();
  else if (page === 'absensi') loadAbsensi();
}

/* ---------- DASHBOARD ---------- */
const DASH = { data: null };
async function loadDashboard(opts = {}) {
  // Perubahan #75: opts.diam = pembaruan latar (tanpa spinner, tanpa gambar ulang; riwayat tidak diambil ulang)
  const body = $('dashboard-body');
  const diam = !!opts.diam && !!DASH.data && body && body.children.length > 0;
  if (!diam) body.innerHTML = spinner();
  try {
    const res = await api('/dashboard/kasir' + (diam && DASH.pembanding ? '?pembanding=0' : ''));
    if (res.data.transaksi_per_jam_pembanding) DASH.pembanding = res.data.transaksi_per_jam_pembanding;
    else res.data.transaksi_per_jam_pembanding = DASH.pembanding || null;
    DASH.data = res.data;
    renderDashboard(res.data, { patch: diam });
    cekAlertMesin(res.data.mesin || []);
  } catch (e) {
    if (!diam) body.innerHTML = emptyState('Gagal memuat dashboard. ' + e.message, 'fa-triangle-exclamation');
  }
}

/* ============================================================
   ALERT MESIN — terus berbunyi tiap 30 detik sampai semua
   mesin overdue selesai diproses (status berubah sendiri)
   ============================================================ */
let _alertBannerActive = false;
let _alertInterval = null;
// Audio beep — unlock saat interaksi apapun
let _audioCtx = null;
// Fallback: <audio> element dengan WAV inline — lebih diizinkan browser untuk autoplay
let _audioEl = null;
function _getAudioEl() {
  if (!_audioEl) {
    try {
      // Gunakan file statis untuk menghindari CSP data: URI restriction
      _audioEl = new Audio('/kasir/beep.wav');
      _audioEl.preload = 'auto';
    } catch(_) {}
  }
  return _audioEl;
}

function _getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_) {}
  }
  return _audioCtx;
}

function unlockAudioOnce() {
  const ctx = _getAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  const el = _getAudioEl(); if (el) el.load();
}

['click', 'touchstart', 'touchend', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, unlockAudioOnce, { passive: true })
);

function beepAlert() {
  // 1) Coba AudioContext (triple beep)
  try {
    const ctx = _getAudioCtx();
    if (ctx) {
      const doPlay = () => {
        [0, 380, 760].forEach((delay) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.type = 'sine'; osc.frequency.value = 880;
          const t = ctx.currentTime + delay/1000;
          gain.gain.setValueAtTime(0.6, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t+0.4);
          osc.start(t); osc.stop(t+0.4);
        });
      };
      if (ctx.state === 'suspended') ctx.resume().then(doPlay).catch(()=>{});
      else doPlay();
    }
  } catch(_) {}
  // 2) Fallback <audio> — berjalan terlepas dari AudioContext state
  try {
    const el = _getAudioEl();
    if (el) { el.currentTime = 0; el.play().catch(()=>{ try { el.cloneNode().play().catch(()=>{}); } catch(_){} }); }
  } catch(_) {}
}


function showAlertBanner(overdueList) {
  let banner = document.getElementById('mesin-alert-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mesin-alert-banner';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9990;
      background:#dc2626;color:#fff;
      padding:10px 14px;display:flex;align-items:center;gap:10px;
      font-family:'Poppins',sans-serif;font-size:13px;font-weight:600;
      box-shadow:0 4px 12px rgba(0,0,0,0.25);
    `;
    document.body.appendChild(banner);
    _alertBannerActive = true;
  }
  const labels = overdueList.map((m) => {
    const k = (m.kode_mesin || '').split('-').pop();
    const kr = m.usage.kode_keranjang ? ' K' + m.usage.kode_keranjang.split('-').pop() : '';
    return k + kr;
  }).join(' · ');
  banner.innerHTML = `
    <i class="fas fa-bell fa-shake" style="font-size:16px;flex-shrink:0;"></i>
    <span>⏰ Selesai: ${labels} — segera lanjutkan proses</span>
  `;
}

function cekAlertMesin(mesinList) {
  const overdue = mesinList.filter((m) => {
    if (m.status !== 'running' || !m.usage) return false;
    const { transaksi_id, durasi_menit, durasi_target } = m.usage;
    if (!durasi_target || durasi_menit == null) return false;
    if (durasi_menit < durasi_target) return false;
    return true;
  });

  if (!overdue.length) {
    // tidak ada overdue — clear banner kalau ada
    if (_alertBannerActive) {
      const b = document.getElementById('mesin-alert-banner');
      if (b) b.remove();
      _alertBannerActive = false;
      clearInterval(_alertInterval);
      _alertInterval = null;
    }
    return;
  }

  // ada overdue — tampilkan banner + beep
  showAlertBanner(overdue);
  beepAlert();

  // loop beep tiap 30 detik selama banner masih aktif
  if (!_alertInterval) {
    _alertInterval = setInterval(() => {
      if (!_alertBannerActive) { clearInterval(_alertInterval); _alertInterval = null; return; }
      beepAlert();
    }, 30000);
  }
}




function renderDashboard(d, opt = {}) {
  const saldo = d.saldo || { cash: 0, gopay: 0, total: 0 };
  const hari = d.transaksi_hari_ini || { jumlah: 0, omzet: 0 };
  const proses = d.sedang_proses || { jumlah: 0, daftar: [] };
  const belum = d.belum_setor || { jumlah: 0, total: 0 };
  const pel = d.pelanggan_hari_ini || { total: 0, baru: 0, lama: 0 };
  const ops = d.operasional || { belum_bayar: 0, proses: 0, siap: 0 };

  let html = '';

  // KARTU 1: SALDO KAS KECIL (Cash | Gopay | Belum Setor) -- nominal rupiah
  // disembunyikan default (privasi layar kasir), diungkap lewat icon mata.
  html += `
    <div class="saldo-card">
      <div class="sc-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span>Total Saldo Kas Kecil</span>
        <span onclick="toggleRupiahVisibility()" style="cursor:pointer;width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,0.16);display:flex;align-items:center;justify-content:center;flex-shrink:0;" title="${isRupiahHidden() ? 'Tampilkan nominal' : 'Sembunyikan nominal'}">
          <i class="fas ${isRupiahHidden() ? 'fa-eye-slash' : 'fa-eye'}" style="font-size:12px;"></i>
        </span>
      </div>
      <div class="sc-total">${maskRupiah(saldo.total)}</div>
      <div class="sc-split sc-3">
        <div class="sc-item" onclick="goKas()" style="cursor:pointer;"><div class="l"><i class="fas fa-money-bill-wave"></i> Cash</div><div class="v">${maskRupiah(saldo.cash)}</div></div>
        <div class="sc-item" onclick="goKas()" style="cursor:pointer;"><div class="l"><i class="fas fa-qrcode"></i> Gopay</div><div class="v">${maskRupiah(saldo.gopay)}</div></div>
        <div class="sc-item" onclick="goSetor()" style="cursor:pointer;"><div class="l"><i class="fas fa-money-bill-transfer"></i> Belum Setor</div><div class="v">${maskRupiah(belum.total)}</div></div>
      </div>
    </div>`;

  // KARTU 2: TRANSAKSI (2x3 grid dengan icon)
  // Perubahan #54: ikon kartu pakai gaya 3D (.ik-mini + gradien g-*), sama dengan ikon 3D manager/customer.
  // Perubahan #9 (rev 15:06): 9 kartu 3x3. Proses mesin tidak ditampilkan
  // (sudah terlihat di Status Mesin). Ukuran ikon & angka seperti semula.
  const trxCards = PESANAN_KARTU.map((c) => ({ ...c, val: kartuNilai(ops, c.key) }));
  html += `
    <div class="section-label"><i class="fas fa-receipt"></i> Transaksi</div>
    <div class="trx-grid trx-grid-9">
      ${trxCards.map(c => `
        <div class="trx-card" style="background:${c.bg};" onclick="goPesanan('${c.key}')">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="ik-mini ${c.g3}"><i class="fas ${c.icon}"></i></div>
            <div style="font-size:28px;font-weight:900;color:${c.fg};line-height:1;">${c.val}</div>
          </div>
          <div style="font-size:10px;font-weight:700;color:${c.fg};margin-top:6px;opacity:.85;">${c.lbl}</div>
        </div>`).join('')}
    </div>`;

  // PAPAN STATUS MESIN
  html += renderPapanMesin(d.mesin || []);

  // Antrian mesin dihilangkan dari dashboard -- fungsinya udah ada di menu
  // Pesanan (tab "Antri Mesin", buka detail transaksi -> tombol aksi
  // "Alokasi Mesin Cuci/Kering" buat pilih mesin manual).

  // KARTU 3: TRANSAKSI HARI INI (Total | Total Pelanggan | Baru | Lama)
  const hariCards = [
    { val: hari.jumlah, lbl: 'Total Transaksi', icon: 'fa-receipt',    g3: 'g-berat', bg: '#f8fafc', iconBg: '#e2e8f0', iconFg: '#475569', numFg: '#1e293b', fn: "goRiwayat('semua')" },
    { val: pel.total,   lbl: 'Pelanggan',        icon: 'fa-users',      g3: 'g-cuci', bg: '#eff6ff', iconBg: '#bfdbfe', iconFg: '#1d4ed8', numFg: '#1d4ed8', fn: "goRiwayat('semua')" },
    { val: pel.baru,    lbl: 'Baru',             icon: 'fa-star',       g3: 'g-teh', bg: '#fef3c7', iconBg: '#fde68a', iconFg: '#92400e', numFg: '#92400e', fn: "goRiwayat('baru')"  },
    { val: pel.lama,    lbl: 'Lama',             icon: 'fa-user-check', g3: 'g-antar', bg: '#f0fdf4', iconBg: '#bbf7d0', iconFg: '#166534', numFg: '#166534', fn: "goRiwayat('lama')"  },
  ];
  html += `
    <div class="section-label"><i class="fas fa-users"></i> Transaksi Hari Ini</div>
    <div class="trx-grid trx-grid-2">
      ${hariCards.map(c => `
        <div class="trx-card" style="background:${c.bg};" onclick="${c.fn}">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="ik-mini ${c.g3}"><i class="fas ${c.icon}"></i></div>
            <div style="font-size:28px;font-weight:900;color:${c.numFg};line-height:1;">${c.val}</div>
          </div>
          <div style="font-size:10px;font-weight:700;color:${c.iconFg};margin-top:6px;opacity:.85;">${c.lbl}</div>
        </div>`).join('')}
    </div>`;

  // Perubahan #65: grafik batang transaksi hari ini per jam (06:00 - 24:00)
  html += grafikTrxPerJam(d.transaksi_per_jam || [], d.transaksi_per_jam_pembanding);

  // jam update terakhir
  const jam = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  html += `<div style="text-align:center;font-size:11px;color:var(--slate-light);margin-top:4px;">
      <i class="fas fa-clock"></i> Diperbarui ${jam} · otomatis tiap 1 menit
    </div>`;

  // Perubahan #75: pembaruan latar -> patch (tidak berkedip)
  if (opt.patch) window.IK3D.patchHtml($('dashboard-body'), html);
  else $('dashboard-body').innerHTML = html;
}

// Warna status mesin DISERAGAMKAN di seluruh dashboard (kasir & manager):
// maintenance/nonaktif = abu2, idle = hijau, teralokasi = kuning, jalan/running = merah
const MESIN_ST = {
  running:     { txt: 'Jalan',       iconBg: '#fee2e2', iconFg: '#ef4444', icon: 'fa-wind'  },
  idle:        { txt: 'Idle',        iconBg: '#d1fae5', iconFg: '#10b981', icon: 'fa-soap'  },
  teralokasi:  { txt: 'Teralokasi',  iconBg: '#fef3c7', iconFg: '#f59e0b', icon: 'fa-soap'  },
  maintenance: { txt: 'Maintenance', iconBg: '#f1f5f9', iconFg: '#94a3b8', icon: 'fa-soap'  },
  nonaktif:    { txt: 'Nonaktif',    iconBg: '#f1f5f9', iconFg: '#94a3b8', icon: 'fa-soap'  },
};
function fmtDurasi(menit) {
  if (menit == null) return '';
  if (menit < 60) return menit + '"';
  const j = Math.floor(menit / 60), mn = menit % 60;
  return mn ? `${j}j ${mn}"` : `${j}j`;
}
function mesinCell(m) {
  // Perubahan #56: ikon 3D seragam (shared/ikon3d.css .mz-*), baris kode [D1][keranjang][K-102]
  // (kode singkat = tampilan saja), nama dipotong "...", chip layanan, + "N antre" di bawah kartu.
  const IK = window.IK3D;
  const st = MESIN_ST[m.status] || MESIN_ST.idle;
  const running = m.status === 'running' && m.usage;
  const teralokasi = m.status === 'teralokasi' && m.reservasi;
  const usage = m.usage;
  const iconFa = m.tipe === 'dryer' ? 'fa-wind' : 'fa-soap';
  const kodeShort = IK.kodeMesin(m.kode_mesin);
  const krjRaw = running ? usage.kode_keranjang : teralokasi ? m.reservasi.kode_keranjang : null;
  const keranjangShort = krjRaw ? IK.kodeKeranjang(krjRaw) : '';

  // nama pelanggan saat running/teralokasi, status saat idle/maint
  const subTxt = (running && usage.nama_pelanggan) ? usage.nama_pelanggan
    : (teralokasi && m.reservasi.nama_pelanggan) ? m.reservasi.nama_pelanggan : st.txt;

  // timer: SISA waktu (Perubahan #11)
  let durTxt = '';
  if (running && usage.durasi_menit != null) {
    const target = usage.durasi_target;
    durTxt = target ? fmtDurasi(Math.max(0, target - usage.durasi_menit)) : fmtDurasi(usage.durasi_menit);
  }
  const overdue = running && usage.durasi_target && usage.durasi_menit >= usage.durasi_target;

  // chip layanan: hanya cuci, kering, drop-off, lipat (setrika lipat), antar / antar jemput
  const lynAll = running ? usage.layanan : teralokasi ? m.reservasi.layanan : [];
  const lyn = (lynAll || []).filter((l) => MESIN_CHIP_KAT.includes(l.kategori));

  // Semua kondisi (idle / teralokasi / jalan) buka popup 3 layer antrian
  // mesin (lihat bukaPopupMesin). Maintenance/nonaktif tidak bisa diklik.
  const bisaKlik = (m.tipe === 'washer' || m.tipe === 'dryer') && m.status !== 'maintenance' && m.status !== 'nonaktif';
  const clickAttr = bisaKlik ? `onclick="bukaPopupMesin(${m.id})" style="cursor:pointer;"` : '';
  const antre = Number(m.antre) || 0;

  return `
    <div class="mz-slot">
      <div class="mz-card mesin-cell${overdue ? ' mesin-cell-overdue' : ''}" ${clickAttr}>
        <div class="mz-ico ${IK.kelasMesin(m.status)}"><i class="fas ${iconFa}"></i></div>
        <div class="mz-kline"><b>${esc(kodeShort)}</b>${keranjangShort ? `<i class="fas fa-basket-shopping"></i><span>${esc(keranjangShort)}</span>` : ''}</div>
        <div class="mz-sub">${esc(subTxt)}</div>
        <div class="mz-sub">${durTxt || '&nbsp;'}</div>
        ${lyn.length ? ikonLayananHtml(lyn, 'kecil') : ''}
      </div>
      <div class="mz-antre${antre ? '' : ' nol'}">${antre} antre</div>
    </div>`;
}
const MESIN_CHIP_KAT = ['cuci', 'kering', 'drop_off', 'lipat', 'setrika_lipat', 'antar', 'antar_jemput', 'jemput'];
/** Perubahan #56: slot kosong untuk menggenapkan baris kasir -- tampilan saja.
 *  Perubahan #57: mobile 4 kolom (kelipatan 4), desktop >=1024px 5 kolom (kelipatan 5);
 *  kelas dep-m / dep-d menentukan slot tampil di mobile / desktop (CSS). */
function mesinCellDeploy(kode, tipe, kelas) {
  return `
    <div class="mz-slot mz-slot-dep ${kelas}">
      <div class="mz-card mz-card-dep">
        <div class="mz-ico mz-dep"><i class="fas ${tipe === 'dryer' ? 'fa-wind' : 'fa-soap'}"></i></div>
        <div class="mz-kline"><b>${esc(kode)}</b></div>
        <div class="mz-sub"><i>On deployment</i></div>
      </div>
      <div class="mz-antre nol">&nbsp;</div>
    </div>`;
}
/** Kartu mesin 1 jenis, digenapkan dengan slot "On deployment" (4 kolom HP, 5 kolom desktop). */
function gridMesinKasir(list, tipe) {
  const IK = window.IK3D;
  let h = list.map(mesinCell).join('');
  const n = list.length;
  const padM = (4 - (n % 4)) % 4;
  const padD = (5 - (n % 5)) % 5;
  const total = Math.max(padM, padD);
  if (total) {
    const huruf = (IK.kodeMesin(list[0] && list[0].kode_mesin).match(/^[A-Za-z]+/) || [tipe === 'dryer' ? 'D' : 'W'])[0];
    const maks = list.reduce((mx, m) => Math.max(mx, Number((IK.kodeMesin(m.kode_mesin).match(/\d+$/) || [0])[0])), 0);
    for (let i = 1; i <= total; i++) {
      const kelas = [i <= padM ? 'dep-m' : '', i <= padD ? 'dep-d' : ''].join(' ').trim();
      h += mesinCellDeploy(huruf + (maks + i), tipe, kelas);
    }
  }
  return `<div class="mz-grid mz-grid-kasir">${h}</div>`;
}

/** Klik mesin yang lagi "jalan" -> pilihan: lihat transaksi, lihat riwayat hari ini, atau tangani mesin yang bermasalah (alarm / mati total). */
function bukaOpsiMesinJalan(mesinId, txId, kodeMesin) {
  openSheet(`<h3><i class="fas fa-gear"></i> Mesin ${esc(kodeMesin)}</h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="closeSheet();openOrderDetail(${txId})">
        <i class="fas fa-receipt" style="color:var(--primary);margin-right:8px;"></i> Lihat Transaksi
      </button>
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="closeSheet();openRiwayatMesinHariIni(${mesinId},'${esc(kodeMesin)}')">
        <i class="fas fa-clock-rotate-left" style="color:var(--text-muted);margin-right:8px;"></i> Riwayat Pemakaian Hari Ini
      </button>
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="doStartAlarm(${mesinId},${txId},'${esc(kodeMesin)}','4c_4e')">
        <i class="fas fa-faucet-drip" style="color:var(--warning);margin-right:8px;"></i> Sudah Buka Keran, Lanjut Start
      </button>
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="doStartAlarm(${mesinId},${txId},'${esc(kodeMesin)}','dc_de')">
        <i class="fas fa-door-closed" style="color:var(--warning);margin-right:8px;"></i> Sudah Tutup Pintu, Lanjut Start
      </button>
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="bukaRestartProses(${mesinId},${txId},'${esc(kodeMesin)}')">
        <i class="fas fa-rotate-right" style="color:var(--danger);margin-right:8px;"></i> Mesin Mati Total, Restart dari Awal
      </button>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:10px;"><i class="fas fa-circle-info"></i>
      Kalau mesin masih nyala cuma kena alarm (4C/4E = keran air, dC/dE = pintu), pakai tombol "Lanjut Start".
      Kalau mesin beneran mati / gagal trigger dari awal, pakai "Restart dari Awal".
    </div>`);
}

/** "Lanjut Start" setelah alarm dibenarkan (keran dibuka / pintu ditutup) -- mesin TIDAK pernah mati, jadi cuma kirim ulang sinyal Start, bukan restart penuh. */
async function doStartAlarm(mesinId, txId, kodeMesin, jenis) {
  try {
    const res = await api(`/transaksi/${txId}/start-alarm`, { method: 'POST', body: { jenis } });
    toast(`Sinyal start terkirim ke ${res.data.kode_mesin}`, 'success');
    closeSheet();
    loadDashboard();
  } catch (e) {
    toast(e.message || 'Gagal kirim sinyal start', 'danger');
  }
}

/** Klik mesin yang statusnya "Teralokasi" -> pilihan: lihat transaksi, atau
 * langsung proses (mulai pakai mesin -- cucian/pengeringan udah ditaruh). */
function bukaOpsiMesinTeralokasi(mesinId, txId, kodeMesin, tipe) {
  const targetStatus = tipe === 'dryer' ? 'mulai_kering' : 'mulai_cuci';
  openSheet(`<h3><i class="fas fa-gear"></i> Mesin ${esc(kodeMesin)}</h3>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;"><i class="fas fa-circle-info"></i> Mesin ini sudah dialokasikan buat transaksi berikut, tapi belum mulai dipakai.</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="closeSheet();openOrderDetail(${txId})">
        <i class="fas fa-receipt" style="color:var(--primary);margin-right:8px;"></i> Lihat Transaksi
      </button>
      <button class="btn-zl btn-light-zl" style="justify-content:flex-start;" onclick="closeSheet();openRiwayatMesinHariIni(${mesinId},'${esc(kodeMesin)}')">
        <i class="fas fa-clock-rotate-left" style="color:var(--text-muted);margin-right:8px;"></i> Riwayat Pemakaian Hari Ini
      </button>
      <button class="btn-zl btn-primary-zl" style="justify-content:flex-start;" onclick="prosesLangsungMesin(${txId},'${targetStatus}','${esc(kodeMesin)}')">
        <i class="fas fa-play" style="margin-right:8px;"></i> Proses (Mulai Pakai Mesin)
      </button>
    </div>`);
}

/** Fast-path: langsung mulai pakai mesin dari papan mesin, tanpa buka detail transaksi dulu. */
async function prosesLangsungMesin(txId, targetStatus, kodeMesin) {
  if (!confirm(`Mulai proses di mesin ${kodeMesin} sekarang?`)) return;
  try {
    const res = await api('/transaksi/' + txId + '/status', { method: 'POST', body: { status: targetStatus } });
    toast(`Mesin ${kodeMesin} mulai diproses`, 'success');
    handleWaAfter(res && res.data);
    closeSheet();
    DASH.data = null;
    loadDashboard();
  } catch (e) {
    toast(e.message || 'Gagal memproses', 'danger');
  }
}

/** Step isi alasan restart (wajib) + konfirmasi sebelum eksekusi -- khusus mesin yang beneran mati/gagal trigger dari awal. */
function bukaRestartProses(mesinId, txId, kodeMesin) {
  openSheet(`<h3><i class="fas fa-rotate-right"></i> Restart dari Awal ${esc(kodeMesin)}</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
      Pakai ini cuma kalau mesin beneran mati/gagal trigger dari awal (bukan sekadar alarm 4C/4E atau dC/dE).
      Ini akan mengulang proses dari awal (waktu mulai di-reset ke sekarang) dan tercatat di riwayat mesin.
      Jumlah siklus (cycle) mesin ini <b>tidak</b> ikut bertambah.
    </div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan restart (wajib)</label>
    <textarea id="restart-alasan" placeholder="Contoh: mesin gagal start, lampu indikator mati" style="width:100%;min-height:70px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:'Poppins';font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-zl btn-light-zl" style="flex:1;" onclick="bukaOpsiMesinJalan(${mesinId},${txId},'${esc(kodeMesin)}')">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-restart-kirim" onclick="doRestartProses(${txId})"><i class="fas fa-rotate-right"></i> Restart Sekarang</button>
    </div>`);
}

async function doRestartProses(txId) {
  const alasan = ($('restart-alasan') ? $('restart-alasan').value : '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-restart-kirim'); if (btn) btnLoad(btn, true);
  try {
    const res = await api(`/transaksi/${txId}/restart-proses`, { method: 'POST', body: { alasan } });
    toast(`Mesin ${res.data.kode_mesin} berhasil di-restart`, 'success');
    closeSheet();
    loadDashboard(); // refresh papan mesin biar timer/waktu ke-update
  } catch (e) {
    toast(e.message || 'Gagal restart', 'danger');
    if (btn) btnLoad(btn, false);
  }
}
/** Klik mesin apapun statusnya (idle/booking/jalan) -> riwayat SEMUA pemakaian mesin ini hari ini. Menggantikan "Order Terakhir" lama yang cuma 1 baris & cuma muncul di mesin idle. */
async function openRiwayatMesinHariIni(mesinId, kodeMesin) {
  openSheet('<h3><i class="fas fa-clock-rotate-left"></i> ' + esc(kodeMesin) + ' — Riwayat Hari Ini</h3><div id="riwayat-mesin-body">' + spinner() + '</div>');
  try {
    const res = await api('/mesin/' + mesinId + '/riwayat-hari-ini');
    const list = res.data || [];
    if (!list.length) {
      $('riwayat-mesin-body').innerHTML = emptyState('Belum ada pemakaian hari ini', 'fa-clock-rotate-left');
      return;
    }
    $('riwayat-mesin-body').innerHTML = list.map((d) => {
      const jamMulai = new Date(d.waktu_mulai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const jamSelesai = d.waktu_selesai
        ? new Date(d.waktu_selesai).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        : 'masih jalan';
      return '<div class="card-zl" style="margin-bottom:8px;cursor:pointer;" onclick="closeSheet();openOrderDetail(' + d.transaksi_id + ')">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;">'
        + '<span style="font-size:13px;font-weight:700;">' + esc(d.no_invoice) + '</span>'
        + '<span style="font-size:11px;color:var(--text-muted);">' + jamMulai + ' – ' + jamSelesai + '</span>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(d.nama_pelanggan || 'Walk-in') + (d.telepon ? ' · ' + esc(d.telepon) : '') + '</div>'
        + '<div style="font-size:13px;font-weight:800;color:var(--primary);margin-top:4px;">Rp' + (d.total||0).toLocaleString('id-ID') + '</div>'
        + '</div>';
    }).join('');
  } catch (e) {
    $('riwayat-mesin-body').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

/* ============================================================
   POPUP KARTU MESIN (Perubahan #1 -- antrian mesin terkunci)
   🟢 idle      : PENGGUNA TERAKHIR + RIWAYAT HARI INI
   🟡 teralokasi: SEBELUMNYA / SEKARANG / ANTRIAN 1..n (panah ↑/↓, wajib alasan) + [Mulai Proses]
   🔴 jalan     : SEBELUMNYA / SEKARANG / ANTRIAN 1..n (read-only)
                  cuci  : [Restart (Mesin ON)][Restart (Mesin OFF)]  (wajib alasan, timer reset)
                  kering: [Start][Resume]  (Start wajib alasan + timer reset, Resume langsung)
   Nama selalu "nama - kode keranjang" tanpa kode cabang.
   ============================================================ */
/* ---- Perubahan #4: ikon layanan berwarna (hijau selesai, biru belum, kuning teralokasi, merah jalan) ---- */
const LYN_IKON = {
  cuci: 'fa-soap', kering: 'fa-wind', drop_off: 'fa-people-carry-box', lipat: 'fa-shirt',
  setrika_lipat: 'fa-fire', antar: 'fa-truck-fast', antar_jemput: 'fa-route', jemput: 'fa-truck-ramp-box',
};
const LYN_WARNA_TXT = { hijau: 'selesai', biru: 'belum', kuning: 'teralokasi', merah: 'jalan' };
/** @param list [{kategori,label,warna}] @param ukuran 'kecil' (kartu mesin) | 'besar' (popup) */
function ikonLayananHtml(list, ukuran = 'besar') {
  if (!list || !list.length) return '';
  return `<span class="lyn-ikons lyn-${ukuran}">${list.map((l) =>
    `<span class="lyn-ico lyn-${esc(l.warna)}" title="${esc(l.label)}${l.durasi_menit ? ' ' + l.durasi_menit + ' mnt' : ''} · ${esc(LYN_WARNA_TXT[l.warna] || l.warna)}"><i class="fas ${LYN_IKON[l.kategori] || 'fa-circle'}"></i>${
      ukuran === 'besar' && l.durasi_menit ? `<sub class="lyn-dur">${Number(l.durasi_menit)}"</sub>` : ''}</span>`).join('')}</span>`;
}

let PM = { id: null, data: null };
const PM_ST = {
  idle:       { txt: 'Kosong',      dot: '🟢', bg: 'var(--success-light)', fg: 'var(--success)' },
  teralokasi: { txt: 'Teralokasi',  dot: '🟡', bg: 'var(--warning-light)', fg: '#b45309' },
  running:    { txt: 'Jalan',       dot: '🔴', bg: 'var(--danger-light)',  fg: 'var(--danger)' },
};
// Perubahan #5: "Nama - 10Kg - K114" (berat dibulatkan seperti aturan input berat)
function pmNama(o) {
  const berat = o.berat_kg != null && Number(o.berat_kg) > 0 ? ` - ${Math.round(Number(o.berat_kg))}Kg` : '';
  return esc(o.nama || 'Walk-in') + berat + (o.keranjang ? ' - ' + esc(o.keranjang) : '');
}
function pmPaket(o, tipe) { return tipe === 'dryer' && o.durasi_menit ? ` · Kering ${o.durasi_menit} mnt` : ''; }
const PM_SIAP = 'Mesin sudah siap, tunggu pelanggan sebelumnya mengeluarkan cucian dari mesin';

/* ---- Perubahan #2: tombol WA (pesan singkat) + Detail Order per baris ---- */
function pmWaNomor(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (!d.startsWith('62')) d = '62' + d;
  return d;
}
/** Pesan singkat sesuai posisi customer di mesin ini. peran: sebelumnya | sekarang | antrian */
function pmPesanWa(o, peran, posisi) {
  if (o.pesan_wa) return o.pesan_wa; // Perubahan #36: semua baris dari server (status order saat ini)
  const d = PM.data || {};
  const m = d.mesin ? d.mesin.kode_pendek : '';
  const nama = o.nama && o.nama !== 'Walk-in' ? `Kak ${o.nama}` : 'Kak';
  const krj = o.keranjang ? ` (${o.keranjang})` : '';
  const jenis = d.mesin && d.mesin.tipe === 'dryer' ? 'pengering' : 'cuci';
  if (peran === 'sebelumnya') {
    if (o.cucian_di_mesin) return `Halo ${nama}, cucian Anda${krj} di mesin ${m} sudah selesai. Mohon segera dikeluarkan ya, pelanggan berikutnya sudah menunggu. Terima kasih.`;
    return `Halo ${nama}, update pesanan Anda${krj}: ${o.keterangan || '-'}. Terima kasih.`;
  }
  if (peran === 'sekarang') {
    if (o.kondisi === 'jalan') return `Halo ${nama}, cucian Anda${krj} sedang diproses di mesin ${jenis} ${m}, estimasi selesai ± ${Math.max(1, o.sisa_menit || 0)} menit.`;
    if (o.siap_tunggu_bongkar) return `Halo ${nama}, mesin ${jenis} ${m} sudah dialokasikan untuk cucian Anda${krj}. Mesin sudah siap, tinggal menunggu pelanggan sebelumnya mengeluarkan cucian. Terima kasih.`;
    return `Halo ${nama}, mesin ${jenis} ${m} sudah siap untuk cucian Anda${krj}. Silakan ke outlet untuk mulai proses. Terima kasih.`;
  }
  if (o.siap_tunggu_bongkar) return `Halo ${nama}, pesanan Anda${krj} antrian ke-${posisi} di mesin ${jenis} ${m}. Mesin sudah siap, tinggal menunggu pelanggan sebelumnya mengeluarkan cucian. Terima kasih.`;
  return `Halo ${nama}, pesanan Anda${krj} antrian ke-${posisi} di mesin ${jenis} ${m}, estimasi mulai ± ${Math.max(1, o.tunggu_menit || 0)} menit. Terima kasih.`;
}
/** Perubahan #32: mesin idle -- hanya WA + Detail Order. */
function pmTombolIdle(o) {
  let h = '';
  const no = pmWaNomor(o.telepon);
  if (no) {
    const href = `https://wa.me/${no}?text=${encodeURIComponent(pmPesanWa(o, 'idle'))}`;
    h += `<a class="pm-btn3d pm-wa" title="Kirim WhatsApp" href="${href}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i><span class="pm-fb">WA</span></a>`;
  }
  h += `<button class="pm-btn3d pm-det" title="Detail order" onclick="event.stopPropagation();closeSheet();openOrderDetail(${o.transaksi_id})"><i class="fas fa-receipt"></i><span class="pm-fb">Detail</span></button>`;
  return h;
}
/** Tombol 3D: WA (kalau ada nomor) + Detail Order. */
function pmTombolBaris(o, peran, posisi) {
  let h = '';
  const no = pmWaNomor(o.telepon);
  if (no) {
    const href = `https://wa.me/${no}?text=${encodeURIComponent(pmPesanWa(o, peran, posisi))}`;
    h += `<a class="pm-btn3d pm-wa" title="Kirim WhatsApp" href="${href}" target="_blank" rel="noopener noreferrer"><i class="fab fa-whatsapp"></i><span class="pm-fb">WA</span></a>`;
  }
  h += `<button class="pm-btn3d pm-det" title="Detail order" onclick="closeSheet();openOrderDetail(${o.transaksi_id})"><i class="fas fa-receipt"></i><span class="pm-fb">Detail</span></button>`;
  h += `<button class="pm-btn3d pm-ubah" title="Ubah pesanan" onclick="bukaUbahPesanan(${o.transaksi_id})"><i class="fas fa-pen-to-square"></i><span class="pm-fb">Ubah</span></button>`;
  // Perubahan #20: pindah ke mesin lain (order antre, atau SEKARANG yang masih teralokasi)
  const d = PM.data;
  if (d && d.mode_otomatis && (peran === 'antrian' || (peran === 'sekarang' && o.kondisi !== 'jalan'))) {
    h += `<button class="pm-btn3d pm-pindah" title="Pindah ke mesin lain" onclick="bukaPindahMesin(${o.transaksi_id})"><i class="fas fa-right-left"></i><span class="pm-fb">Pindah</span></button>`;
  }
  return h;
}

/* ============================================================
   PINDAH MESIN (Perubahan #20) -- manuver horizontal antar mesin sejenis
   ============================================================ */
let PMV = { trxId: null, tujuan: null, posisi: 'depan', ringkas: '' };
/* Perubahan #38: kartu semua mesin mendatar, warna sesuai status; klik -> detail + tombol */
const PV_KELAS = { kosong: ['pv-kosong', 'Kosong'], teralokasi: ['pv-alok', 'Teralokasi'], jalan: ['pv-jalan', 'Jalan'], maintenance: ['pv-mt', 'Maintenance'], nonaktif: ['pv-mt', 'Nonaktif'] };
async function bukaPindahMesin(trxId) {
  $('pm-body').innerHTML = spinner();
  try {
    const r = (await api('/mesin/pindah-opsi?transaksi_id=' + trxId)).data;
    PMV = { trxId, tujuan: null, posisi: 'depan', ringkas: '', nama: r.nama, asal: r.asal.kode_pendek, opsi: r, pilih: null };
    renderPindahMesin();
  } catch (e) { toast(e.message || 'Gagal memuat pilihan mesin', 'danger'); renderPopupMesin(); }
}
function renderPindahMesin() {
  const r = PMV.opsi; if (!r) return;
  const jenis = r.tipe === 'dryer' ? 'pengering' : 'cuci';
  const ico = r.tipe === 'dryer' ? 'fa-wind' : 'fa-soap';
  const semua = r.semua || r.opsi;
  const kartu = semua.map((o) => {
    const [cls, lbl] = PV_KELAS[o.kondisi] || PV_KELAS.kosong;
    const st = o.kondisi === 'jalan' ? `Jalan ${o.sisa_menit != null ? o.sisa_menit : o.tunggu_depan}'` : lbl;
    const mati = o.asal || o.kondisi === 'maintenance' || o.kondisi === 'nonaktif';
    return `<div class="pv-m ${cls} ${o.asal ? 'asal' : ''} ${mati ? 'mati' : ''} ${PMV.pilih === o.mesin_id ? 'sel' : ''}" ${mati ? '' : `onclick="pilihKartuPindah(${o.mesin_id})"`}>
        <div class="ic"><i class="fas ${ico}"></i></div><b>${esc(o.kode_pendek)}</b><small>${esc(st)}</small></div>`;
  }).join('');
  const o = PMV.pilih ? semua.find((x) => Number(x.mesin_id) === Number(PMV.pilih)) : null;
  let det = `<div class="pv-det"><div class="t pv-hint">Klik mesin tujuan di atas.</div></div>`;
  if (o) {
    const k = esc(o.kode_pendek);
    const btnB = (txt) => `<button class="btn-zl btn-light-zl" onclick="pilihPindah(${o.mesin_id},'belakang','${k} paling belakang')"><i class="fas fa-arrow-down-short-wide"></i> ${txt}</button>`;
    let tombol = '';
    let judul;
    if (o.kondisi === 'kosong') {
      judul = `${k} · kosong${o.blok_bongkar ? ' (cucian sebelumnya belum dikeluarkan)' : ', langsung siap'}`;
      tombol = `<button class="btn-zl btn-primary-zl" onclick="pilihPindah(${o.mesin_id},'depan','${k}')"><i class="fas fa-play"></i> Pakai ${k} sekarang</button>`;
    } else if (o.kondisi === 'teralokasi') {
      const nm = esc((o.nama_teralokasi || '').split(' ')[0] || 'pelanggan');
      judul = `${k} · teralokasi ${esc(o.nama_teralokasi || '')}${o.jml_antrian ? ` · ${o.jml_antrian} antrian` : ''}`;
      tombol = `<button class="btn-zl btn-primary-zl" onclick="pilihPindah(${o.mesin_id},'depan','${k} (dahului ${nm})')"><i class="fas fa-forward"></i> Dahului ${nm}</button>`
        + btnB(`Paling belakang · ± ${o.tunggu_belakang} mnt`);
    } else {
      judul = `${k} · jalan, sisa ± ${o.sisa_menit != null ? o.sisa_menit : o.tunggu_depan} mnt${o.jml_antrian ? ` · ${o.jml_antrian} antrian` : ''}`;
      tombol = `<button class="btn-zl btn-primary-zl" onclick="pilihPindah(${o.mesin_id},'depan','${k} antrian 1')"><i class="fas fa-arrow-up"></i> Antrian 1 · ± ${o.tunggu_depan} mnt</button>`
        + (o.jml_antrian ? btnB(`Paling belakang · ± ${o.tunggu_belakang} mnt`) : '');
    }
    det = `<div class="pv-det"><div class="t">${judul}</div>${tombol}</div>`;
  }
  const bisa = semua.some((x) => !x.asal && ['kosong', 'teralokasi', 'jalan'].includes(x.kondisi));
  $('pm-body').innerHTML = `<h3><i class="fas fa-right-left"></i> Pindah ${esc(r.nama || '')}</h3>
    <div class="pm-ket" style="margin-bottom:12px;">Sekarang di <b>${esc(r.asal.kode_pendek)}</b> · ${r.asal.teralokasi ? 'teralokasi' : `tunggu ± ${r.asal.tunggu_menit} mnt`}. Pilih mesin ${jenis} tujuan:</div>
    <div class="pv-row">${kartu}</div>
    <div class="pv-leg"><span><i class="fas fa-circle" style="color:#22c55e"></i>Kosong</span><span><i class="fas fa-circle" style="color:#f59e0b"></i>Teralokasi</span><span><i class="fas fa-circle" style="color:#ef4444"></i>Jalan</span><span><i class="fas fa-circle" style="color:#94a3b8"></i>Maintenance</span></div>
    ${bisa ? det : emptyState('Tidak ada mesin lain yang aktif', 'fa-ban')}
    <button class="btn-zl btn-light-zl" onclick="renderPopupMesin()">Kembali</button>`;
}
function pilihKartuPindah(mesinId) { PMV.pilih = mesinId; renderPindahMesin(); }
/** Perubahan #36: shortcut WA ke setiap pelanggan terdampak (kasir pilih kirim ke siapa). */
const PV_PERAN = { dipindah: 'Dipindah', didahului: 'Tergeser (didahului)', maju: 'Giliran maju', naik: 'Urutan naik', turun: 'Urutan turun' };
function renderHasilWa(judul, wa) {
  const baris = (wa || []).map((w) => {
    const no = pmWaNomor(w.telepon);
    const tombol = no
      ? `<a class="pm-btn3d pm-wa" title="Kirim WhatsApp" href="https://wa.me/${no}?text=${encodeURIComponent(w.pesan || '')}" target="_blank" rel="noopener noreferrer"><i class="fab fa-whatsapp"></i><span class="pm-fb">WA</span></a>`
      : `<span class="pm-ket">tanpa nomor</span>`;
    return `<div class="pm-blok pv-wa">
        <div class="pm-lbl"><span>${esc(PV_PERAN[w.peran] || w.peran)}${w.mesin ? ` · ${esc(w.mesin)} ${esc(w.posisi || '')}` : ''}</span><span class="pm-aksi">${tombol}</span></div>
        <div class="pm-nama">${esc(w.nama || '')}${w.keranjang ? ` - ${esc(w.keranjang)}` : ''}</div>
        <div class="pv-wa-teks">${esc(w.pesan || '').replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>
      </div>`;
  }).join('');
  $('pm-body').innerHTML = `<h3><i class="fas fa-circle-check" style="color:#16a34a"></i> ${esc(judul)}</h3>
    <div class="pm-ket" style="margin-bottom:10px;">Kabari pelanggan yang terdampak — kirim ke salah satu atau semuanya:</div>
    ${baris || '<div class="pm-ket">Tidak ada pelanggan yang perlu dikabari.</div>'}
    <button class="btn-zl btn-primary-zl" style="width:100%;" onclick="bukaPopupMesin(PM.id)">Selesai</button>`;
}
function pilihPindah(mesinId, posisi, label) {
  PMV.tujuan = mesinId; PMV.posisi = posisi; PMV.ringkas = label;
  const chip = (t) => `<button class="pmv-chip" onclick="$('pm-alasan').value=this.textContent">${t}</button>`;
  $('pm-body').innerHTML = `<h3><i class="fas fa-right-left"></i> ${esc(PMV.nama || '')}: ${esc(PMV.asal || '')} → ${esc(label)}</h3>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan (wajib)</label>
    <div class="pmv-chips">${chip('Mesin lain kosong lebih dulu')}${chip('Pelanggan teralokasi belum datang')}${chip('Permintaan pelanggan')}</div>
    <textarea id="pm-alasan" placeholder="Tulis atau pilih alasan di atas" style="width:100%;min-height:60px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:'Poppins';font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-zl btn-light-zl" style="flex:1;" onclick="renderPopupMesin()">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-pmv" onclick="doPindahMesin()"><i class="fas fa-check"></i> Pindahkan</button>
    </div>`;
}
async function doPindahMesin() {
  const alasan = ($('pm-alasan') ? $('pm-alasan').value : '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-pmv'); btnLoad(btn, true);
  try {
    const r = await api('/mesin/' + PMV.tujuan + '/antrian/pindah', { method: 'POST', body: { transaksi_id: PMV.trxId, posisi: PMV.posisi, alasan } });
    toast(`${PMV.nama || 'Order'} dipindah ke ${r.data.ke}${r.data.hasil === 'teralokasi' ? ' (siap dipakai)' : ''}`, 'success');
    DASH.data = null; loadDashboard();
    renderHasilWa(`${PMV.nama || 'Order'}: ${r.data.dari} → ${r.data.ke}`, r.data.wa);
  } catch (e) { toast(e.message || 'Gagal pindah mesin', 'danger'); btnLoad(btn, false); }
}
/** Mesin kosong / teralokasi: ambil order yang antre di mesin lain. */
async function bukaAmbilAntrian() {
  $('pm-body').innerHTML = spinner();
  try {
    const r = (await api('/mesin/' + PM.id + '/ambil-kandidat')).data;
    const rows = r.kandidat.map((k) => `<div class="pm-blok pmv-opsi" onclick="pilihAmbil(${k.transaksi_id},'${esc((k.nama || '').replace(/'/g, ''))}','${esc(k.mesin_asal)}')" style="cursor:pointer;">
        <div class="pm-nama">${esc(k.nama || '')}${k.berat ? ` - ${k.berat}Kg` : ''}${k.kode_keranjang ? ` - ${esc(k.kode_keranjang)}` : ''}${k.paket ? ` · ${esc(k.paket)}` : ''}</div>
        <div class="pm-ket">di ${esc(k.mesin_asal)} · ${esc(k.posisi)}${k.posisi === 'teralokasi' ? '' : ` · tunggu ± ${k.tunggu_menit} mnt`}</div>
      </div>`).join('');
    $('pm-body').innerHTML = `<h3><i class="fas fa-arrow-turn-down"></i> Ambil ke ${esc(r.mesin.kode_pendek)}</h3>
      <div class="pm-ket" style="margin-bottom:10px;">${esc(r.kondisi ? r.kondisi.teks : '')}. Pilih order yang dipindah ke mesin ini (urut waktu bayar):</div>
      ${rows || emptyState('Tidak ada order yang antre di mesin lain', 'fa-mug-hot')}
      <button class="btn-zl btn-light-zl" style="margin-top:4px;" onclick="renderPopupMesin()">Kembali</button>`;
  } catch (e) { toast(e.message || 'Gagal memuat antrian', 'danger'); renderPopupMesin(); }
}
function pilihAmbil(trxId, nama, asal) {
  PMV = { trxId, tujuan: PM.id, posisi: 'depan', nama, asal };
  pilihPindah(PM.id, 'depan', (PM.data && PM.data.mesin.kode_pendek) || '');
}

/* ============================================================
   UBAH PESANAN (Perubahan #6) -- tambah / kurangi layanan dari popup mesin
   - Hapus hanya layanan yang belum jalan (server yang menentukan bisa_hapus).
   - Tambah: 1 pilihan per kategori; Cuci bertingkat cukup 1 tombol (tarif
     otomatis sesuai berat di server).
   - Order lunas & ada selisih: pilih Cash/QRIS + centang uang sudah
     diterima/dikembalikan. Alasan wajib.
   ============================================================ */
let UB = { id: null, info: null, berat: null, asal: 'mesin', hapus: new Set(), tambah: new Map(), tambahQty: new Map(), qtyLayanan: new Map(), barang: new Map(), barangAwal: new Map(), cari: '', metode: 'cash', konfirmasi: false, alasan: '', alamat: '', prev: null, seq: 0, timer: null };
const UB_KAT_URUT = ['cuci', 'kering', 'drop_off', 'lipat', 'setrika_lipat', 'antar', 'antar_jemput', 'jemput'];
const UB_KAT_LABEL = { cuci: 'Cuci', kering: 'Kering', drop_off: 'Drop-Off', lipat: 'Lipat', setrika_lipat: 'Setrika Lipat', antar: 'Antar', antar_jemput: 'Antar Jemput', jemput: 'Jemput' };
const UB_BRG_LABEL = { laundry: 'BARANG LAUNDRY', cafe: 'CAFE', lainnya: 'BARANG LAIN' };

/**
 * Buka form Ubah Pesanan. asal: 'mesin' (popup kartu mesin, form ditaruh di
 * #pm-body) | 'pesanan' (kartu / detail di menu Pesanan, buka sheet sendiri).
 */
async function bukaUbahPesanan(trxId, asal = 'mesin') {
  UB = { id: trxId, info: null, berat: null, asal, hapus: new Set(), tambah: new Map(), tambahQty: new Map(), qtyLayanan: new Map(), barang: new Map(), barangAwal: new Map(), cari: '', metode: 'cash', konfirmasi: false, alasan: '', alamat: '', prev: null, seq: 0, timer: null };
  if (asal !== 'mesin' || !$('pm-body')) { UB.asal = 'pesanan'; openSheet(`<div id="pm-body">${spinner()}</div>`); }
  else $('pm-body').innerHTML = spinner();
  try {
    UB.info = (await api('/transaksi/' + trxId + '/ubah-pesanan')).data;
    (UB.info.barang || []).forEach((b) => { UB.barang.set(b.barang_id, b.qty); UB.barangAwal.set(b.barang_id, b.qty); });
    renderUbahPesanan();
  } catch (e) {
    $('pm-body').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation')
      + `<button class="btn-zl btn-light-zl" style="margin-top:12px;" onclick="ubKembali()">Kembali</button>`;
  }
}
function ubKembali() { if (UB.asal === 'mesin' && PM.data) renderPopupMesin(); else closeSheet(); }

/** Opsi tambah per kategori (Cuci bertingkat digabung 1 tombol). */
function ubOpsiTambah() {
  const per = {};
  (UB.info.katalog || []).forEach((k) => { (per[k.kategori] = per[k.kategori] || []).push(k); });
  const out = [];
  UB_KAT_URUT.forEach((kat) => {
    const list = per[kat]; if (!list) return;
    if (kat === 'cuci' && list.some((x) => x.berat_maks != null)) {
      const wakil = list.find((x) => x.berat_maks != null) || list[0];
      out.push({ ...wakil, nama: 'Cuci (tarif sesuai berat)' });
    } else list.forEach((x) => out.push(x));
  });
  return out;
}

function ubStepper(nilai, onMin, onPlus, { minDis = false, plusDis = false } = {}) {
  return `<span class="ub-step"><button class="pm-btn3d" ${minDis ? 'disabled' : `onclick="${onMin}"`}>−</button><b>${nilai}</b><button class="pm-btn3d" ${plusDis ? 'disabled' : `onclick="${onPlus}"`}>+</button></span>`;
}

function renderUbahPesanan() {
  const inf = UB.info; if (!inf || !$('pm-body')) return;
  const d = PM.data || {};
  const semua = [d.sebelumnya, d.sekarang, ...(d.antrian || [])].filter(Boolean);
  const org = UB.asal === 'mesin' ? semua.find((x) => Number(x.transaksi_id) === Number(UB.id)) : null;
  let h = `<div class="pm-head"><h3 style="margin:0;"><i class="fas fa-pen-to-square"></i> Ubah Pesanan</h3>
      <span class="pm-pill" style="background:var(--tk3-bg);color:var(--tk3-ink-soft,var(--text-muted));">${esc(inf.no_invoice)}</span></div>`;
  if (org) h += `<div class="pm-nama" style="margin:-4px 0 12px;">${pmNama(org)}</div>`;
  if (inf.blokir) {
    h += `<div class="pm-blok"><div class="pm-ket"><i class="fas fa-lock"></i> ${esc(inf.blokir)}</div></div>
      <div class="pm-btns"><button class="btn-zl btn-light-zl" onclick="ubKembali()">Kembali</button></div>`;
    $('pm-body').innerHTML = h; return;
  }
  // ===== Perubahan #72: tampilan sama dengan Pesankan (kartu ikon 3D) =====
  const IK = window.IK3D;
  UB.expand = UB.expand || { laundry: false, cafe: false, lainnya: false };
  const aktif = inf.items.filter((i) => !UB.hapus.has(i.detail_id));
  const katSisa = new Set(aktif.map((i) => i.kategori));

  // ---- BERAT CUCIAN (Perubahan #50) ----
  if (inf.bisa_berat && Number(inf.berat_kg) > 0) {
    const bLama = Number(inf.berat_kg);
    const bNow = UB.berat != null ? UB.berat : bLama;
    const ubah = UB.berat != null && UB.berat !== bLama;
    h += `<div class="section-label"><i class="fas fa-weight-hanging"></i> Berat Cucian${ubah ? ` <small style="font-weight:400;">(sebelumnya ${IK.fmtBerat(bLama)} kg)</small>` : ''}</div>
      <div class="ik-berat"><div class="ik-ico g-berat"><i class="fas fa-weight-hanging"></i></div>
        <div class="ik-bin"><label for="ub-berat">Berat cucian</label>
          <div class="ik-brow">
            <button type="button" onclick="ubGeserBerat(-0.1)">−</button>
            <div class="v"><input class="vin" id="ub-berat" inputmode="decimal" autocomplete="off" value="${IK.fmtBerat(bNow)}" style="width:${IK.lebarBerat(IK.fmtBerat(bNow))}" oninput="window.IK3D.pasLebar(this)" onchange="ubSetBerat(this.value)"> <small>kg</small></div>
            <button type="button" onclick="ubGeserBerat(0.1)">+</button>
          </div>
          <div class="ik-bh">dihitung ${IK.beratHitung(bNow)} kg · tarif Cuci &amp; lipat/setrika ikut berat</div>
        </div>
      </div>`;
  }

  const GRUP_LIPAT = ['lipat', 'setrika_lipat'];
  const GRUP_ANTAR = ['antar', 'antar_jemput', 'jemput'];
  const grupDari = (kat) => (GRUP_LIPAT.includes(kat) ? GRUP_LIPAT : GRUP_ANTAR.includes(kat) ? GRUP_ANTAR : [kat]);
  const opsi = ubOpsiTambah();
  const satuanTxt = (k) => (k.satuan === 'per_kg' ? '/kg' : k.satuan === 'per_km' ? '/km' : '');

  // kartu layanan yang SUDAH ADA di pesanan: terpilih; ketuk = hapus / batal hapus
  const kartuAda = (i) => {
    const dihapus = UB.hapus.has(i.detail_id);
    const q = UB.qtyLayanan.has(i.detail_id) ? UB.qtyLayanan.get(i.detail_id) : i.qty;
    const ik = IK.ikonLayanan(i.kategori);
    const m = i.kategori === 'kering' ? Number(i.durasi_menit) || 0 : 0;
    const desc = dihapus ? '<span class="ub-tdel"><i class="fas fa-trash-can"></i> dihapus · ketuk untuk batal</span>'
      : !i.bisa_hapus ? `<span class="ub-tlock"><i class="fas fa-lock"></i> ${esc(i.alasan_tidak || 'terkunci')}</span>`
      : 'sudah dipesan · ketuk untuk hapus';
    return `<div class="ub-twrap${dihapus ? ' del' : ''}">${IK.tile({ sel: !dihapus, ...ik, badge: m ? `${m}'` : '', nama: i.nama + (q > 1 && !i.bisa_qty ? ` ×${q}` : ''), desc,
      harga: rupiah(i.harga * q) + (i.kategori === 'drop_off' ? '' : ''), onclick: i.bisa_hapus ? `ubToggleHapus(${i.detail_id})` : '',
      extra: i.bisa_qty && !dihapus ? IK.qty(q, `ubQtyLayanan(${i.detail_id},-1)`, `ubQtyLayanan(${i.detail_id},1)`, q >= (i.qty_maks || 99)) : '' })}</div>`;
  };
  // kartu TAMBAH layanan
  const kartuTambah = (k) => {
    const dipilih = UB.tambah.get(k.kategori) === k.layanan_id;
    const lainAda = grupDari(k.kategori).find((kt) => kt !== k.kategori && katSisa.has(kt));
    const bisa = k.bisa_tambah && !lainAda;
    const ket = !k.bisa_tambah ? `<i class="fas fa-lock"></i> ${esc(k.alasan_tidak || '')}` : lainAda ? `sudah ada ${esc(UB_KAT_LABEL[lainAda] || lainAda)}` : dipilih ? '<b style="color:#047857;">ditambahkan</b> · ketuk untuk batal' : 'ketuk untuk tambah';
    const qT = UB.tambahQty.get(k.kategori) || 1;
    return IK.tile({ sel: dipilih, ...IK.ikonLayanan(k.kategori), nama: k.nama, desc: ket, harga: rupiah(k.harga) + satuanTxt(k), dis: !bisa,
      onclick: bisa && !(dipilih && k.qty_maks) ? `ubToggleTambah('${k.kategori}',${k.layanan_id})` : '',
      extra: dipilih && k.qty_maks ? IK.qty(qT, qT <= 1 ? `ubToggleTambah('${k.kategori}',${k.layanan_id})` : `ubQtyTambah('${k.kategori}',-1)`, `ubQtyTambah('${k.kategori}',1)`, qT >= k.qty_maks) : '' });
  };
  // kering: 1 kartu berputar (#52) bila belum ada kering aktif
  const keringOpsi = opsi.filter((k) => k.kategori === 'kering' && k.bisa_tambah);
  const kartuKering = () => {
    const list = keringOpsi.map((k) => ({ id: k.layanan_id, durasi_menit: k.durasi_menit, harga: k.harga }));
    return IK.tileKering({ kering: UB.tambah.get('kering') || null }, list, ubRekomKering(), rupiah, 'ubPutarKering()');
  };

  const tilesGrup = (kats) => {
    let t = aktif.concat(inf.items.filter((i) => UB.hapus.has(i.detail_id))).filter((i) => kats.includes(i.kategori)).map(kartuAda).join('');
    kats.forEach((kat) => {
      if (katSisa.has(kat)) return;
      if (kat === 'kering') { if (keringOpsi.length) t += kartuKering(); else { const k = opsi.find((x) => x.kategori === 'kering'); if (k) t += kartuTambah(k); } return; }
      opsi.filter((k) => k.kategori === kat).forEach((k) => { t += kartuTambah(k); });
    });
    return t;
  };
  h += `<div class="section-label"><i class="fas fa-star"></i> Layanan Utama</div><div class="ik-grid2">${tilesGrup(['cuci', 'kering'])}</div>`;
  const tambahanHtml = tilesGrup(['drop_off', 'lipat', 'setrika_lipat', 'antar', 'antar_jemput', 'jemput']);
  if (tambahanHtml) h += `<div class="section-label"><i class="fas fa-plus"></i> Layanan Tambahan</div><div class="ik-grid2">${tambahanHtml}</div>`;
  if (opsi.some((k) => k.kategori === 'drop_off')) h += `<div class="ik-cap">Drop-off 1× = petugas memindahkan ke pengering · 2× = semua dikerjakan petugas</div>`;

  // ---- Perubahan #74: jarak (km) + alamat untuk Antar / Antar Jemput / Jemput yang ditambah ----
  const antarBaru = [...UB.tambah.entries()].map(([kat, id]) => opsi.find((k) => k.kategori === kat && k.layanan_id === id)).find((k) => k && GRUP_ANTAR.includes(k.kategori));
  if (antarBaru) {
    const perKm = antarBaru.satuan === 'per_km';
    const jarak = Number(UB.tambahQty.get(antarBaru.kategori)) || 0;
    const lbl = antarBaru.kategori === 'antar_jemput' ? 'Jemput & Antar' : antarBaru.kategori === 'jemput' ? 'Jemput' : 'Antar';
    h += `<div class="card-zl">
      ${perKm ? `<div class="field">
        <label>Jarak (km) — verifikasi via Google Maps</label>
        <input type="number" id="ub-jarak" min="0" step="0.1" placeholder="cth: 3.5" value="${UB.jarakTeks != null ? esc(UB.jarakTeks) : (jarak || '')}" oninput="ubSetJarak('${antarBaru.kategori}', this.value)">
        <div class="ub-jarak-info" id="ub-jarak-info">${ubJarakInfo(antarBaru, jarak)}</div>
      </div>` : ''}
      ${!inf.alamat_antar ? `<div class="field" style="margin-bottom:0;">
        <label>Alamat ${lbl} + Patokan (wajib)</label>
        <textarea id="ub-alamat" rows="2" placeholder="Alamat lengkap + patokan" oninput="UB.alamat=this.value;clearTimeout(UB.timerJarak);UB.timerJarak=setTimeout(ubPratinjau,600)">${esc(UB.alamat)}</textarea>
      </div>` : `<div class="pm-ket"><i class="fas fa-location-dot"></i> Alamat: ${esc(inf.alamat_antar)}</div>`}
    </div>`;
  }

  // ---- BARANG (sama dengan Pesankan: kartu foto/ikon, terlipat per kelompok) ----
  const cari = (UB.cari || '').trim().toLowerCase();
  const grup = {};
  (inf.barang || []).forEach((b) => {
    // Perubahan #76: stok 0 / nonaktif tidak dimunculkan, kecuali sudah ada di pesanan ini
    if (!(UB.barangAwal.get(b.barang_id) || 0) && !(UB.barang.get(b.barang_id) || 0) && (Number(b.stok) <= 0 || b.nonaktif)) return;
    const kat = b.kategori === 'laundry' || b.kategori === 'cafe' ? b.kategori : 'lainnya';
    (grup[kat] = grup[kat] || []).push(b);
  });
  const JUDUL = { laundry: ['fa-box', 'Kebutuhan Laundry'], cafe: ['fa-mug-hot', 'Cafe &amp; Minuman'], lainnya: ['fa-boxes-stacked', 'Barang Lain'] };
  ['laundry', 'cafe', 'lainnya'].filter((k) => grup[k]).forEach((k) => {
    const list = grup[k];
    const ring = list.filter((b) => (UB.barang.get(b.barang_id) || 0) > 0).map((b) => `${b.nama} ×${UB.barang.get(b.barang_id)}`).join(', ');
    const buka = UB.expand[k] || !!cari || list.some((b) => (UB.barang.get(b.barang_id) || 0) !== (UB.barangAwal.get(b.barang_id) || 0));
    h += IK.sec(JUDUL[k][0], JUDUL[k][1], buka, ring, `ubToggleExpand('${k}')`);
    if (!buka) return;
    if (k === 'cafe' || list.length > 8) h += `<input type="text" id="ub-cari-${k}" class="ik-search" placeholder="Cari produk... (kopi, deterjen, dll)" value="${esc(UB.cari)}" oninput="ubCari(this.value, 'ub-cari-${k}')">`;
      // Perubahan #76: stok 0 / nonaktif disembunyikan, kecuali sudah ada di pesanan ini
    const tampil = list.filter((b) => {
      const q = UB.barang.get(b.barang_id) || 0; const awal = UB.barangAwal.get(b.barang_id) || 0;
      if (!q && !awal && (Number(b.stok) <= 0 || b.nonaktif)) return false;
      return !cari || String(b.nama).toLowerCase().includes(cari) || q > 0;
    });
    h += `<div class="ik-grid2">${tampil.map((b) => {
      const q = UB.barang.get(b.barang_id) || 0;
      const awal = UB.barangAwal.get(b.barang_id) || 0;
      const maks = awal + Math.max(0, b.stok);
      const habis = !awal && b.stok <= 0;
      const ik = IK.ikonBarang(b);
      return IK.tile({ sel: q > 0, g: ik.g, ico: ik.ico, foto: IK.fotoUrl(API, b), nama: b.nama, harga: rupiah(b.harga),
        desc: b.nonaktif ? 'nonaktif' : (q !== awal ? `sebelumnya ${awal}` : ''), dis: habis || (b.nonaktif && !q),
        onclick: q > 0 || habis || b.nonaktif ? '' : `ubQtyBarang(${b.barang_id},1)`,
        extra: `<div class="ik-stok">stok ${b.stok}</div>` + (habis ? '' : IK.qty(q, `ubQtyBarang(${b.barang_id},-1)`, `ubQtyBarang(${b.barang_id},1)`, q >= maks || b.nonaktif)) });
    }).join('') || '<div class="pm-ket">Tidak ada barang yang cocok</div>'}</div>`;
  });

  h += `<div id="ub-ringkas"></div>`;
  h += `<div class="pm-blok"><div class="pm-lbl"><span>ALASAN (WAJIB)</span></div>
    <textarea id="ub-alasan" class="ub-input" style="min-height:64px;" placeholder="Contoh: customer minta tambah kering 30 menit" oninput="UB.alasan=this.value">${esc(UB.alasan)}</textarea></div>
    <div class="pm-btns">
      <button class="btn-zl btn-light-zl" onclick="ubKembali()">Batal</button>
      <button class="btn-zl btn-primary-zl" id="btn-ub-simpan" onclick="doSimpanUbah()">Simpan</button>
    </div>`;
  const scroll = document.querySelector('.sheet') ? document.querySelector('.sheet').scrollTop : 0;
  $('pm-body').innerHTML = h;
  if (document.querySelector('.sheet')) document.querySelector('.sheet').scrollTop = scroll;
  ubPratinjau();
}

/* Perubahan #72/#74: helper tampilan Ubah Pesanan */
function ubToggleExpand(k) { UB.expand = UB.expand || {}; UB.expand[k] = !UB.expand[k]; renderUbahPesanan(); }
function ubRekomKering() {
  const list = (UB.info.katalog || []).filter((k) => k.kategori === 'kering' && k.bisa_tambah);
  const berat = window.IK3D.beratHitung(UB.berat != null ? UB.berat : UB.info.berat_kg);
  const mau = berat > 0 && berat <= 6 ? 30 : 45;
  const r = list.find((k) => Number(k.durasi_menit) === mau) || list.find((k) => Number(k.durasi_menit) >= 30) || list[0];
  return r ? r.layanan_id : null;
}
function ubPutarKering() {
  const list = (UB.info.katalog || []).filter((k) => k.kategori === 'kering' && k.bisa_tambah).sort((a, b) => Number(a.durasi_menit) - Number(b.durasi_menit));
  if (!list.length) return;
  const rek = ubRekomKering();
  const urut = [list.find((k) => k.layanan_id === rek), ...list.filter((k) => k.layanan_id !== rek && Number(k.durasi_menit) > Number((list.find((x) => x.layanan_id === rek) || {}).durasi_menit || 0)),
    ...list.filter((k) => k.layanan_id !== rek && Number(k.durasi_menit) <= Number((list.find((x) => x.layanan_id === rek) || {}).durasi_menit || 0))].filter(Boolean);
  const now = UB.tambah.get('kering');
  const i = urut.findIndex((k) => k.layanan_id === now);
  if (i === -1) UB.tambah.set('kering', urut[0].layanan_id);
  else if (i + 1 < urut.length) UB.tambah.set('kering', urut[i + 1].layanan_id);
  else UB.tambah.delete('kering');
  UB.konfirmasi = false; renderUbahPesanan();
}
function ubJarakInfo(k, jarak) {
  return `Tarif ${rupiah(k.harga)}/km${jarak > 0 ? ` × ${String(jarak).replace('.', ',')} km = <b style="color:var(--primary);">${rupiah(Math.round(k.harga * jarak))}</b>` : ''}`;
}
function ubSetJarak(kat, v) {
  UB.jarakTeks = v;
  const n = Number(String(v).replace(',', '.'));
  if (n > 0) UB.tambahQty.set(kat, Math.round(n * 10) / 10); else UB.tambahQty.delete(kat);
  const k = (UB.info.katalog || []).find((x) => x.kategori === kat && x.layanan_id === UB.tambah.get(kat));
  const info = $('ub-jarak-info'); if (info && k) info.innerHTML = ubJarakInfo(k, Number(UB.tambahQty.get(kat)) || 0);
  UB.konfirmasi = false;
  clearTimeout(UB.timerJarak); UB.timerJarak = setTimeout(ubPratinjau, 400);
}

function ubAdaUbah() {
  const b = ubBody();
  return b.hapus.length || b.tambah.length || b.qty_layanan.length || b.barang.length || b.berat_kg != null;
}
/* Perubahan #50: ubah berat (koma / titik, 1 angka desimal) */
function ubSetBerat(v) {
  const IK = window.IK3D;
  const b = IK.parseBerat(v);
  if (isNaN(b) || b <= 0) { toast('Berat tidak valid. Contoh: 6,5 atau 6.5', 'warning'); renderUbahPesanan(); return; }
  const r = IK.rapikanBerat(b);
  UB.berat = r === Number(UB.info.berat_kg) ? null : r;
  UB.konfirmasi = false; renderUbahPesanan();
}
function ubGeserBerat(d) {
  const awal = UB.berat != null ? UB.berat : Number(UB.info.berat_kg);
  ubSetBerat(String(Math.max(0.1, window.IK3D.rapikanBerat(awal + d))));
}
function ubToggleHapus(detailId) {
  if (UB.hapus.has(detailId)) UB.hapus.delete(detailId); else UB.hapus.add(detailId);
  const item = UB.info.items.find((i) => i.detail_id === detailId);
  if (item && !UB.hapus.has(detailId)) UB.tambah.delete(item.kategori);
  UB.konfirmasi = false;
  renderUbahPesanan();
}
function ubToggleTambah(kat, layananId) {
  // Perubahan #72: satu pilihan per kelompok (lipat/setrika, antar/antar jemput/jemput) seperti Pesankan
  const GRUP = [['lipat', 'setrika_lipat'], ['antar', 'antar_jemput', 'jemput']].find((g) => g.includes(kat)) || [kat];
  if (UB.tambah.get(kat) === layananId) { UB.tambah.delete(kat); UB.tambahQty.delete(kat); UB.jarakTeks = null; }
  else {
    GRUP.forEach((k) => { if (k !== kat) { UB.tambah.delete(k); UB.tambahQty.delete(k); } });
    if (['antar', 'antar_jemput', 'jemput'].includes(kat)) { UB.tambahQty.delete(kat); UB.jarakTeks = null; }
    UB.tambah.set(kat, layananId);
  }
  UB.konfirmasi = false;
  renderUbahPesanan();
}
function ubQtyTambah(kat, delta) { UB.tambahQty.set(kat, Math.max(1, (UB.tambahQty.get(kat) || 1) + delta)); UB.konfirmasi = false; renderUbahPesanan(); }
function ubQtyLayanan(detailId, delta) {
  const it = UB.info.items.find((i) => i.detail_id === detailId); if (!it) return;
  const q = Math.min(it.qty_maks || 99, Math.max(1, (UB.qtyLayanan.has(detailId) ? UB.qtyLayanan.get(detailId) : it.qty) + delta));
  if (q === it.qty) UB.qtyLayanan.delete(detailId); else UB.qtyLayanan.set(detailId, q);
  UB.konfirmasi = false; renderUbahPesanan();
}
function ubQtyBarang(barangId, delta) {
  UB.barang.set(barangId, Math.max(0, (UB.barang.get(barangId) || 0) + delta));
  UB.konfirmasi = false; renderUbahPesanan();
}
function ubCari(v, elId = 'ub-cari') {
  UB.cari = v;
  clearTimeout(UB.timer);
  UB.timer = setTimeout(() => { renderUbahPesanan(); const el = $(elId); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 250);
}
function ubBody() {
  const barang = [];
  UB.barang.forEach((q, id) => { if (q !== (UB.barangAwal.get(id) || 0)) barang.push({ barang_id: id, qty: q }); });
  return {
    hapus: [...UB.hapus],
    tambah: [...UB.tambah.entries()].map(([kat, id]) => ({ layanan_id: id, qty: UB.tambahQty.get(kat) || undefined })),
    qty_layanan: [...UB.qtyLayanan.entries()].filter(([id]) => !UB.hapus.has(id)).map(([detail_id, qty]) => ({ detail_id, qty })),
    barang,
    berat_kg: UB.berat != null ? UB.berat : undefined,
    alamat_antar: UB.alamat && UB.alamat.trim() ? UB.alamat.trim() : undefined, // #74: pratinjau butuh alamat
  };
}

async function ubPratinjau() {
  const box = $('ub-ringkas'); if (!box) return;
  if (!ubAdaUbah()) { UB.prev = null; box.innerHTML = ''; return; }
  // Perubahan #74: antar/antar jemput/jemput baru -> tunggu jarak & alamat diisi dulu
  const antarBaru = [...UB.tambah.entries()].map(([kat, id]) => (UB.info.katalog || []).find((k) => k.kategori === kat && k.layanan_id === id))
    .find((k) => k && ['antar', 'antar_jemput', 'jemput'].includes(k.kategori));
  if (antarBaru) {
    const kurang = [];
    if (antarBaru.satuan === 'per_km' && !(Number(UB.tambahQty.get(antarBaru.kategori)) > 0)) kurang.push('jarak (km)');
    if (!UB.info.alamat_antar && !(UB.alamat || '').trim()) kurang.push('alamat');
    if (kurang.length) { UB.prev = null; box.innerHTML = `<div class="pm-blok"><div class="pm-ket"><i class="fas fa-circle-info"></i> Isi ${kurang.join(' & ')} dulu untuk menghitung total.</div></div>`; return; }
  }
  const seq = ++UB.seq;
  box.innerHTML = `<div class="pm-blok"><div class="pm-ket">Menghitung…</div></div>`;
  try {
    const r = (await api('/transaksi/' + UB.id + '/ubah-pesanan/pratinjau', { method: 'POST', body: ubBody() })).data;
    if (seq !== UB.seq) return;
    UB.prev = r;
    let x = `<div class="pm-blok"><div class="pm-lbl"><span>RINGKASAN</span></div>
      ${r.berat_berubah ? `<div class="ub-sum"><span>Berat</span><b>${window.IK3D.fmtBerat(r.berat_lama)} → ${window.IK3D.fmtBerat(r.berat_baru)} kg</b></div>` : ''}
      ${(r.diubah || []).filter((u) => u.nama_baru || u.qty_baru !== u.qty_lama).map((u) => `<div class="ub-sum"><span>${esc(u.nama_baru ? `${u.nama} → ${u.nama_baru}` : `${u.nama} ${u.qty_lama} → ${u.qty_baru}`)}</span><b>${rupiah(u.subtotal_baru)}</b></div>`).join('')}
      ${r.berat_berubah && typeof maxKapasitasWasher === 'function' && PSN.katalog && maxKapasitasWasher() != null && r.berat_baru > maxKapasitasWasher() ? `<div class="pm-ket" style="color:#b45309;"><i class="fas fa-triangle-exclamation"></i> Berat melebihi kapasitas mesin cuci terbesar (${maxKapasitasWasher()} kg)</div>` : ''}
      <div class="ub-sum"><span>Total lama</span><b>${rupiah(r.total_lama)}</b></div>
      <div class="ub-sum"><span>Total baru</span><b>${rupiah(r.total_baru)}</b></div>`;
    if (r.lunas) x += `<div class="ub-sum"><span>Poin customer</span><b>${r.poin_lama} → ${r.poin_baru}</b></div>`;
    if (r.arah_uang) {
      const terima = r.arah_uang === 'terima';
      x += `<div class="ub-uang ${terima ? 'masuk' : 'keluar'}">${terima ? 'Terima dari customer' : 'Kembalikan ke customer'} <b>${rupiah(r.nominal_uang)}</b></div>
        <div class="ub-metode">
          <button class="ub-opt${UB.metode === 'cash' ? ' on' : ''}" onclick="UB.metode='cash';UB.konfirmasi=false;ubPratinjau()"><i class="fas fa-money-bill-wave"></i> Cash</button>
          <button class="ub-opt${UB.metode === 'qris' ? ' on' : ''}" onclick="UB.metode='qris';UB.konfirmasi=false;ubPratinjau()"><i class="fas fa-qrcode"></i> QRIS</button>
        </div>
        <label class="ub-cek"><input type="checkbox" id="ub-konfirm" ${UB.konfirmasi ? 'checked' : ''} onchange="UB.konfirmasi=this.checked">
          ${terima ? `Uang ${rupiah(r.nominal_uang)} sudah saya terima via ${UB.metode === 'qris' ? 'QRIS' : 'cash'}` : `Uang ${rupiah(r.nominal_uang)} sudah saya kembalikan via ${UB.metode === 'qris' ? 'QRIS' : 'cash'}`}</label>`;
    } else if (!r.lunas) {
      x += `<div class="pm-ket" style="margin-top:6px;">Belum lunas — tagihan ikut total baru.</div>`;
    }
    x += `</div>`;
    box.innerHTML = x;
  } catch (e) {
    if (seq !== UB.seq) return;
    UB.prev = null;
    box.innerHTML = `<div class="pm-blok"><div class="pm-ket" style="color:var(--danger);"><i class="fas fa-triangle-exclamation"></i> ${esc(e.message)}</div></div>`;
  }
}

async function doSimpanUbah() {
  if (!ubAdaUbah()) { toast('Belum ada perubahan pesanan', 'warning'); return; }
  const alasan = (UB.alasan || '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  // Perubahan #74: jarak wajib untuk antar/antar jemput/jemput per km
  const antarKm = [...UB.tambah.entries()].map(([kat, id]) => (UB.info.katalog || []).find((k) => k.kategori === kat && k.layanan_id === id))
    .find((k) => k && ['antar', 'antar_jemput', 'jemput'].includes(k.kategori) && k.satuan === 'per_km');
  if (antarKm && !(Number(UB.tambahQty.get(antarKm.kategori)) > 0)) { toast('Isi jarak (km) untuk ' + antarKm.nama, 'warning'); return; }
  if (antarKm && !UB.info.alamat_antar && !(UB.alamat || '').trim()) { toast('Alamat wajib diisi', 'warning'); return; }
  if (!UB.prev) { toast('Periksa lagi perubahan pesanan', 'warning'); return; }
  if (UB.prev.arah_uang && !UB.konfirmasi) {
    toast(UB.prev.arah_uang === 'terima' ? 'Centang dulu: uang tambahan sudah diterima' : 'Centang dulu: uang sudah dikembalikan', 'warning'); return;
  }
  const btn = $('btn-ub-simpan'); btnLoad(btn, true);
  try {
    const body = { ...ubBody(), alasan, metode: UB.metode, konfirmasi_uang: !!UB.konfirmasi };
    if (UB.alamat && UB.alamat.trim()) body.alamat_antar = UB.alamat.trim();
    await api('/transaksi/' + UB.id + '/ubah-pesanan', { method: 'POST', body });
    toast('Pesanan diubah', 'success');
    DASH.data = null;
    if (UB.asal === 'mesin' && PM.id) { loadDashboard(); bukaPopupMesin(PM.id); }
    else {
      closeSheet();
      // muat ulang tampilan asal di menu Pesanan
      if (OD && OD.id === UB.id && $('page-order-detail') && $('page-order-detail').classList.contains('active')) openOrderDetail(UB.id);
      else loadPesanan();
    }
  } catch (e) { toast(e.message || 'Gagal ubah pesanan', 'danger'); btnLoad(btn, false); }
}

async function bukaPopupMesin(mesinId) {
  PM = { id: mesinId, data: null };
  openSheet(`<div id="pm-body">${spinner()}</div>`);
  try {
    const res = await api('/mesin/' + mesinId + '/popup');
    PM.data = res.data;
    renderPopupMesin();
  } catch (e) {
    $('pm-body').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

/** Perubahan #63: total transaksi di kiri bawah kartu popup mesin */
function pmTotal(b) { return b && b.total != null ? `<div class="pm-total">${rupiah(b.total)}</div>` : ''; }
function pmBlok(label, isi, kanan = '', kelas = '') {
  return `<div class="pm-blok ${kelas}">
      <div class="pm-lbl"><span>${label}</span>${kanan ? `<span class="pm-aksi">${kanan}</span>` : ''}</div>
      ${isi}
    </div>`;
}

/**
 * Perubahan #10: tombol aksi mesin ditaruh DI DALAM blok SEKARANG.
 * Perubahan #11: + [Selesai Cuci] (mesin cuci jalan), aktif mulai menit ke-30.
 */
const PM_GATE_SELESAI_CUCI = 30;
function pmTombolAksi(d, now, tipe) {
  if (d.status === 'running' && now.kondisi === 'jalan') {
    if (tipe === 'dryer') {
      return `<div class="pm-btns pm-btns-in pm-btns-3">
          <button class="btn-zl btn-primary-zl" onclick="bukaRestartMesin('start')">▶ Start</button>
          <button class="btn-zl btn-light-zl" id="btn-pm-resume" onclick="doResumeKering()">⏯ Resume</button>
          <button class="btn-zl btn-light-zl" onclick="bukaRestartMesin('mesin_off')">↻ Restart (Mesin OFF)</button>
        </div>
        <div class="pm-btns pm-btns-in"><button class="btn-zl btn-light-zl pm-onoff" id="btn-pm-onoff" onclick="doOnOffMesin(${now.transaksi_id})">⏻ On/Off</button></div>
        <div class="pm-hint"><i class="fas fa-circle-info"></i> Mesin NYALA: Start = durasi dari awal (wajib alasan), Resume = lanjut. Mesin MATI: Restart (Mesin OFF) = ON → Start, durasi dari awal. On/Off = tekan tombol power saja.</div>`;
    }
    const lewat = Number(now.lewat_menit) || 0;
    const durasi = lewat + Math.max(0, Number(now.sisa_menit) || 0);
    const gate = Math.min(PM_GATE_SELESAI_CUCI, durasi || PM_GATE_SELESAI_CUCI);
    const bisa = lewat >= gate;
    return `<div class="pm-btns pm-btns-in pm-btns-3">
        <button class="btn-zl btn-light-zl" onclick="bukaRestartMesin('mesin_on')">↻ Restart (Mesin ON)</button>
        <button class="btn-zl btn-light-zl" onclick="bukaRestartMesin('mesin_off')">↻ Restart (Mesin OFF)</button>
        <button class="btn-zl btn-primary-zl" id="btn-pm-selesai" ${bisa ? '' : 'disabled'} onclick="doSelesaiCuciPopup(${now.transaksi_id})">✓ Selesai Cuci</button>
      </div>
      <div class="pm-btns pm-btns-in"><button class="btn-zl btn-light-zl pm-onoff" id="btn-pm-onoff" onclick="doOnOffMesin(${now.transaksi_id})">⏻ On/Off</button></div>
      <div class="pm-hint"><i class="fas fa-circle-info"></i> Mesin ON (pintu dC / keran 4C): OFF → ON → Start. Mesin OFF (belum dicolok): ON → Start. Timer mulai dari awal.
        ${bisa ? 'Selesai Cuci: tandai cuci selesai lebih cepat.' : `Selesai Cuci aktif di menit ke-${gate} (± ${Math.max(1, gate - lewat)} mnt lagi).`}</div>`;
  }
  if (d.status === 'teralokasi' && now.kondisi !== 'jalan') {
    const target = tipe === 'dryer' ? 'mulai_kering' : 'mulai_cuci';
    return `<div class="pm-btns pm-btns-in"><button class="btn-zl btn-primary-zl" style="flex:1;" onclick="prosesLangsungMesin(${now.transaksi_id},'${target}','${esc(d.mesin.kode_pendek)}')">▶ Mulai Proses</button></div>`;
  }
  return '';
}

/** Perubahan #21: tombol power mesin (tanpa alasan, langsung eksekusi; tercatat di log). */
async function doOnOffMesin(trxId) {
  const btn = $('btn-pm-onoff'); btnLoad(btn, true);
  try {
    const r = await api('/transaksi/' + trxId + '/onoff-mesin', { method: 'POST' });
    toast(r.message || 'Tombol power ditekan', 'success');
  } catch (e) { toast(e.message || 'Gagal', 'danger'); }
  btnLoad(btn, false);
}

async function doSelesaiCuciPopup(trxId) {
  const btn = $('btn-pm-selesai'); btnLoad(btn, true);
  try {
    await api('/transaksi/' + trxId + '/selesai-cuci', { method: 'POST' });
    toast('Cuci diselesaikan', 'success');
    DASH.data = null;
    loadDashboard();
    if (PM.id) bukaPopupMesin(PM.id);
  } catch (e) { toast(e.message || 'Gagal menyelesaikan cuci', 'danger'); btnLoad(btn, false); }
}

function renderPopupMesin() {
  const d = PM.data; if (!d || !$('pm-body')) return;
  const tipe = d.mesin.tipe;
  const st = PM_ST[d.status] || PM_ST.idle;
  let h = `<div class="pm-head">
      <h3 style="margin:0;"><i class="fas ${tipe === 'dryer' ? 'fa-wind' : 'fa-soap'}"></i> Mesin ${esc(window.IK3D.kodeMesin(d.mesin.kode_pendek || d.mesin.kode_mesin))}</h3>
      <span class="pm-pill" style="background:${st.bg};color:${st.fg};">${st.dot} ${st.txt}</span>
    </div>`;

  const sebelum = d.sebelumnya
    ? `<div class="pm-nama">${pmNama(d.sebelumnya)}</div>${ikonLayananHtml(d.sebelumnya.layanan)}<div class="pm-ket">${esc(d.sebelumnya.keterangan || '')}</div>`
    : `<div class="pm-ket">Belum ada pengguna sebelumnya</div>`;
  const totSebelum = pmTotal(d.sebelumnya);

  if (d.status === 'idle') {
    const sp = d.sebelumnya;
    // Perubahan #44: saklar posisi cucian
    const posisiHtml = sp && sp.posisi_bisa ? `<div class="pm-posisi">
        <button class="${sp.posisi !== 'keranjang' ? 'on' : ''}" onclick="pmSetPosisi(${sp.transaksi_id},'mesin')"><i class="fas fa-gear"></i> Di mesin</button>
        <button class="${sp.posisi === 'keranjang' ? 'on' : ''}" onclick="pmSetPosisi(${sp.transaksi_id},'keranjang')"><i class="fas fa-basket-shopping"></i> Di keranjang</button>
      </div>` : '';
    h += pmBlok('PENGGUNA TERAKHIR', sebelum + posisiHtml + totSebelum, d.sebelumnya ? pmTombolIdle(d.sebelumnya) : '');
    const rw = d.riwayat || [];
    const jam = (t) => t ? new Date(String(t).replace(' ', 'T')).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '…';
    const isiRw = rw.length
      ? rw.map((r) => `<div class="pm-rw" onclick="closeSheet();openOrderDetail(${r.transaksi_id})">
            <span class="pm-rw-jam">${jam(r.waktu_mulai)}–${jam(r.waktu_selesai)}</span>
            <span class="pm-rw-nama">${pmNama(r)}${tipe === 'dryer' ? ` · ${r.durasi_menit} mnt` : ''}<span class="pm-rw-inv" style="display:block;">${esc(r.no_invoice || '')}${r.total != null ? ` · <b>${rupiah(r.total)}</b>` : ''}</span></span>
            <span class="pm-rw-aksi">${pmTombolIdle(r)}</span>
          </div>`).join('')
      : `<div class="pm-ket">Belum ada pemakaian hari ini</div>`;
    h += pmBlok(`RIWAYAT HARI INI (${rw.length}x pakai)`, isiRw);
    if (d.mode_otomatis) h += `<button class="btn-zl btn-primary-zl pmv-ambil" onclick="bukaAmbilAntrian()"><i class="fas fa-arrow-turn-down"></i> Ambil dari antrian mesin lain</button>`;
    $('pm-body').innerHTML = h;
    return;
  }

  h += pmBlok('SEBELUMNYA', sebelum + totSebelum, d.sebelumnya ? pmTombolBaris(d.sebelumnya, 'sebelumnya') : '');

  const now = d.sekarang;
  const geser = d.bisa_geser;
  const antri = d.antrian || [];
  if (now) {
    let ket;
    if (now.kondisi === 'jalan') {
      ket = now.sisa_menit > 0
        ? `Jalan ${now.lewat_menit} mnt · selesai ± ${now.sisa_menit} mnt`
        : `Jalan ${now.lewat_menit} mnt · waktu habis, menunggu selesai otomatis`;
    } else {
      ket = now.siap_tunggu_bongkar ? PM_SIAP : 'Teralokasi · menunggu dimasukkan ke mesin';
    }
    const kanan = pmTombolBaris(now, 'sekarang') + (geser && antri.length
      ? `<button class="pm-arrow" title="Turunkan" onclick="bukaGeserAntrian(${now.transaksi_id},'turun')">↓</button>` : '');
    h += pmBlok('SEKARANG', `<div class="pm-nama">${pmNama(now)}${pmPaket(now, tipe)}</div>${ikonLayananHtml(now.layanan)}<div class="pm-ket">${esc(ket)}</div>${pmTombolAksi(d, now, tipe)}${pmTotal(now)}`, kanan, now.kondisi === 'jalan' ? 'pm-now-jalan' : 'pm-now-alok');
  }

  antri.forEach((a, i) => {
    const ket = a.siap_tunggu_bongkar ? PM_SIAP : `tunggu ± ${a.tunggu_menit} mnt`;
    let kanan = pmTombolBaris(a, 'antrian', i + 1);
    if (geser) {
      kanan += `<button class="pm-arrow" title="Naikkan" onclick="bukaGeserAntrian(${a.transaksi_id},'naik')">↑</button>`;
      if (i < antri.length - 1) kanan += `<button class="pm-arrow" title="Turunkan" onclick="bukaGeserAntrian(${a.transaksi_id},'turun')">↓</button>`;
    }
    h += pmBlok(`ANTRIAN ${i + 1}`, `<div class="pm-nama">${pmNama(a)}${pmPaket(a, tipe)}</div>${ikonLayananHtml(a.layanan)}<div class="pm-ket">${esc(ket)}</div>${pmTotal(a)}`, kanan);
  });
  if (!antri.length && d.mode_otomatis) h += `<div class="pm-ket" style="text-align:center;margin:4px 0 10px;">Belum ada antrian di mesin ini</div>`;
  if (d.mode_otomatis && d.status === 'teralokasi') h += `<button class="btn-zl btn-light-zl pmv-ambil" onclick="bukaAmbilAntrian()"><i class="fas fa-arrow-turn-down"></i> Ambil dari antrian mesin lain (dahului ${esc(now ? (now.nama || '').split(' ')[0] : '')})</button>`;

  $('pm-body').innerHTML = h;
}

/** Perubahan #44: tandai posisi cucian pengguna terakhir (pesan WA ikut berubah). */
async function pmSetPosisi(trxId, posisi) {
  const sp = PM.data && PM.data.sebelumnya;
  if (sp && sp.posisi === posisi) return;
  try {
    await api(`/transaksi/${trxId}/posisi-manual`, { method: 'POST', body: { posisi } });
    toast(posisi === 'keranjang' ? 'Ditandai: cucian di keranjang' : 'Ditandai: cucian di mesin', 'success');
    DASH.data = null; loadDashboard();
    bukaPopupMesin(PM.id);
  } catch (e) { toast(e.message || 'Gagal ubah posisi', 'danger'); }
}

/** Form alasan sebelum geser urutan antrian (wajib). */
function bukaGeserAntrian(trxId, arah) {
  const d = PM.data; if (!d) return;
  const semua = [d.sekarang, ...(d.antrian || [])].filter(Boolean);
  const o = semua.find((x) => Number(x.transaksi_id) === Number(trxId));
  const verb = arah === 'naik' ? 'Naikkan' : 'Turunkan';
  $('pm-body').innerHTML = `<h3><i class="fas fa-arrow-${arah === 'naik' ? 'up' : 'down'}"></i> ${verb} ${o ? pmNama(o) : ''}</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Urutan antrian Mesin ${esc(d.mesin.kode_pendek)} akan ditukar dengan ${arah === 'naik' ? 'yang di atasnya' : 'yang di bawahnya'}. Estimasi semua customer di mesin ini dihitung ulang.</div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan (wajib)</label>
    <textarea id="pm-alasan" placeholder="Contoh: customer sudah bayar tapi ditinggal pergi" style="width:100%;min-height:70px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:'Poppins';font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-zl btn-light-zl" style="flex:1;" onclick="renderPopupMesin()">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-pm-geser" onclick="doGeserAntrian(${trxId},'${arah}')"><i class="fas fa-check"></i> Simpan</button>
    </div>`;
}
async function doGeserAntrian(trxId, arah) {
  const alasan = ($('pm-alasan') ? $('pm-alasan').value : '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-pm-geser'); btnLoad(btn, true);
  try {
    const r = await api('/mesin/' + PM.id + '/antrian/geser', { method: 'POST', body: { transaksi_id: trxId, arah, alasan } });
    toast('Urutan antrian diubah', 'success');
    DASH.data = null; loadDashboard();
    renderHasilWa(`Urutan antrian ${(PM.data && PM.data.mesin.kode_pendek) || ''} diubah`, r.data && r.data.wa);
  } catch (e) { toast(e.message || 'Gagal ubah urutan', 'danger'); btnLoad(btn, false); }
}

const PM_RESTART = {
  mesin_on:  { judul: 'Restart (Mesin ON)',  ket: 'Mesin masih nyala (pintu lupa ditutup dC / keran belum dibuka 4C). Perintah ke mesin: OFF → ON → Start.', contoh: 'Contoh: pintu lupa ditutup (dC)' },
  mesin_off: { judul: 'Restart (Mesin OFF)', ket: 'Mesin mati (belum dicolok listrik). Colokkan dulu, lalu perintah ke mesin: ON → Start.', contoh: 'Contoh: mesin belum dicolok ke listrik' },
  mesin_off_kering: { judul: 'Restart (Mesin OFF)', ket: 'Pengering dalam posisi MATI. Perintah ke mesin: ON → tunggu 3 detik → Start.', contoh: 'Contoh: pengering mati, tidak berputar' },
  start:     { judul: 'Start (mulai dari awal)', ket: 'Customer lupa tutup pintu. Perintah ke mesin: Start.', contoh: 'Contoh: customer lupa tutup pintu' },
};
/** Form alasan restart -- timer mesin direset, hitung dari awal (durasi penuh). */
function bukaRestartMesin(mode) {
  const d = PM.data; if (!d || !d.sekarang) return;
  const c = (mode === 'mesin_off' && d.mesin.tipe === 'dryer') ? PM_RESTART.mesin_off_kering : PM_RESTART[mode];
  $('pm-body').innerHTML = `<h3><i class="fas fa-rotate-right"></i> ${c.judul} · ${esc(d.mesin.kode_pendek)}</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${pmNama(d.sekarang)}<br>${c.ket}<br><b>Timer direset, durasi mulai dari awal.</b></div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan (wajib)</label>
    <textarea id="pm-alasan" placeholder="${c.contoh}" style="width:100%;min-height:70px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:'Poppins';font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-zl btn-light-zl" style="flex:1;" onclick="renderPopupMesin()">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-pm-restart" onclick="doRestartMesin('${mode}')"><i class="fas fa-rotate-right"></i> Kirim</button>
    </div>`;
}
async function doRestartMesin(mode) {
  const alasan = ($('pm-alasan') ? $('pm-alasan').value : '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-pm-restart'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi/' + PM.data.sekarang.transaksi_id + '/restart-proses', { method: 'POST', body: { alasan, mode } });
    toast(`${PM_RESTART[mode].judul} terkirim ke ${PM.data.mesin.kode_pendek}`, 'success');
    closeSheet(); DASH.data = null; loadDashboard();
  } catch (e) { toast(e.message || 'Gagal restart', 'danger'); btnLoad(btn, false); }
}
/** Resume dryer: langsung kirim Start, durasi tidak berubah (tanpa alasan). */
async function doResumeKering() {
  const d = PM.data; if (!d || !d.sekarang) return;
  const btn = $('btn-pm-resume'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi/' + d.sekarang.transaksi_id + '/resume-kering', { method: 'POST', body: {} });
    toast(`Resume terkirim ke ${d.mesin.kode_pendek}`, 'success');
    closeSheet(); DASH.data = null; loadDashboard();
  } catch (e) { toast(e.message || 'Gagal resume', 'danger'); btnLoad(btn, false); }
}

/** Perubahan #65/#66/#68: grafik transaksi per jam hari ini + garis rata-rata 4 minggu (hari yang sama). */
function grafikTrxPerJam(perJam, pemb) {
  const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const nowWib = new Date(Date.now() + 7 * 3600000);
  const total = perJam.reduce((a, r) => a + (Number(r.jumlah) || 0), 0);
  const bsa = perJam.reduce((a, r) => a + (Number(r.bayar_saat_ambil) || 0), 0);
  const namaHari = HARI[nowWib.getUTCDay()];
  const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
  return `<div class="section-label"><i class="fas fa-chart-column"></i> Transaksi per Jam</div>` + window.IK3D.grafikJam(perJam, {
    jamNow: nowWib.getUTCHours(),
    pembanding: pemb ? pemb.per_jam : null,
    labelGaris: `Rata² 4 ${namaHari} lalu`,
    kiri: `Hari ini ${total}${bsa ? ` (${bsa} bayar saat ambil)` : ''}`,
    kanan: pemb ? `Rata² 4 ${namaHari} lalu ${fmt(pemb.total_rata)}` : '',
  });
}

function renderPapanMesin(mesin) {
  const washers = mesin.filter((m) => m.tipe === 'washer');
  const dryers = mesin.filter((m) => m.tipe === 'dryer');
  if (!washers.length && !dryers.length) return '';
  let h = `<div class="section-label"><i class="fas fa-tint"></i> Status Mesin</div><div class="card-zl" style="padding:10px;">`;
  if (dryers.length) {
    h += `<div style="font-size:10px;color:var(--text-muted);font-weight:600;margin-bottom:6px;">DRYER</div>`;
    h += gridMesinKasir(dryers, 'dryer');
  }
  if (washers.length) {
    h += `<div style="font-size:10px;color:var(--text-muted);font-weight:600;margin:10px 0 6px;">WASHER</div>`;
    h += gridMesinKasir(washers, 'washer');
  }
  h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:10px;color:var(--text-muted);">
      <span><i class="fas fa-circle" style="color:var(--success);"></i> Idle</span>
      <span><i class="fas fa-circle" style="color:var(--warning);"></i> Teralokasi</span>
      <span><i class="fas fa-circle" style="color:var(--danger);"></i> Jalan</span>
      <span><i class="fas fa-circle" style="color:#94a3b8;"></i> Maintenance</span>
    </div></div>`;
  return h;
}

/* ============================================================
   PESANAN (list)
   ============================================================ */
const PESANAN = { tab: 'belum_bayar', q: '', timer: null, seq: 0 };

// Perubahan #9 (rev 15:06): 9 kartu/tab 3x3, dipakai dashboard & menu Pesanan.
// key = tab frontend; tab/sub = parameter API /transaksi.
const PESANAN_KARTU = [
  { key: 'belum_bayar',    tab: 'belum_bayar',   sub: '',       lbl: 'Belum Bayar',    icon: 'fa-clock',            bg: '#fee2e2', iconBg: '#fecaca', g3: 'g-mie', fg: '#dc2626' },
  { key: 'antre_cuci',     tab: 'antre_mesin',   sub: 'cuci',   lbl: 'Antre Cuci',     icon: 'fa-soap',             bg: '#fef3c7', iconBg: '#fde68a', g3: 'g-cuci', fg: '#92400e' },
  { key: 'antre_kering',   tab: 'antre_mesin',   sub: 'kering', lbl: 'Antre Kering',   icon: 'fa-wind',             bg: '#fef3c7', iconBg: '#fde68a', g3: 'g-kering', fg: '#92400e' },
  { key: 'alokasi_cuci',   tab: 'alokasi_mesin', sub: 'cuci',   lbl: 'Alokasi Cuci',   icon: 'fa-soap',             bg: '#fefce8', iconBg: '#fef08a', g3: 'g-sabun', fg: '#854d0e' },
  { key: 'alokasi_kering', tab: 'alokasi_mesin', sub: 'kering', lbl: 'Alokasi Kering', icon: 'fa-wind',             bg: '#fefce8', iconBg: '#fef08a', g3: 'g-teh', fg: '#854d0e' },
  { key: 'proses_mesin',   tab: 'proses_mesin',  sub: '',       lbl: 'Proses Mesin',   icon: 'fa-gear',             bg: '#ffedd5', iconBg: '#fed7aa', g3: 'g-setrika', fg: '#c2410c' },
  { key: 'drop_off',       tab: 'drop_off',      sub: '',       lbl: 'Drop-Off',       icon: 'fa-people-carry-box', bg: '#f5f3ff', iconBg: '#ddd6fe', g3: 'g-lipat', fg: '#6d28d9' },
  { key: 'lipat',          tab: 'lipat',         sub: '',       lbl: 'Lipat',          icon: 'fa-shirt',            bg: '#eff6ff', iconBg: '#bfdbfe', g3: 'g-aj', fg: '#1d4ed8' },
  { key: 'siap',           tab: 'siap',          sub: '',       lbl: 'Siap Ambil',     icon: 'fa-box-open',         bg: '#f0f9ff', iconBg: '#bae6fd', g3: 'g-antar', fg: '#0369a1' },
];
const PESANAN_KARTU_BY = PESANAN_KARTU.reduce((m, c) => { m[c.key] = c; return m; }, {});
function kartuNilai(ops, key) {
  const c = PESANAN_KARTU_BY[key]; if (!c || !ops) return 0;
  const v = ops[c.tab];
  if (v && typeof v === 'object') return Number(c.sub ? v[c.sub] : v.total) || 0;
  return Number(v) || 0;
}
function updatePesananTabCounts(ops) {
  if (!ops) return;
  document.querySelectorAll('#pesanan-tabs button').forEach((b) => {
    const c = PESANAN_KARTU_BY[b.dataset.tab]; if (!c) return;
    b.innerHTML = `<span style="display:block;font-size:10px;opacity:.85;">${c.lbl}</span><span style="display:block;font-size:20px;font-weight:900;line-height:1.1;">${kartuNilai(ops, c.key)}</span>`;
  });
}

function switchPesananTab(tab) {
  PESANAN.tab = PESANAN_KARTU_BY[tab] ? tab : 'belum_bayar';
  document.querySelectorAll('#pesanan-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === PESANAN.tab));
  loadPesanan();
}
function onPesananSearch() {
  PESANAN.q = $('pesanan-search').value;
  clearTimeout(PESANAN.timer);
  PESANAN.timer = setTimeout(loadPesanan, 400);
}

async function loadPesanan() {
  const body = $('pesanan-body'); if (!body) return;
  body.innerHTML = spinner();
  // Perubahan #7: tiap permintaan diberi nomor; jawaban yang datang telat dari
  // permintaan lama (tab/pencarian sebelumnya) diabaikan.
  const seq = ++PESANAN.seq;
  try {
    const K = PESANAN_KARTU_BY[PESANAN.tab] || PESANAN_KARTU[0];
    const qs = `?tab=${encodeURIComponent(K.tab)}${K.sub ? `&sub=${K.sub}` : ''}${PESANAN.q ? `&q=${encodeURIComponent(PESANAN.q)}` : ''}`;
    const res = await api('/transaksi' + qs);
    if (seq !== PESANAN.seq) return;
    const items = res.data || [];
    body.innerHTML = items.length ? items.map(orderCard).join('') : emptyState('Tidak ada pesanan', 'fa-box-open');
    // refresh hitungan tab dari operasional terbaru
    refreshPesananCounts();
  } catch (e) {
    if (seq !== PESANAN.seq) return;
    body.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

async function refreshPesananCounts() {
  try {
    const res = await api('/dashboard/kasir');
    const ops = (res.data && res.data.operasional) || {};
    updatePesananTabCounts(ops);
    // update juga data DASH supaya dashboard konsisten saat balik
    if (DASH) DASH.data = res.data;
  } catch (_) { /* silent */ }
}

function statusBadge(kode, statusBayar, statusNama) {
  if (statusBayar === 'belum') return `<span class="badge-zl bz-wait">Belum Bayar</span>`;
  const k = kode || '';
  let cls = 'bz-proc';
  let label = statusNama || 'Diproses';
  if (k === 'siap_diambil') { cls = 'bz-ready'; }
  else if (/^(sudah_diambil|selesai_antar)/.test(k)) { cls = 'bz-done'; }
  return `<span class="badge-zl ${cls}">${esc(label)}</span>`;
}

function custBadge(p) {
  if (!p) return '';
  if (!p.loyal || p.kunjungan <= 1) return `<span class="cust-badge cb-baru"><i class="fas fa-star"></i> BARU</span>`;
  return `<span class="cust-badge cb-lama"><i class="fas fa-user-check"></i> Kunjungan ke-${p.kunjungan} · ${p.point} poin</span>`;
}

/* ============================================================
   KARTU PESANAN 3D/neumorphic -- SAMA PERSIS dgn kartu "Pesanan Aktif" di
   role customer (lihat orderCard() di public/customer/app.js), cuma header
   kiri-atas nampilin identitas PELANGGAN (nama+WA), bukan outlet -- kasir
   yang perlu tau ini pesanan siapa, beda kebutuhan sama customer yang justru
   perlu kontak outlet. Semua data dari listForKasir() (transaksi.model.js)
   / list() (transaksi.service.js), termasuk kategori_list & mesin_*_kode
   yang barusan ditambahin biar sama persis kayak punya customer.
   ============================================================ */

// Sama persis kelompoknya dengan buildStages()/status.js di server & versi
// customer -- tiap tahap status asli dipetakan ke salah satu dari 5
// kelompok tampilan timeline.
function tkStageIndex(kode) {
  if (['alokasi_mesin_cuci', 'mulai_cuci', 'selesai_cuci'].includes(kode)) return 1;
  if (['alokasi_mesin_kering', 'mulai_kering', 'selesai_kering'].includes(kode)) return 2;
  if (['proses_setrika', 'selesai_setrika', 'proses_lipat', 'selesai_lipat'].includes(kode)) return 3;
  if (['proses_antar', 'selesai_antar', 'siap_diambil', 'sudah_diambil'].includes(kode)) return 4;
  return 0; // menunggu_bayar, sudah_bayar, proses_jemput, selesai_jemput
}

// Kelompok mana yang relevan buat transaksi ini, berdasar kategori_list
// (dari layanan jasa yang beneran dipesan) -- bukan diasumsikan tetap 5.
function tkActiveStages(kategoriList, bayarSaatAmbil = false) {
  const set = new Set(kategoriList || []);
  const delivery = set.has('antar') || set.has('antar_jemput');
  const groups = [{ idx: 0, label: bayarSaatAmbil ? 'Diterima' : 'Sudah Bayar' }];
  if (set.has('cuci')) groups.push({ idx: 1, label: 'Proses Cuci' });
  if (set.has('kering')) groups.push({ idx: 2, label: 'Proses Kering' });
  if (set.has('setrika_lipat') || set.has('lipat')) groups.push({ idx: 3, label: 'Lipat' });
  groups.push({ idx: 4, label: delivery ? 'Diantar' : 'Siap Diambil' });
  return groups;
}

// Buang kode cabang di depan kode_antrian/no_invoice ("ZL02-K-102" -> "K-102"),
// dan ringkas huruf+nol-di-depan kalau ada ("W001" -> "W1").
function tkPendekkanKode(kode) {
  if (!kode) return '';
  const parts = String(kode).split('-');
  const tail = parts.length > 1 ? parts.slice(1).join('-') : parts[0];
  const m = tail.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : tail;
}

// Pill status kanan-atas -- pakai logika sama kayak statusBadge() lama
// (belum bayar > siap/selesai > diproses), cuma dibungkus gaya tk3-pill.
function tk3StatusPill(t) {
  if (t.status_bayar === 'belum' && !t.bayar_saat_ambil) return `<span class="tk3-pill tk3-pill-new">BELUM BAYAR</span>`;
  const k = t.status_kode || '';
  let cls = 'tk3-pill-proses';
  if (k === 'siap_diambil' || /^(sudah_diambil|selesai_antar)/.test(k)) cls = 'tk3-pill-ready';
  // bayar saat ambil: tahap "sudah_bayar" ditampilkan sebagai DIPROSES (belum dibayar)
  const label = esc((t.status_bayar !== 'lunas' && k === 'sudah_bayar' ? 'Diproses' : (t.status_nama || 'Diproses')).toUpperCase());
  return `<span class="tk3-pill ${cls}">${label}</span>`;
}

// Chip kecil di bawah pill: kalau ada mesin lagi jalan, tampilin ESTIMASI
// SISA WAKTU menuju selesai (durasi_target - elapsed), samain dgn role
// customer -- bukan "udah jalan berapa lama" kayak dulu.
function tk3TimerChip(t) {
  const keringJalan = t.mesin_kering_kode && !t.mesin_kering_selesai && t.mesin_kering_mulai;
  const cuciJalan = t.mesin_cuci_kode && !t.mesin_cuci_selesai && t.mesin_cuci_mulai;
  const jalan = keringJalan
    ? { mulai: t.mesin_kering_mulai, durasiTarget: t.mesin_kering_durasi_target }
    : cuciJalan
      ? { mulai: t.mesin_cuci_mulai, durasiTarget: t.mesin_cuci_durasi_target }
      : null;
  if (jalan) {
    const mulaiDate = new Date(String(jalan.mulai).replace(' ', 'T'));
    const elapsed = isNaN(mulaiDate) ? null : Math.floor((Date.now() - mulaiDate.getTime()) / 60000);
    if (elapsed != null) {
      if (jalan.durasiTarget != null) {
        const sisa = Math.max(0, jalan.durasiTarget - elapsed);
        return `<span class="tk3-timer"><i class="fas fa-hourglass-half"></i> <b class="tk3-timer-num">${sisa}</b> menit lagi</span>`;
      }
      // Fallback kalau layanan ini gak punya durasi_target (jarang) -> tampilin elapsed kayak dulu.
      return `<span class="tk3-timer"><i class="fas fa-hourglass-half"></i> Jalan <b class="tk3-timer-num">${Math.max(0, elapsed)}</b> mnt</span>`;
    }
  }
  if (t.status_kode === 'alokasi_mesin_cuci' || t.status_kode === 'alokasi_mesin_kering') {
    return `<span class="tk3-timer tk3-timer-muted"><i class="fas fa-arrow-right"></i> Siap dimulai</span>`;
  }
  // Perubahan #14: order antre mesin cuci/kering -> mesin janji + estimasi mulai
  if (t.antre) {
    const a = t.antre;
    const mesin = a.kode_mesin_pendek ? `${esc(a.kode_mesin_pendek)} · ` : '';
    let isi;
    if (a.siap_tunggu_bongkar) isi = `${mesin}tunggu bongkar`;
    else if (a.tunggu_menit == null) isi = 'Menunggu mesin';
    else isi = `${mesin}± <b class="tk3-timer-num">${Math.max(1, a.tunggu_menit)}</b> menit${a.perkiraan ? ' <small>(perkiraan)</small>' : ''}`;
    return `<span class="tk3-timer tk3-timer-antre" title="Estimasi mulai ${a.tipe === 'kering' ? 'kering' : 'cuci'}"><i class="fas fa-hourglass-start"></i> ${isi}</span>`;
  }
  return '';
}

// Baris "Mulai <jam>" / "Selesai" di bawah kode mesin cuci/kering.
function tk3MesinSub(t, tipe) {
  const mulai = tipe === 'cuci' ? t.mesin_cuci_mulai : t.mesin_kering_mulai;
  const selesai = tipe === 'cuci' ? t.mesin_cuci_selesai : t.mesin_kering_selesai;
  if (selesai) return 'Selesai';
  if (mulai) return `Mulai ${fmtJam(mulai)}`;
  return '';
}

// Warna icon mesin di card pesanan, ngikutin status proses mesin itu (BUKAN
// jenisnya -- icon yang beda-in jenis cuci/kering, ini cuma warna). Samain
// dgn role customer (lihat mesinBadgeColor() di public/customer/app.js):
// kuning = teralokasi (ke-assign tapi belum jalan), merah = lagi jalan,
// hijau = selesai. `sub` = hasil tk3MesinSub() ('Selesai' / 'Mulai <jam>' / '').
function mesinBadgeColor(kode, sub) {
  if (!kode) return null;
  if (sub === 'Selesai') return '#16a34a'; // hijau -- selesai
  if (sub && sub.indexOf('Mulai') === 0) return '#dc2626'; // merah -- lagi jalan
  return '#d97706'; // kuning -- teralokasi, belum mulai
}

function orderCard(t) {
  const p = t.pelanggan || {};
  const groups = tkActiveStages(t.kategori_list, t.status_bayar !== 'lunas' && !!Number(t.bayar_saat_ambil));
  const curRaw = tkStageIndex(t.status_kode);
  const curPos = Math.max(0, groups.findIndex((g) => g.idx === curRaw));
  const stepsHtml = groups.map((g, i) => `<li class="${i < curPos ? 'done' : i === curPos ? 'now' : ''}">${esc(g.label)}</li>`).join('');
  // no_invoice formatnya "ZL01-YYYYMMDD-seq" -- kode cabang di depan dibuang
  // dari tampilan (sama kayak versi customer).
  const invoiceStr = String(t.no_invoice || '-');
  const dashIdx = invoiceStr.indexOf('-');
  const invNomor = dashIdx === -1 ? invoiceStr : invoiceStr.slice(dashIdx + 1);
  const cuciKode = t.mesin_cuci_kode ? esc(tkPendekkanKode(t.mesin_cuci_kode)) : '';
  const keringKode = t.mesin_kering_kode ? esc(tkPendekkanKode(t.mesin_kering_kode)) : '';
  const cuciSub = tk3MesinSub(t, 'cuci');
  const keringSub = tk3MesinSub(t, 'kering');
  // Kartu Pesanan adalah SATU-SATUNYA tempat kasir bisa ganti alokasi mesin (bukan
  // dashboard) -- tapi cuma boleh selama mesin BELUM mulai jalan, yaitu persis di
  // status "alokasi_mesin_cuci"/"alokasi_mesin_kering" (sudah dialokasikan, masih nunggu).
  const cuciSwitchable = t.status_kode === 'alokasi_mesin_cuci';
  const keringSwitchable = t.status_kode === 'alokasi_mesin_kering';
  // Warna icon mesin ikut status proses (kuning/merah/hijau, lihat mesinBadgeColor())
  // -- icon shape-nya TETAP beda per jenis mesin (fa-soap vs fa-wind di pemanggil),
  // cuma warnanya yang ngikutin status. Samain dgn role customer.
  const cuciColor = mesinBadgeColor(t.mesin_cuci_kode, cuciSub);
  const keringColor = mesinBadgeColor(t.mesin_kering_kode, keringSub);
  const cell = (icon, label, val, sub, big, onclickAttr, color) => `
        <div class="tk3-cell${onclickAttr ? ' tk3-cell-switch' : ''}"${onclickAttr ? ` onclick="${onclickAttr}"` : ''}>
          <span class="tk3-cell-ico"${color ? ` style="color:${color}"` : ''}><i class="fas ${icon}"></i></span>
          <div>
            <p class="tk3-cell-label">${label}</p>
            <p class="tk3-cell-val${big ? ' tk3-cell-mesin' : ''}${val ? '' : ' pending'}">${val || '-'}</p>
            ${sub ? `<p class="tk3-cell-sub">${esc(sub)}</p>` : ''}
          </div>
          ${onclickAttr ? '<i class="fas fa-repeat tk3-cell-swap-ico"></i>' : ''}
        </div>`;
  // Header kartu di role KASIR nampilin identitas PELANGGAN (nama + WA),
  // kebalikan dari role customer yang nampilin identitas OUTLET -- kasir
  // yang perlu tau ini pesanan siapa buat manggil/hubungin.
  const nama = p.nama || 'Pelanggan';
  const telepon = p.telepon || '';
  const waHref = telepon ? `https://wa.me/62${telepon.replace(/\D/g, '').replace(/^0/, '')}` : '';

  return `
    <article class="tk3-card" onclick="openOrderDetail(${t.id})">
      <header class="tk3-head">
        <div class="tk3-who"${waHref ? ` style="cursor:pointer;" onclick="event.stopPropagation();window.open('${waHref}','_blank')"` : ''}>
          <span class="tk3-avatar"><i class="fas fa-user"></i></span>
          <div>
            <h3 class="tk3-who-name">${esc(nama)}</h3>
            ${telepon ? `<a class="tk3-wa" href="${waHref}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i> ${esc(telepon)}</a>` : ''}
          </div>
        </div>
        <div class="tk3-status">
          ${t.ditahan ? `<span class="tk3-hold" title="${esc(t.ditahan_alasan || '')}"><i class="fas fa-hand"></i> DITAHAN</span>` : ''}
          ${tk3StatusPill(t)}
          ${tk3TimerChip(t)}
        </div>
      </header>
      <p class="tk3-layanan"><i class="fas fa-shirt"></i> ${esc(t.layanan_label || '-')}${t.berat_kg ? ` · ${esc(t.berat_kg)} kg` : ''}</p>
      <div style="margin:-4px 0 10px;${p.id ? 'cursor:pointer;' : ''}"${p.id ? ` onclick="event.stopPropagation();openKasirCustDetail(${p.id},'${esc(nama).replace(/'/g, "\\'")}')"` : ''}>${custBadge(p)}</div>
      <div class="tk3-divider"></div>
      <div class="tk3-grid">
        ${cell('fa-receipt', 'Invoice', esc(invNomor), fmtDate(t.tanggal))}
        ${cell('fa-soap', 'Mesin Cuci', cuciKode, cuciSub, true, cuciSwitchable ? `event.stopPropagation();openGantiMesinSheet(${t.id},'cuci','washer','${esc(t.mesin_cuci_kode || '')}')` : null, cuciColor)}
        ${cell('fa-wind', 'Mesin Kering', keringKode, keringSub, true, keringSwitchable ? `event.stopPropagation();openGantiMesinSheet(${t.id},'kering','dryer','${esc(t.mesin_kering_kode || '')}')` : null, keringColor)}
        ${cell('fa-basket-shopping', 'Keranjang', t.kode_antrian ? esc(tkPendekkanKode(t.kode_antrian)) : '', '', true)}
      </div>
      <ol class="tk3-steps" style="grid-template-columns:repeat(${groups.length},1fr);">${stepsHtml}</ol>
      <div class="tk3-divider"></div>
      <footer class="tk3-foot">
        <div class="tk3-total">
          <span>Total</span><strong>${rupiah(t.total)}</strong>
          ${t.status_bayar !== 'lunas' && t.bayar_saat_ambil
            ? `<em class="tk3-pay bsa"><i class="fas fa-hand-holding-dollar"></i> BAYAR SAAT AMBIL</em>`
            : `<em class="tk3-pay ${t.status_bayar === 'lunas' ? '' : 'unpaid'}"><i class="fas ${t.status_bayar === 'lunas' ? 'fa-circle-check' : 'fa-clock'}"></i> ${t.status_bayar === 'lunas' ? esc(labelMetode(t.metode_bayar).toUpperCase()) + ' · LUNAS' : 'BELUM BAYAR' + (t.metode_bayar === 'kiosk' ? ' · KIOS-K' : '')}</em>`}
        </div>
        ${['sudah_diambil', 'selesai_antar'].includes(t.status_kode) ? '' : `<button class="pm-btn3d pm-ubah tk3-ubah" title="Ubah pesanan" onclick="event.stopPropagation();bukaUbahPesanan(${t.id},'pesanan')"><i class="fas fa-pen-to-square"></i> Ubah</button>`}
        <span class="tk3-hint">Detail <i class="fas fa-chevron-right" style="font-size:.7em;"></i></span>
      </footer>
    </article>`;
}

/* ---- GANTI ALOKASI MESIN (dari kartu Pesanan) ----
   Wewenang kasir buat mengubah alokasi antrian mesin ADA DI SINI SAJA (bukan
   di Dashboard). Muncul cuma di icon Mesin Cuci/Kering pada kartu pesanan,
   cuma aktif selama mesin itu BELUM mulai jalan (status alokasi_mesin_*).
   Pilihan mesin tujuan = mesin KOSONG atau yang MASIH DIBOOKING order lain
   (belum jalan) -- kalau target lagi dibooking order lain, backend otomatis
   TUKAR (swap), order lain itu kebagian mesin lama kita, bukan dilepas jadi
   tanpa mesin. Mesin yang SEDANG JALAN tidak pernah ditawarkan. */
let GM = { id: null, tipe: null, mesinTipe: null, pick: null };
async function openGantiMesinSheet(id, tipe, mesinTipe, kodeSaatIni) {
  GM = { id, tipe, mesinTipe, pick: null };
  openSheet(`<h3>Ganti Mesin ${tipe === 'cuci' ? 'Cuci' : 'Pengering'}</h3>
    <p style="font-size:12px;color:var(--tk3-ink-soft,var(--text-muted));margin:-6px 0 10px;">Mesin sekarang: <b>${esc(kodeSaatIni || '-')}</b>. Pilih mesin tujuan -- boleh yang kosong atau yang masih dibooking order lain (nanti ditukar otomatis), bukan yang sedang jalan.</p>
    <div id="gm-mesin-list">${spinner()}</div>`);
  try {
    const res = await api('/master/mesin?tipe=' + encodeURIComponent(mesinTipe));
    const semua = res.data || [];
    // pilihan: idle ATAU direservasi order lain (status mesin masih 'aktif' di kedua
    // kasus, cuma beda flag direservasi) -- BUKAN yang sedang jalan/maintenance/nonaktif,
    // dan bukan mesin yang sekarang sudah dipakai order ini sendiri.
    const list = semua.filter((m) => m.status === 'aktif' && (m.kode_mesin || '') !== kodeSaatIni);
    if (!list.length) { $('gm-mesin-list').innerHTML = emptyState('Tidak ada mesin lain yang bisa dipilih saat ini', 'fa-gear'); return; }
    $('gm-mesin-list').innerHTML = `
      <div class="mesin-pick">${list.map((m) => `
        <div class="mesin-opt" data-id="${m.id}" onclick="pickGantiMesin(${m.id})">
          <div class="mo-kode">${esc((m.kode_mesin || '').split('-').pop() || m.kode_mesin)}</div>
          <div class="mo-cap">${m.kapasitas_kg || '-'} kg</div>
          <div class="mo-flag${m.direservasi ? '' : ' mo-flag-idle'}">${m.direservasi ? 'Dibooking order lain' : 'Kosong'}</div>
        </div>`).join('')}</div>
      <button class="btn-zl btn-primary-zl" id="btn-gm-mesin" onclick="doGantiMesin()" disabled style="margin-top:16px;">Ganti Alokasi</button>`;
  } catch (e) { $('gm-mesin-list').innerHTML = emptyState('Gagal memuat mesin. ' + e.message, 'fa-triangle-exclamation'); }
}
function pickGantiMesin(id) {
  GM.pick = id;
  document.querySelectorAll('#gm-mesin-list .mesin-opt').forEach((o) => o.classList.toggle('selected', Number(o.dataset.id) === id));
  $('btn-gm-mesin').disabled = false;
}
async function doGantiMesin() {
  if (!GM.pick) { toast('Pilih mesin dulu', 'warning'); return; }
  const btn = $('btn-gm-mesin'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi/' + GM.id + '/ganti-mesin', { method: 'POST', body: { tipe: GM.tipe, mesin_id: GM.pick } });
    closeSheet();
    toast((res.data && res.data.swapped) ? 'Mesin ditukar dengan order lain' : 'Alokasi mesin diganti', 'success');
    loadPesanan();
  } catch (e) { toast(e.message || 'Gagal ganti mesin', 'danger'); btnLoad(btn, false); }
}

/* ============================================================
   DETAIL PESANAN + AKSI
   ============================================================ */
let OD = { id: null, data: null };

async function openOrderDetail(id) {
  OD.id = id; OD.data = null;
  // pindah ke page detail
  document.querySelectorAll('.app-page').forEach((p) => p.classList.remove('active'));
  $('page-order-detail').classList.add('active');
  document.querySelectorAll('#footer-nav a').forEach((a) => a.classList.remove('active'));
  window.scrollTo(0, 0);
  $('order-detail-body').innerHTML = spinner();
  $('od-sub').textContent = '-';
  try {
    const res = await api('/transaksi/' + id);
    OD.data = res.data;
    // PENTING (fix bug poin tidak kepotong): kalau transaksi ini SUDAH pernah
    // di-reserve-poin sebelumnya (poin_dipakai tersimpan di DB) tapi BELUM
    // lunas, pulihkan _poinDipakai dari data server -- jangan andalkan state
    // sementara di memory browser doang (bisa ilang kalau kasir buka order
    // ini di sesi lain / refresh / order dari customer app yang direservasi
    // lalu baru dibayar belakangan oleh kasir).
    OD._poinDipakai = (res.data.status_bayar !== 'lunas' && Number(res.data.poin_dipakai) > 0)
      ? Number(res.data.poin_dipakai) : 0;
    renderOrderDetail(res.data);
  } catch (e) {
    $('order-detail-body').innerHTML = emptyState('Gagal memuat detail. ' + e.message, 'fa-triangle-exclamation');
  }
}

/* ============================================================
   DETAIL PELANGGAN (dari kartu Pesanan -> klik badge kunjungan)
   Lihat SEMUA riwayat transaksi pelanggan sejak awal + edit data,
   sama kayak menu Customer di role manager -- cuma dipanggil dari
   sheet, bukan halaman terpisah, biar kasir gak perlu pindah menu.
   ============================================================ */
const KCUST = { data: null };

async function openKasirCustDetail(id, nama) {
  openSheet(`<h3><i class="fas fa-user"></i> ${esc(nama || 'Pelanggan')}</h3><div id="kasir-cust-detail">${spinner()}</div>`);
  try {
    const res = await api(`/pelanggan/${id}/riwayat`);
    KCUST.data = res.data;
    renderKasirCustDetail(res.data);
  } catch (e) {
    $('kasir-cust-detail').innerHTML = emptyState('Gagal memuat riwayat. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderKasirCustDetail(d) {
  const p = d.pelanggan;
  const waHref = p.telepon ? `https://wa.me/62${String(p.telepon).replace(/\D/g, '').replace(/^0/, '')}` : '';
  let html = `
    <div class="card-zl" style="margin-bottom:10px;">
      <div style="font-size:12px;color:var(--tk3-ink-soft, var(--text-muted));">${esc(p.telepon || '-')}</div>
      <div style="display:flex;gap:14px;margin-top:6px;font-size:12px;">
        <span><b>${p.kunjungan}</b> kunjungan</span>
        <span><b>${p.point}</b> poin</span>
      </div>
      ${p.alamat ? `<div style="font-size:12px;color:var(--tk3-ink-soft, var(--text-muted));margin-top:6px;"><i class="fas fa-location-dot"></i> ${esc(p.alamat)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;">
        ${waHref ? `<a class="btn-zl btn-success-zl" style="flex:1;" href="${waHref}" target="_blank" rel="noopener noreferrer"><i class="fab fa-whatsapp"></i> WA</a>` : ''}
        <button class="btn-zl btn-light-zl" style="flex:1;" onclick="openKasirEditCust(${p.id})"><i class="fas fa-pen"></i> Edit data</button>
      </div>
    </div>`;
  html += `<div class="section-label"><i class="fas fa-clock-rotate-left"></i> Riwayat transaksi</div>`;
  const trx = d.transaksi || [];
  if (!trx.length) {
    html += emptyState('Belum ada transaksi', 'fa-inbox');
  } else {
    html += `<div class="card-zl">` + trx.map((t) => `
      <div class="proc-row" style="cursor:pointer;" onclick="closeSheet();openOrderDetail(${t.id})">
        <div style="flex:1;"><div style="font-size:13px;font-weight:700;">${esc(t.no_invoice)}</div>
          <div style="font-size:10px;color:var(--tk3-ink-soft, var(--text-muted));">${esc(String(t.tanggal || '').slice(0, 16).replace('T', ' '))} · ${esc(t.status_nama || t.status_kode || '-')}</div></div>
        <div style="font-weight:700;">${rupiah(t.total)}</div>
        <i class="fas fa-chevron-right" style="color:var(--slate-light);margin-left:8px;"></i>
      </div>`).join('') + `</div>`;
  }
  $('kasir-cust-detail').innerHTML = html;
}

function openKasirEditCust(id) {
  const p = KCUST.data && KCUST.data.pelanggan;
  openSheet(`
    <h3><i class="fas fa-pen"></i> Edit Pelanggan</h3>
    <div class="field"><label>Nama</label><input type="text" id="kcust-nama" value="${esc(p ? p.nama : '')}"></div>
    <div class="field"><label>Telepon</label><input type="text" id="kcust-telepon" value="${esc(p ? p.telepon : '')}" inputmode="numeric"></div>
    <div class="field"><label>Alamat</label><input type="text" id="kcust-alamat" value="${esc(p && p.alamat ? p.alamat : '')}" placeholder="opsional"></div>
    <button class="btn-zl btn-primary-zl" id="btn-kcust-simpan" onclick="doKasirEditCust(${id})"><i class="fas fa-check"></i> Simpan</button>`);
}

async function doKasirEditCust(id) {
  const nama = $('kcust-nama').value.trim();
  const telepon = $('kcust-telepon').value.trim();
  const alamat = $('kcust-alamat').value.trim();
  if (!nama || !telepon) { toast('Nama & telepon wajib diisi', 'warning'); return; }
  const btn = $('btn-kcust-simpan'); btnLoad(btn, true);
  try {
    await api(`/pelanggan/${id}`, { method: 'PATCH', body: { nama, telepon, alamat } });
    toast('Data pelanggan diperbarui', 'success');
    // balik ke sheet riwayat (data ke-refresh) + refresh list Pesanan biar
    // nama/poin yang ditampilkan di kartu ikut update.
    await openKasirCustDetail(id, nama);
    if (typeof loadPesanan === 'function') loadPesanan().catch(() => {});
  } catch (e) { toast(e.message || 'Gagal simpan', 'danger'); btnLoad(btn, false); }
}

function tlTime(w) {
  if (!w) return '';
  return new Date(String(w).replace(' ', 'T')).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderOrderDetail(d) {
  $('od-sub').textContent = d.no_invoice || '-';
  const p = d.pelanggan || {};
  const items = d.items || [];
  const riwayat = d.riwayat || [];
  const na = d.next_action || {};

  let html = '';

  // status + bayar
  const statusKode = d.status_kode || (riwayat.length ? riwayat[riwayat.length - 1].kode : '');
  html += `<div class="card-zl" style="text-align:center;">
      <div style="font-size:12px;color:var(--text-muted);">Status saat ini</div>
      <div style="margin-top:8px;">${statusBadge(statusKode, Number(d.bayar_saat_ambil) ? 'lunas' : d.status_bayar, Number(d.bayar_saat_ambil) && statusKode === 'sudah_bayar' && d.status_bayar !== 'lunas' ? 'Diproses' : d.status_nama)}</div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted);">
        ${d.status_bayar === 'lunas' ? '<i class="fas fa-circle-check" style="color:var(--success);"></i> Sudah dibayar' : Number(d.bayar_saat_ambil) ? '<span class="bsa-tag"><i class="fas fa-hand-holding-dollar"></i> Bayar saat ambil · tagih ' + rupiah(d.total) + '</span>' : '<i class="fas fa-clock" style="color:var(--warning);"></i> Belum dibayar'}
        · ${esc(labelMetode(d.metode_bayar).toUpperCase())}
      </div>
      ${Number(d.bayar_saat_ambil) && d.status_bayar !== 'lunas' ? `
      <button class="btn-zl btn-success-zl" style="margin-top:10px;" onclick="openBayarSheet()"><i class="fas fa-money-bill-wave"></i> Terima Pembayaran Sekarang</button>
      <div style="font-size:10.5px;color:var(--text-muted);margin-top:5px;">Pelanggan boleh bayar kapan saja selama proses. Tahap proses tidak berubah.</div>` : ''}
    </div>`;

  // pelanggan
  html += `<div class="section-label"><i class="fas fa-user"></i> Pelanggan</div>
    <div class="card-zl">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:700;">${esc(p.nama || '-')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${esc(p.telepon || '-')}</div>
          ${p.alamat ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;"><i class="fas fa-location-dot"></i> ${esc(p.alamat)}</div>` : ''}
          <div style="margin-top:8px;">${custBadge(p)}</div>
        </div>
        <button onclick="openGantiPelangganSheet()" style="border:none;background:var(--bg-soft);color:var(--primary);font-size:11px;padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;">
          <i class="fas fa-pen"></i> Ganti
        </button>
      </div>
    </div>`;

  // tombol cetak struk (di atas Rincian biar tidak ketutup action bar)
  html += `<div style="display:flex;gap:8px;margin-bottom:14px;">
    <button class="btn-zl btn-light-zl" onclick="cetakStruk(false)" style="flex:1;font-size:12px;"><i class="fas fa-receipt"></i> Nota</button>
    <button class="btn-zl btn-light-zl" onclick="cetakStruk(true)" style="flex:1;font-size:12px;"><i class="fas fa-timeline"></i> Nota + Timeline</button>
  </div>`;
  // tombol batal pesan: hanya kalau belum bayar
  // bayar saat ambil: batal hanya selama belum mulai dikerjakan (masih antre/teralokasi)
  const bsaBolehBatal = !Number(d.bayar_saat_ambil)
    || (['sudah_bayar', 'alokasi_mesin_cuci', 'alokasi_mesin_kering'].includes(statusKode) && !(d.mesin_pakai || []).length);
  if (d.status_bayar !== 'lunas' && bsaBolehBatal) {
    html += `<button class="btn-zl btn-danger-zl" onclick="batalPesan()" style="margin-bottom:14px;"><i class="fas fa-trash-can"></i> Batal Pesan</button>`;
  }
  // Perubahan #49: info hold untuk semua; tombol tahan / lepas hanya owner
  if (Number(d.ditahan)) {
    html += `<div class="card-zl od-hold"><b><i class="fas fa-hand"></i> Pesanan DITAHAN owner</b><div>Tidak ikut antrian mesin${d.ditahan_alasan ? ` · ${esc(d.ditahan_alasan)}` : ''}</div></div>`;
  }
  if (S.user && S.user.role === 'owner') {
    const bolehTahan = (d.status_bayar === 'lunas' || Number(d.bayar_saat_ambil))
      && ['sudah_bayar', 'selesai_jemput', 'alokasi_mesin_cuci', 'selesai_cuci', 'alokasi_mesin_kering'].includes(statusKode)
      && !(d.mesin_pakai || []).some((m) => !m.selesai);
    html += `<div class="od-owner"><div class="od-owner-h"><i class="fas fa-crown"></i> Wewenang owner</div><div style="display:flex;gap:8px;">
      ${Number(d.ditahan) ? `<button class="btn-zl btn-light-zl" onclick="ownerTahan(false)"><i class="fas fa-play"></i> Lepas hold</button>`
        : bolehTahan ? `<button class="btn-zl btn-light-zl" onclick="ownerTahanForm()"><i class="fas fa-hand"></i> Tahan (hold)</button>` : ''}
      <button class="btn-zl btn-danger-zl" onclick="ownerHapusForm()"><i class="fas fa-trash-can"></i> Hapus transaksi</button></div></div>`;
  }

  // item & total
  html += `<div class="section-label"><i class="fas fa-list-ul"></i> Rincian</div><div class="card-zl">`;
  items.forEach((it) => {
    html += `<div class="item-line"><span>${esc(it.nama_item)} ${it.qty > 1 ? `×${it.qty}` : ''}</span><span>${rupiah(it.subtotal)}</span></div>`;
  });
  if (d.berat_kg) html += `<div class="drow"><span class="dl">Berat</span><span class="dv">${d.berat_kg} kg</span></div>`;
  // `diskon` sekarang murni tukar poin lagi (promo cuci gratis sudah tercermin
  // langsung dari harga item "Cuci"-nya sendiri, bukan lewat kolom diskon).
  if (Number(d.diskon) > 0) {
    html += `<div class="drow"><span class="dl">Subtotal</span><span class="dv">${rupiah(d.subtotal)}</span></div>`;
    html += `<div class="drow" style="color:#16a34a;"><span class="dl">⭐ Tukar ${Number(d.poin_dipakai) || Math.round(Number(d.diskon) / 10)} poin</span><span class="dv">- ${rupiah(d.diskon)}</span></div>`;
  }
  html += `<div class="drow" style="border-top:1px solid var(--border);margin-top:4px;"><span class="dl" style="font-weight:700;">Total</span><span class="dv" style="font-size:16px;color:var(--primary);">${rupiah(d.total)}</span></div>`;
  if (d.kode_antrian) html += `<div class="drow"><span class="dl">Keranjang</span><span class="dv"><i class="fas fa-basket-shopping"></i> ${esc(d.kode_antrian)}</span></div>`;
  // Perubahan #8: ubah pesanan (layanan + barang) dari menu Pesanan
  if (!['sudah_diambil', 'selesai_antar'].includes(statusKode)) {
    html += `<button class="btn-zl btn-light-zl" style="margin-top:12px;" onclick="bukaUbahPesanan(${d.id},'pesanan')"><i class="fas fa-pen-to-square"></i> Ubah Pesanan</button>`;
  }
  html += `</div>`;

  // Posisi cucian manual: cuma relevan buat order yang pernah lewat
  // mesin (cuci/kering) DAN gak ada tahap lipat/setrika (lipat/setrika
  // otomatis udah pasti keluar dari mesin & masuk keranjang -- lihat
  // adaLipat di whatsapp.service.js, gak butuh toggle manual). Sengaja
  // gak muncul kalau belum lunas / udah diambil-antar (gak relevan lagi).
  //
  // PENTING: baru relevan begitu proses mesin TERAKHIR order ini udah
  // selesai (bukan dari awal lunas) -- selama mesin masih jalan, posisinya
  // udah pasti "di mesin", gak ada yang perlu ditandai. Order kering
  // (cuci+kering ATAU kering aja) -> patokan "selesai_kering"; order cuci
  // aja (gak ada kering) -> patokan "selesai_cuci". Urutan status ngikutin
  // src/constants/status.js (urutan) biar konsisten sama backend.
  const STATUS_URUTAN = [
    'menunggu_bayar', 'sudah_bayar', 'proses_jemput', 'selesai_jemput',
    'alokasi_mesin_cuci', 'mulai_cuci', 'selesai_cuci',
    'alokasi_mesin_kering', 'mulai_kering', 'selesai_kering',
    'proses_setrika', 'selesai_setrika', 'proses_lipat', 'selesai_lipat',
    'proses_antar', 'selesai_antar', 'siap_diambil', 'sudah_diambil',
  ];
  const adaKategoriMesin = items.some((it) => it.layanan_kategori === 'cuci' || it.layanan_kategori === 'kering');
  const adaKeringItem = items.some((it) => it.layanan_kategori === 'kering');
  const adaLipatItem = items.some((it) => it.layanan_kategori === 'lipat' || it.layanan_kategori === 'setrika_lipat');
  const patokanMesinSelesai = adaKeringItem ? 'selesai_kering' : 'selesai_cuci';
  const sudahLewatiMesinTerakhir = STATUS_URUTAN.indexOf(statusKode) >= STATUS_URUTAN.indexOf(patokanMesinSelesai);
  const posisiRelevan = d.status_bayar === 'lunas' && adaKategoriMesin && !adaLipatItem && sudahLewatiMesinTerakhir
    && !['menunggu_bayar', 'sudah_diambil', 'selesai_antar'].includes(statusKode);
  if (posisiRelevan) {
    const posisi = d.posisi_cucian_manual || 'mesin';
    html += `<div class="section-label"><i class="fas fa-box-open"></i> Posisi Cucian</div>
      <div class="card-zl">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
          Tandai kalau cucian sudah dikeluarkan manual dari mesin & dipindah ke keranjang (mis. pelanggan belum juga ambil & mesin perlu dikosongin). Ini menentukan lokasi yang disebut di notif WA ke pelanggan.
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-zl ${posisi === 'keranjang' ? 'btn-light-zl' : 'btn-primary-zl'}" style="flex:1;font-size:12px;" onclick="setPosisiCucian('mesin')"><i class="fas fa-gear"></i> Masih di Mesin</button>
          <button class="btn-zl ${posisi === 'keranjang' ? 'btn-primary-zl' : 'btn-light-zl'}" style="flex:1;font-size:12px;" onclick="setPosisiCucian('keranjang')"><i class="fas fa-basket-shopping"></i> Sudah di Keranjang</button>
        </div>
      </div>`;
  }

  // pemakaian mesin (W/D yang pernah dipakai)
  const mp = d.mesin_pakai || [];
  if (mp.length) {
    html += `<div class="section-label"><i class="fas fa-gear"></i> Pemakaian Mesin</div><div class="card-zl">`;
    mp.forEach((m) => {
      const tipeLbl = m.tipe === 'washer' ? 'Cuci' : (m.tipe === 'dryer' ? 'Kering' : m.tipe);
      const stat = m.selesai
        ? `<span style="color:var(--text-muted);"><i class="fas fa-circle-check"></i> selesai</span>`
        : `<span style="color:var(--success);"><i class="fas fa-gear fa-spin"></i> jalan</span>`;
      html += `<div class="drow">
          <span class="dl"><b>${esc(m.kode_mesin)}</b> · ${esc(tipeLbl)}${m.kapasitas_kg ? ` · ${m.kapasitas_kg}kg` : ''}</span>
          <span class="dv">${stat} ${m.durasi_menit != null ? `· ${fmtDurasi(m.durasi_menit)}` : ''}</span>
        </div>`;
    });
    html += `</div>`;
  }

  // timeline riwayat
  html += `<div class="section-label"><i class="fas fa-timeline"></i> Riwayat Status</div><div class="card-zl">`;
  if (riwayat.length) {
    html += `<div class="timeline">`;
    riwayat.forEach((r, i) => {
      const isLast = i === riwayat.length - 1;
      const mesinInfo = r.kode_mesin
        ? `<div class="tl-time" style="color:var(--primary);font-weight:600;"><i class="fas fa-${r.mesin_tipe === 'dryer' ? 'wind' : 'soap'}"></i> ${esc(r.kode_mesin)}</div>`
        : '';
      html += `<div class="tl-step ${isLast ? 'current' : 'done'}">
          <div class="tl-dot"></div>
          <div class="tl-label">${esc(r.nama || r.kode)}</div>
          ${mesinInfo}
          <div class="tl-time">${esc(tlTime(r.waktu))}</div>
        </div>`;
    });
    html += `</div>`;
  } else {
    html += `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px;">Belum ada riwayat status</div>`;
  }
  html += `</div><div style="height:8px;"></div>`;

  // tombol print/PDF (laporan ke customer)
  $('order-detail-body').innerHTML = html;

  // action bar (tombol aksi berikutnya)
  renderActionBar(na);
}

function strukWaktu(w) {
  if (!w) return '-';
  const s = String(w);
  const tgl = s.slice(8, 10) + '/' + s.slice(5, 7);
  const jam = s.slice(11, 16);
  return `${tgl} ${jam}`;
}

/* Update posisi cucian manual (mesin/keranjang) -- lihat kartu "Posisi
   Cucian" di renderOrderDetail(). Ini CUMA pilihan/penanda yang menentukan
   lokasi yang DISEBUT di isi pesan WA nanti (dipakai backend pas nyusun
   teks notifikasi) -- BUKAN tombol yang langsung buka/kirim WA. Jadi di
   sini cuma update state + toast konfirmasi, TANPA munculin sheet "Kirim
   WhatsApp" (itu cuma muncul dari aksi pindah status beneran, lihat
   handleWaAfter() dipanggil di tempat lain). */
async function setPosisiCucian(posisi) {
  if (!OD.id) return;
  try {
    const res = await api(`/transaksi/${OD.id}/posisi-manual`, { method: 'POST', body: { posisi } });
    OD.data = res.data;
    renderOrderDetail(res.data);
    toast(posisi === 'keranjang' ? 'Ditandai: sudah di keranjang' : 'Ditandai: masih di mesin', 'success');
  } catch (e) { toast(e.message || 'Gagal update posisi', 'danger'); }
}

/* ---------- Perubahan #48 / #49: wewenang owner ---------- */
function ownerHapusForm() {
  const d = OD.data; if (!d) return;
  const setor = d.status_bayar === 'lunas' && d.status_setor && d.status_setor !== 'belum_setor';
  openSheet(`<h3><i class="fas fa-triangle-exclamation" style="color:var(--danger);"></i> Hapus transaksi ${esc(d.no_invoice || '')}?</h3>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">
      Transaksi dihapus permanen (jejaknya disimpan di log owner). ${d.status_bayar === 'lunas'
        ? (setor ? `Sudah <b>disetor</b>: Kas Besar otomatis dikoreksi −${rupiah(d.total)} hari ini.` : `Pendapatan ${rupiah(d.total)} di Kas Kecil dicabut, poin pelanggan & stok barang dikembalikan.`)
        : 'Belum dibayar.'} Tidak bisa dibatalkan.</div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan (wajib)</label>
    <textarea id="oh-alasan" placeholder="Contoh: customer dobel input, order asli ZL02-…" style="width:100%;min-height:64px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:inherit;font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;"><button class="btn-zl btn-light-zl" style="flex:1;" onclick="closeSheet()">Batal</button>
      <button class="btn-zl btn-danger-zl" style="flex:1;" id="btn-oh" onclick="ownerHapus()"><i class="fas fa-trash-can"></i> Hapus</button></div>`);
}
async function ownerHapus() {
  const alasan = ($('oh-alasan').value || '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-oh'); btnLoad(btn, true);
  try {
    const r = (await api(`/transaksi/${OD.id}/hapus-owner`, { method: 'POST', body: { alasan } })).data;
    closeSheet(); toast(`Transaksi ${r.no_invoice} dihapus${r.sudah_setor ? ` · Kas Besar dikoreksi −${rupiah(r.koreksi_kas_besar)}` : ''}`, 'success', 5000);
    DASH.data = null; navTo('pesanan');
  } catch (e) { toast(e.message || 'Gagal menghapus', 'danger'); btnLoad(btn, false); }
}
function ownerTahanForm() {
  openSheet(`<h3><i class="fas fa-hand"></i> Tahan pesanan (hold)</h3>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">Pesanan keluar dari antrian mesin. Kalau sedang teralokasi, mesinnya langsung diberikan ke antrian berikutnya. Saat hold dilepas, pesanan masuk lagi di antrian paling belakang.</div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan (wajib)</label>
    <textarea id="oh-alasan" placeholder="Contoh: sudah bayar tapi belum datang" style="width:100%;min-height:64px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:inherit;font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;"><button class="btn-zl btn-light-zl" style="flex:1;" onclick="closeSheet()">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-oh" onclick="ownerTahan(true)"><i class="fas fa-hand"></i> Tahan</button></div>`);
}
async function ownerTahan(tahan) {
  const alasan = tahan ? (($('oh-alasan') || {}).value || '').trim() : '';
  if (tahan && !alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-oh'); if (btn) btnLoad(btn, true);
  try {
    await api(`/transaksi/${OD.id}/tahan`, { method: 'POST', body: { tahan, alasan } });
    closeSheet(); toast(tahan ? 'Pesanan ditahan, keluar dari antrian' : 'Hold dilepas, masuk antrian paling belakang', 'success');
    DASH.data = null; openOrderDetail(OD.id);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); if (btn) btnLoad(btn, false); }
}

function batalPesan() {
  const d = OD.data;
  if (!d) return;
  openSheet(`
    <h3><i class="fas fa-triangle-exclamation" style="color:var(--danger);"></i> Batal Pesan?</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      Pesanan <b>${esc(d.no_invoice || '')}</b> akan <b>dihapus permanen</b> dan keranjang dibebaskan. Tindakan ini tidak bisa dibatalkan.
    </p>
    <button class="btn-zl btn-danger-zl" id="btn-batal-ya" onclick="doBatalPesan()"><i class="fas fa-trash-can"></i> Ya, Batalkan</button>
    <button class="btn-zl btn-light-zl" onclick="closeSheet()" style="margin-top:10px;">Tidak</button>`);
}

async function doBatalPesan() {
  const btn = $('btn-batal-ya'); btnLoad(btn, true);
  try {
    await api('/transaksi/' + OD.id, { method: 'DELETE' });
    closeSheet(); toast('Pesanan dibatalkan', 'success');
    // kembali ke daftar pesanan
    if (typeof navTo === 'function') navTo('pesanan');
    else if (typeof goPesanan === 'function') goPesanan('belum_bayar');
  } catch (e) { toast(e.message || 'Gagal membatalkan', 'danger'); btnLoad(btn, false); }
}

function openGantiPelangganSheet() {
  const d = OD.data;
  if (!d) return;
  const p = d.pelanggan || {};
  const poinNote = d.status_bayar === 'lunas'
    ? '<div style="font-size:11px;color:var(--warning);background:#fef3c7;padding:8px 10px;border-radius:8px;margin-bottom:12px;"><i class="fas fa-circle-info"></i> Transaksi sudah lunas. Poin yang sudah ditambahkan ke <b>' + esc(p.nama || '') + '</b> akan dipindah ke pelanggan baru.</div>'
    : '';
  GP.selected = null;
  openSheet(`
    <h3><i class="fas fa-user-pen"></i> Ganti Pelanggan</h3>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Pelanggan saat ini: <b>${esc(p.nama || '-')}</b> (${esc(p.telepon || '-')})</p>
    ${poinNote}
    <div class="search-zl"><i class="fas fa-magnifying-glass"></i>
      <input type="text" id="gp-search" placeholder="Cari nama / nomor HP pelanggan" oninput="onGpSearch()" autocomplete="off">
    </div>
    <div id="gp-search-result"></div>
    <div id="gp-selected"></div>`);
}

const GP = { selected: null, searchTimer: null };

function onGpSearch() {
  const q = $('gp-search').value.trim();
  clearTimeout(GP.searchTimer);
  $('gp-selected').innerHTML = '';
  GP.selected = null;
  if (q.length < 2) { $('gp-search-result').innerHTML = ''; return; }
  GP.searchTimer = setTimeout(async () => {
    try {
      const res = await api('/pelanggan/search?q=' + encodeURIComponent(q));
      const list = res.data || [];
      $('gp-search-result').innerHTML = list.length
        ? list.map((p) => `
            <div class="cust-result" onclick='gpPilihPelanggan(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
              <div><div class="cr-nama">${esc(p.nama)}</div><div class="cr-hp">${esc(p.telepon)} · ${p.kunjungan}x · ${p.point} poin</div></div>
              <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
            </div>`).join('')
        : '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px;">Tidak ditemukan.</div>';
    } catch (e) { $('gp-search-result').innerHTML = ''; }
  }, 350);
}

function gpPilihPelanggan(p) {
  GP.selected = p;
  $('gp-search-result').innerHTML = '';
  $('gp-search').value = '';
  $('gp-selected').innerHTML = `
    <div class="card-zl" style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:13px;font-weight:700;">${esc(p.nama)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${esc(p.telepon)} · ${p.kunjungan}x · ${p.point} poin</div>
      </div>
      <i class="fas fa-circle-check" style="color:var(--success);font-size:18px;"></i>
    </div>
    <button class="btn-zl btn-primary-zl" id="btn-gp-simpan" onclick="doGantiPelanggan()" style="margin-top:14px;"><i class="fas fa-check"></i> Simpan</button>`;
}

async function doGantiPelanggan() {
  if (!GP.selected) { toast('Pilih pelanggan dulu', 'warning'); return; }
  const btn = $('btn-gp-simpan'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi/' + OD.id + '/ganti-pelanggan', {
      method: 'POST',
      body: { pelanggan: { telepon: GP.selected.telepon, nama: GP.selected.nama, alamat: GP.selected.alamat || undefined } },
    });
    closeSheet();
    const poinMsg = res.data.poin_dipindah > 0 ? ` (${res.data.poin_dipindah} poin dipindah)` : '';
    toast('Pelanggan diganti ke ' + res.data.pelanggan.nama + poinMsg, 'success');
    await openOrderDetail(OD.id);
  } catch (e) {
    toast(e.message || 'Gagal ganti pelanggan', 'danger');
    btnLoad(btn, false);
  }
}

function cetakStruk(withTimeline) {
  const d = OD.data;
  if (!d) { toast('Data belum siap', 'warning'); return; }
  const p = d.pelanggan || {};
  const items = d.items || [];
  const cab = d.cabang || {};
  const outlet = cab.nama || (S.user && S.user.cabang_nama) || 'Bilas Moro Laundry';
  const alamatCab = [cab.alamat, cab.kota].filter(Boolean).join(', ');
  const telpCab = cab.no_hp || '';
  const tgl = d.tanggal ? String(d.tanggal).slice(0, 16).replace('T', ' ') : '-';
  const krj = d.kode_keranjang || d.kode_antrian || '';
  // jenis struk: belum bayar = NOTA TAGIHAN, lunas = TANDA TERIMA
  const belumBayar = d.status_bayar !== 'lunas';
  const judulStruk = belumBayar ? 'NOTA TAGIHAN' : 'TANDA TERIMA';

  const barisItem = items.map((it) => {
    const q = Number(it.qty) || 1;
    let suffix = '';
    if (it.item_tipe === 'barang') {
      // satuan dari kolom barang.satuan (mis. pcs, sachet, botol)
      const sat = it.barang_satuan || 'pcs';
      suffix = ` ${q} ${sat}`;
    } else {
      // satuan layanan dari satuan_hitung
      const map = { per_load: 'Load', per_kg: 'Kg', per_km: 'Km', per_sachet: 'Sachet', per_pcs: 'pcs' };
      const sat = map[it.satuan_hitung];
      suffix = sat ? ` ${q} ${sat}` : (q > 1 ? ` ×${q}` : '');
    }
    return `<tr><td>${esc(it.nama_item)}${suffix}</td><td style="text-align:right;">${rupiah(it.subtotal)}</td></tr>`;
  }).join('');

  // riwayat status + total waktu (hanya jika withTimeline=true)
  const riw = d.riwayat || [];
  let riwayatHtml = '';
  if (withTimeline && riw.length) {
    riwayatHtml = `<hr class="hr"><div class="c b">PROSES PENGERJAAN</div><table>`;
    riw.forEach((r) => {
      const mesin = r.kode_mesin ? ` (${esc(r.kode_mesin)})` : '';
      riwayatHtml += `<tr><td>${esc(r.nama || r.kode)}${mesin}</td><td style="text-align:right;white-space:nowrap;">${esc(strukWaktu(r.waktu))}</td></tr>`;
    });
    riwayatHtml += `</table>`;
    // total waktu kerja = dari 'sudah_bayar' sampai 'siap_diambil'/'selesai'
    const cari = (kode) => riw.find((r) => r.kode === kode);
    const awal = cari('sudah_bayar') || riw[0];
    const akhir = cari('siap_diambil') || cari('selesai_antar')
      || [...riw].reverse().find((r) => r.kode !== 'sudah_diambil')
      || riw[riw.length - 1];
    if (awal && akhir) {
      const keMenit = (w) => { const s = String(w); return new Date(s.slice(0, 10) + 'T' + s.slice(11, 16) + ':00').getTime(); };
      const menit = Math.max(0, Math.round((keMenit(akhir.waktu) - keMenit(awal.waktu)) / 60000));
      const jam = Math.floor(menit / 60), sisaMenit = menit % 60;
      riwayatHtml += `<div class="row b" style="margin-top:3px;"><span>Total proses</span><span class="r">${jam > 0 ? jam + ' jam ' : ''}${sisaMenit} menit</span></div>`;
    }
  }

  // footer sosmed dari data cabang
  const sosLines = [];
  if (cab.link_gmap_review) sosLines.push(`Review Google: ${esc(cab.link_gmap_review)}`);
  if (cab.link_ig) sosLines.push(`Instagram: ${esc(cab.link_ig)}`);
  if (cab.link_fb) sosLines.push(`Facebook: ${esc(cab.link_fb)}`);
  if (cab.link_tiktok) sosLines.push(`TikTok: ${esc(cab.link_tiktok)}`);
  const sosmedHtml = sosLines.length
    ? `<hr class="hr"><div class="b c">Dukung kami & ikuti update:</div><div style="font-size:9px;word-break:break-all;text-align:left;">${sosLines.map((x) => '- ' + x).join('<br>')}</div>`
    : '';

  // styling struk thermal -> dirender ke elemen tersembunyi -> html2canvas -> JPG
  const css = `
    *{font-family:'Courier New','Consolas',monospace;box-sizing:border-box;}
    .struk{width:384px;padding:18px 14px 24px;color:#000;background:#fff;font-size:15px;line-height:1.4;}
    .struk .c{text-align:center;}.struk .b{font-weight:bold;}
    .struk .hr{border:none;border-top:1px dashed #000;margin:7px 0;}
    .struk .row{display:flex;justify-content:space-between;gap:8px;}
    .struk .row .r{text-align:right;white-space:nowrap;}
    .struk .head{text-align:center;margin-bottom:5px;}
    .struk .head .nm{font-size:19px;font-weight:bold;}
    .struk .krj{text-align:center;border:1px dashed #000;padding:6px;margin:7px 0;}
    .struk .krj .v{font-size:23px;font-weight:bold;letter-spacing:1px;}
    .struk table{width:100%;border-collapse:collapse;}
    .struk td{padding:2px 0;font-size:14px;vertical-align:top;}
    .struk .foot{text-align:center;font-size:13px;margin-top:10px;}
  `;
  const isi = `
    <div class="head">
      <div class="nm">${esc(outlet)}</div>
      ${alamatCab ? `<div>${esc(alamatCab)}</div>` : ''}
      ${telpCab ? `<div>Telp: ${esc(telpCab)}</div>` : ''}
      <div>${judulStruk}</div>
    </div>
    <hr class="hr">
    ${krj ? `<div class="krj"><div>KODE KERANJANG</div><div class="v">${esc(krj)}</div></div>` : ''}
    <div class="row"><span>Invoice</span><span class="r b">${esc(d.no_invoice || '-')}</span></div>
    <div class="row"><span>Tanggal</span><span class="r">${esc(tgl)}</span></div>
    <div class="row"><span>Nama</span><span class="r">${esc(p.nama || '-')}</span></div>
    <div class="row"><span>Telp</span><span class="r">${esc(p.telepon || '-')}</span></div>
    <hr class="hr">
    <table>${barisItem}</table>
    <hr class="hr">
    ${d.berat_kg ? `<div class="row"><span>Berat</span><span class="r">${d.berat_kg} kg</span></div>` : ''}
    ${(d.diskon && d.diskon > 0) ? `
    <div class="row"><span>Subtotal</span><span class="r">${rupiah(d.subtotal)}</span></div>
    <div class="row" style="color:#16a34a;"><span>⭐ Tukar ${Number(d.poin_dipakai) || Math.round(d.diskon / 10)} poin</span><span class="r">- ${rupiah(d.diskon)}</span></div>` : ''}
    <div class="row b" style="font-size:17px;"><span>TOTAL</span><span class="r">${rupiah(d.total)}</span></div>
    ${belumBayar
      ? `<div class="krj" style="margin-top:6px;"><div>HARUS DIBAYAR</div><div class="v">${rupiah(d.total)}</div></div>
         <div class="c" style="font-size:11px;">Bayar via ${esc(labelMetode(d.metode_bayar || 'cash').toUpperCase())}</div>`
      : `<div class="row"><span>Bayar</span><span class="r">${esc(labelMetode(d.metode_bayar).toUpperCase())} LUNAS</span></div>`}
    ${riwayatHtml}
    <hr class="hr">
    <div class="foot">${belumBayar
      ? `Mohon selesaikan pembayaran.<br>Simpan nota ini sebagai<br>bukti pesanan.`
      : `Terima kasih sudah laundry<br>di ${esc(outlet)}.<br>Simpan struk ini sebagai<br>bukti pengambilan.`}</div>
    ${sosmedHtml}
    <div class="foot">${new Date().toLocaleString('id-ID')}</div>
  `;

  if (typeof html2canvas === 'undefined') { toast('Library gambar belum dimuat (cek koneksi)', 'danger'); return; }
  // elemen tersembunyi (off-screen) untuk dirender
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-9999px;top:0;';
  const style = document.createElement('style'); style.textContent = css;
  const el = document.createElement('div'); el.className = 'struk'; el.innerHTML = isi;
  wrap.appendChild(style); wrap.appendChild(el); document.body.appendChild(wrap);

  toast('Membuat nota...', 'success');
  html2canvas(el, { scale: 2, backgroundColor: '#ffffff' }).then((canvas) => {
    const jpg = canvas.toDataURL('image/jpeg', 0.92);
    document.body.removeChild(wrap);

    // Tampilkan preview modal
    const suffix = withTimeline ? '_timeline' : '';
    const namaFile = `${belumBayar ? 'Nota' : 'Struk'}${suffix}_${(d.no_invoice || 'laundry')}.jpg`;
    const oldModal = document.getElementById('nota-preview-modal');
    if (oldModal) oldModal.remove();

    const modal = document.createElement('div');
    modal.id = 'nota-preview-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:16px;box-sizing:border-box;
    `;
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:420px;width:100%;max-height:90vh;
                  display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:12px 16px;border-bottom:1px solid #eee;flex-shrink:0;">
          <span style="font-weight:700;font-size:14px;">Preview Nota</span>
          <button onclick="document.getElementById('nota-preview-modal').remove()"
                  style="background:none;border:none;font-size:20px;cursor:pointer;color:#888;line-height:1;">✕</button>
        </div>
        <div style="overflow-y:auto;flex:1;padding:12px;text-align:center;background:#f5f5f5;">
          <img src="${jpg}" style="max-width:100%;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);" />
        </div>
        <div style="padding:12px 16px;border-top:1px solid #eee;flex-shrink:0;">
          <a href="${jpg}" download="${namaFile}"
             style="display:block;text-align:center;background:var(--primary,#2563eb);color:#fff;
                    padding:10px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;">
            <i class="fas fa-download"></i> Simpan JPG
          </a>
        </div>
      </div>
    `;
    // tutup modal jika klik backdrop
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }).catch((e) => {
    document.body.removeChild(wrap);
    toast('Gagal membuat nota: ' + e.message, 'danger');
  });
}

/** Konfirmasi dulu sebelum lompat -- ini aksi yang ngejalanin beberapa step sekaligus. */
function konfirmasiSudahDiambil() {
  if (!confirm('Selesaikan semua sisa proses sekaligus sampai "Sudah Diambil"?')) return;
  doSudahDiambilLangsung();
}

async function doSudahDiambilLangsung() {
  try {
    const res = await api('/transaksi/' + OD.id + '/sudah-diambil', { method: 'POST' });
    if (res.data.sampai_sudah_diambil) {
      toast('Transaksi selesai (sudah diambil)', 'success');
    } else {
      toast('Diproses sampai "' + (res.data.status_akhir_nama || res.data.status_akhir) + '" -- cek detail', 'warning');
    }
    DASH.data = null;
    await openOrderDetail(OD.id);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); }
}

function renderActionBar(na) {
  // hapus action bar lama
  const old = document.getElementById('od-action-bar'); if (old) old.remove();
  if (!na || na.tipe === 'selesai') return;

  let btn = '';
  if (na.tipe === 'bayar') {
    btn = `<button class="btn-zl btn-success-zl" onclick="openBayarSheet()"><i class="fas fa-cash-register"></i> ${esc(na.label || 'Terima Pembayaran')}</button>`;
  } else if (na.tipe === 'pilih_mesin') {
    btn = `<button class="btn-zl btn-primary-zl" onclick="openMesinSheet('${esc(na.mesin_tipe)}','${esc(na.target)}','${esc(na.target_nama || '')}')"><i class="fas fa-gear"></i> ${esc(na.label)}</button>`;
  } else if (na.tipe === 'lanjut') {
    btn = `<button class="btn-zl btn-primary-zl" onclick="lanjutStatus('${esc(na.target)}','${esc(na.label)}')"><i class="fas fa-arrow-right"></i> ${esc(na.label)}</button>`;
    // Tombol "Sudah Diambil" -- cuma relevan buat customer yang NUNGGU DI
    // OUTLET (tail-end pipeline: setrika/lipat/siap diambil), BUKAN buat
    // transaksi yang pakai antar/antar-jemput (itu jalur delivery terpisah,
    // "sudah diambil" gak relevan buat mereka).
    const TAHAP_TUNGGU_DI_OUTLET = ['proses_setrika', 'selesai_setrika', 'proses_lipat', 'selesai_lipat', 'siap_diambil'];
    if (TAHAP_TUNGGU_DI_OUTLET.includes(na.target)) {
      // Perubahan #13: bayar saat ambil yang belum lunas -> terima pembayaran dulu
      const blmLunas = OD.data && OD.data.status_bayar !== 'lunas';
      btn = `<button class="btn-zl btn-primary-zl" style="flex:1;" onclick="lanjutStatus('${esc(na.target)}','${esc(na.label)}')"><i class="fas fa-arrow-right"></i> ${esc(na.label)}</button>
        ${blmLunas
          ? `<button class="btn-zl btn-success-zl" style="flex:1;" onclick="openBayarSheet()"><i class="fas fa-cash-register"></i> Bayar & Ambil</button>`
          : `<button class="btn-zl btn-light-zl" style="flex:1;" onclick="konfirmasiSudahDiambil()"><i class="fas fa-box-open"></i> Sudah Diambil</button>`}`;
    }
  } else if (na.tipe === 'menunggu_gate') {
    // "Selesai Cuci" terkunci -- siklus bilas mesin cuci baru mulai menit ke-20,
    // berlaku sama untuk kasir maupun customer (lihat GATE_SELESAI_CUCI_MENIT backend).
    btn = `<button class="btn-zl" disabled style="background:#d1d5db;color:#fff;cursor:not-allowed;"><i class="fas fa-hourglass-half"></i> Tersedia ${na.sisa_menit} menit lagi</button>`;
  } else if (na.tipe === 'menunggu_otomatis') {
    // "Selesai Kering" -- tidak ada tombol manual sama sekali, murni auto-complete.
    btn = `<button class="btn-zl" disabled style="background:#d1d5db;color:#fff;cursor:not-allowed;"><i class="fas fa-circle-notch fa-spin"></i> Menunggu selesai otomatis</button>`;
  } else if (na.tipe === 'menunggu_antrian') {
    // Semua mesin penuh (mode alokasi otomatis) -- info aja, manuver manual
    // ke antrian ada di kartu "Antrian Mesin" dashboard, bukan di sini.
    btn = `<button class="btn-zl" disabled style="background:var(--primary-light);color:var(--primary);cursor:not-allowed;"><i class="fas fa-users-line"></i> ${esc(na.label)}</button>`;
  }
  if (!btn) return;
  const bar = document.createElement('div');
  bar.id = 'od-action-bar'; bar.className = 'action-bar';
  bar.innerHTML = btn;
  document.body.appendChild(bar);
}

/* ---- BAYAR (metode ikut yang dipilih saat pesan) ---- */
// Perubahan #83: 3 metode uang -- Cash & QRIS (statis, dikonfirmasi kasir) dan
// Kios-K (QR Winpay, lunas otomatis). Pesanan Kios-K boleh dibayar di kasir
// (pilih Cash / QRIS). Bayar saat ambil boleh ganti metode (Perubahan #69).
const METODE_UI = {
  cash: { ico: 'money-bill-wave', judul: 'Cash', warna: 'success' },
  qris: { ico: 'qrcode', judul: 'QRIS (statis)', warna: 'info' },
  kiosk: { ico: 'tablet-screen-button', judul: 'Kios-K (Winpay)', warna: 'primary' },
};
function openBayarSheet() {
  const d = OD.data || {};
  const MA = d.metode_aktif || { cash: true, qris: true, kiosk: false };
  const asal = ['qris', 'kiosk'].includes(d.metode_bayar) ? d.metode_bayar : 'cash';
  const bisaGanti = d.status_bayar !== 'lunas' && (!!Number(d.bayar_saat_ambil) || asal === 'kiosk');
  let opsi = ['cash', 'qris', 'kiosk'].filter((k) => MA[k] || k === asal);
  if (asal === 'kiosk' && !opsi.includes('cash') && !opsi.includes('qris')) opsi = ['cash', ...opsi];
  if (!bisaGanti || !OD._metodeBayar || !opsi.includes(OD._metodeBayar)) OD._metodeBayar = asal;
  const metode = OD._metodeBayar;
  const U = METODE_UI[metode];
  const isKiosk = metode === 'kiosk';
  openSheet(`
    <h3>Terima Pembayaran</h3>
    <div class="card-zl" style="text-align:center;">
      <div style="font-size:12px;color:var(--text-muted);">Total Tagihan</div>
      <div id="bayar-total" style="font-size:26px;font-weight:800;color:var(--primary);">${rupiah(d.total)}</div>
      ${d.diskon > 0 ? `<div style="font-size:11px;color:var(--success);margin-top:2px;">⭐ Sudah termasuk potongan ${rupiah(d.diskon)} dari poin</div>` : ''}
    </div>
    <div class="card-zl" style="display:flex;align-items:center;gap:12px;">
      <div class="svc-ic" style="width:42px;height:42px;border-radius:11px;background:var(--${U.warna}-light);color:var(--${U.warna});display:flex;align-items:center;justify-content:center;font-size:18px;">
        <i class="fas fa-${U.ico}"></i>
      </div>
      <div style="flex:1;">
        <div style="font-size:12px;color:var(--text-muted);">Metode Pembayaran</div>
        <div style="font-size:16px;font-weight:700;">${U.judul}</div>
        <div style="font-size:11px;color:var(--text-muted);">${bisaGanti ? 'Boleh diganti sesuai cara pelanggan bayar' : 'Sesuai pilihan saat pemesanan'}</div>
      </div>
    </div>
    ${bisaGanti && opsi.length > 1 ? `<div class="bsa-metode bsa-metode3">${opsi.map((k) => `<button class="${k === metode ? 'on' : ''}" onclick="gantiMetodeBayar('${k}')"><i class="fas fa-${METODE_UI[k].ico}"></i> ${labelMetode(k)}</button>`).join('')}</div>` : ''}
    ${isKiosk ? `
    <div style="font-size:12px;color:var(--text-muted);margin:4px 0 10px;text-align:center;">Pelanggan bayar di tablet Kios-K pakai kode bayar dari HP-nya, atau tampilkan QR di bawah. Lunas otomatis begitu Winpay konfirmasi.</div>
    <button class="btn-zl btn-primary-zl" id="btn-qris-dinamis" onclick="generateQrisKasir(${d.id})"><i class="fas fa-qrcode"></i> Tampilkan QR Kios-K</button>`
    : `<button class="btn-zl btn-success-zl" id="btn-bayar" onclick="doBayar()"><i class="fas fa-check"></i> Konfirmasi Pembayaran ${labelMetode(metode)}</button>`}
    ${!Number(d.bayar_saat_ambil) && d.status_bayar !== 'lunas' ? `
    <button class="btn-zl bsa-btn" style="margin-top:8px;" id="btn-bsa" onclick="doBayarSaatAmbil()"><i class="fas fa-hand-holding-dollar"></i> Proses, Bayar Saat Ambil</button>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;text-align:center;">Cucian langsung masuk antrian. Kas dicatat saat pelanggan bayar; cucian baru bisa diserahkan setelah lunas.</div>` : ''}`);
}

/* ---- QRIS DINAMIS (Winpay) -- generate buat 1 transaksi yang lagi dibuka kasir ---- */
let _kasirQrisPollInterval = null;

async function generateQrisKasir(transaksiId, opts = {}) {
  const d = OD.data || {};
  const silent = !!opts.silent;
  if (!silent) {
    openSheet(`<div style="text-align:center;padding:24px 0;"><i class="fas fa-spinner fa-spin" style="font-size:22px;"></i><div style="margin-top:8px;font-size:13px;color:var(--text-muted);">Membuat QR pembayaran...</div></div>`);
  }
  try {
    const res = await api('/pembayaran-qris', {
      method: 'POST',
      body: { pelanggan_id: d.pelanggan_id, transaksi_ids: [transaksiId] },
    });
    renderQrisKasirSheet(res.data);
    startPollQrisKasir(res.data.id, transaksiId);
  } catch (e) {
    // percobaan otomatis (silent) gagal/nonaktif -> fallback DIAM-DIAM ke
    // mekanisme yang sekarang: biarkan sheet "Terima Pembayaran" apa adanya
    // (tombol Konfirmasi Pembayaran Manual tetap ada & berfungsi).
    if (silent) { console.warn('QR dinamis Winpay otomatis gagal (fallback ke manual):', e.message); return; }
    openSheet(`
      <div style="text-align:center;padding:20px 0;color:var(--danger);">Gagal membuat QR: ${esc(e.message)}</div>
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:10px;" onclick="openBayarSheet()">Kembali</button>`);
  }
}

function renderQrisKasirSheet(sesi, statusText) {
  openSheet(`
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;"><i class="fas fa-tablet-screen-button"></i> QR Kios-K (Winpay)</div>
      <div style="font-size:20px;font-weight:800;color:var(--primary);margin-bottom:10px;">${rupiah(sesi.amount)}</div>
      ${sesi.qr_url ? `<img src="${esc(sesi.qr_url)}" style="width:230px;height:230px;object-fit:contain;border:1px solid var(--border);border-radius:12px;padding:8px;background:#fff;" />` : ''}
      <div style="margin-top:10px;font-size:13px;color:var(--text-muted);">${esc(statusText || 'Suruh pelanggan scan QR di atas. Status auto-update begitu Winpay konfirmasi bayar.')}</div>
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:14px;" onclick="batalPollQrisKasir()">Tutup</button>
    </div>`);
}

function batalPollQrisKasir() {
  if (_kasirQrisPollInterval) { clearInterval(_kasirQrisPollInterval); _kasirQrisPollInterval = null; }
  closeSheet();
}

function startPollQrisKasir(pembayaranId, transaksiId) {
  if (_kasirQrisPollInterval) clearInterval(_kasirQrisPollInterval);
  let ticks = 0;
  _kasirQrisPollInterval = setInterval(async () => {
    ticks++;
    if (ticks > 300) { clearInterval(_kasirQrisPollInterval); _kasirQrisPollInterval = null; return; } // ~20 menit, jaga2
    let sesi;
    try {
      const res = await api('/pembayaran-qris/' + pembayaranId);
      sesi = res.data;
    } catch (e) { return; }

    if (sesi.status === 'pending') return;
    clearInterval(_kasirQrisPollInterval); _kasirQrisPollInterval = null;
    const sheetMasihAktif = $('sheet-bg') && $('sheet-bg').classList.contains('active');

    if (sesi.status === 'paid') {
      toast('Pembayaran QRIS diterima', 'success');
      closeSheet();
      await openOrderDetail(transaksiId); // refresh detail -> status bayar udah lunas (di-set otomatis dari webhook)
    } else if (['expired', 'canceled', 'failed'].includes(sesi.status)) {
      const label = sesi.status === 'expired' ? 'QR sudah kadaluarsa' : sesi.status === 'canceled' ? 'Dibatalkan' : 'Pembayaran gagal';
      if (sheetMasihAktif) {
        openSheet(`
          <div style="text-align:center;padding:10px 0;">
            <i class="fas fa-circle-xmark" style="font-size:36px;color:var(--danger);"></i>
            <div style="margin-top:10px;font-size:15px;font-weight:700;">${esc(label)}</div>
            <button class="btn-zl btn-primary-zl" style="width:100%;margin-top:14px;" onclick="openBayarSheet()">Kembali</button>
          </div>`);
      }
    }
  }, 4000);
}

function toggleTukarPoin(aktif, poinEfektif, potongan) {
  const preview = document.getElementById('poin-preview');
  const totalEl = document.getElementById('bayar-total');
  const d = OD.data || {};
  if (aktif) {
    preview.style.display = 'block';
    totalEl.textContent = rupiah(Math.max(0, d.total - potongan));
    totalEl.style.color = 'var(--success)';
  } else {
    preview.style.display = 'none';
    totalEl.textContent = rupiah(d.total);
    totalEl.style.color = 'var(--primary)';
  }
}
async function doBayar() {
  const btn = $('btn-bayar'); btnLoad(btn, true);
  try {
    // Perubahan #69: metode yang dipilih di lembar bayar (bayar saat ambil boleh ganti)
    const body = OD._metodeBayar && OD._metodeBayar !== 'kiosk' ? { metode_bayar: OD._metodeBayar } : {};
    const res = await api('/transaksi/' + OD.id + '/bayar', { method: 'POST', body });
    OD._metodeBayar = null;
    // tukar poin setelah bayar berhasil (dari form pesan atau toggle di sheet)
    const poinDipakai = OD._poinDipakai || 0;
    if (poinDipakai >= 40) {
      try {
        await api('/transaksi/' + OD.id + '/tukar-poin', { method: 'POST', body: { poin_dipakai: poinDipakai } });
      } catch (pe) { toast('Poin gagal ditukar: ' + pe.message, 'warning'); }
      OD._poinDipakai = 0;
    }
    closeSheet(); toast('Pembayaran diterima', 'success');
    await openOrderDetail(OD.id);
    handleWaAfter(res && res.data);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}

/** Perubahan #69: ganti metode di lembar bayar (khusus bayar saat ambil) */
function gantiMetodeBayar(m) { OD._metodeBayar = ['qris', 'kiosk'].includes(m) ? m : 'cash'; closeSheet(); openBayarSheet(); }

/* ---- Perubahan #13: proses dulu, bayar saat ambil ---- */
async function doBayarSaatAmbil() {
  if (!confirm('Proses pesanan sekarang, pelanggan bayar saat ambil cucian?')) return;
  const btn = $('btn-bsa'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi/' + OD.id + '/bayar-saat-ambil', { method: 'POST' });
    closeSheet(); toast('Pesanan diproses, bayar saat ambil', 'success');
    DASH.data = null;
    await openOrderDetail(OD.id);
    handleWaAfter(res && res.data);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}

/* ---- LANJUT STATUS ---- */
async function lanjutStatus(target, label) {
  if (!confirm(`Lanjutkan ke "${label}"?`)) return;
  try {
    const res = await api('/transaksi/' + OD.id + '/status', { method: 'POST', body: { status: target } });
    toast('Status diperbarui: ' + label, 'success');
    handleWaAfter(res && res.data);
    // Invalidate cache dashboard supaya halaman lain (Pesanan/Riwayat/Dashboard) refresh data terbaru
    DASH.data = null;
    await openOrderDetail(OD.id);
  } catch (e) {
    if (e.details && e.details.antrian) {
      // "Semua mesin penuh, masuk antrian" itu KONDISI NORMAL (bukan
      // kegagalan) -- transaksi tetap di status sekarang, otomatis muncul
      // di kartu "Antrian Mesin" dashboard begitu ada mesin kosong.
      toast('Semua mesin sedang penuh, transaksi masuk antrian', 'warning');
      await openOrderDetail(OD.id);
    } else {
      toast(e.message || 'Gagal', 'danger');
    }
  }
}

/* Kalau status baru memicu WA, tawarkan buka wa.me (kirim manual). */
function handleWaAfter(data) {
  const wa = data && data.wa;
  if (!wa || !wa.link) return;
  // kalau status sekarang siap_diambil / sudah_diambil, sediakan tombol download struk utk di-attach
  const skrg = (data.status_kode) || (OD.data && OD.data.status_kode) || '';
  const adaStruk = ['sudah_bayar', 'siap_diambil', 'sudah_diambil', 'selesai_antar'].includes(skrg);
  openSheet(`
    <h3><i class="fab fa-whatsapp" style="color:#25D366;"></i> Kirim WhatsApp</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">
      Pemberitahuan untuk pelanggan sudah disiapkan.${adaStruk ? ' Unduh struk dulu, lalu lampirkan (attach) di chat WhatsApp.' : ''}
    </p>
    ${adaStruk ? `<div style="display:flex;gap:8px;margin-bottom:10px;">
      <button class="btn-zl btn-light-zl" onclick="cetakStruk(false)" style="flex:1;font-size:12px;"><i class="fas fa-receipt"></i> Nota</button>
      <button class="btn-zl btn-light-zl" onclick="cetakStruk(true)" style="flex:1;font-size:12px;"><i class="fas fa-timeline"></i> + Timeline</button>
    </div>` : ''}
    <a class="btn-zl btn-success-zl" href="${esc(wa.link)}" target="_blank" rel="noopener" onclick="closeSheet()" style="display:block;text-align:center;text-decoration:none;">
      <i class="fab fa-whatsapp"></i> ${adaStruk ? '2. ' : ''}Buka WhatsApp
    </a>
    <button class="btn-zl btn-light-zl" onclick="closeSheet()" style="margin-top:10px;">Nanti saja</button>`);
}

/* ---- PILIH MESIN ---- */
async function openMesinSheet(tipe, target, targetNama) {
  openSheet(`<h3>Pilih Mesin ${tipe === 'washer' ? 'Cuci' : 'Pengering'}</h3><div id="mesin-list">${spinner()}</div>`);
  OD.mesinTipe = tipe; OD.mesinTarget = target; OD.mesinPick = null;
  try {
    const res = await api('/master/mesin?tipe=' + encodeURIComponent(tipe));
    const list = (res.data || []).filter((m) => m.status === 'aktif' && !m.direservasi); // hanya idle & belum dipesan orang lain
    if (!list.length) { $('mesin-list').innerHTML = emptyState('Tidak ada mesin idle saat ini', 'fa-gear'); return; }
    $('mesin-list').innerHTML = `
      <div class="mesin-pick">${list.map((m) => `
        <div class="mesin-opt" data-id="${m.id}" onclick="pickMesin(${m.id})">
          <div class="mo-kode">${esc((m.kode_mesin || '').split('-').pop() || m.kode_mesin)}</div>
          <div class="mo-cap">${m.kapasitas_kg || '-'} kg</div>
        </div>`).join('')}</div>
      <button class="btn-zl btn-primary-zl" id="btn-mesin" onclick="doPilihMesin()" disabled style="margin-top:16px;">Alokasikan & Lanjut</button>`;
  } catch (e) { $('mesin-list').innerHTML = emptyState('Gagal memuat mesin. ' + e.message, 'fa-triangle-exclamation'); }
}
function pickMesin(id) {
  OD.mesinPick = id;
  document.querySelectorAll('.mesin-opt').forEach((o) => o.classList.toggle('selected', Number(o.dataset.id) === id));
  $('btn-mesin').disabled = false;
}
async function doPilihMesin() {
  if (!OD.mesinPick) { toast('Pilih mesin dulu', 'warning'); return; }
  const btn = $('btn-mesin'); btnLoad(btn, true);
  try {
    // 1) alokasi mesin (status alokasi_mesin_*) dengan mesin_id
    await api('/transaksi/' + OD.id + '/status', { method: 'POST', body: { status: OD.mesinTarget, mesin_id: OD.mesinPick } });
    closeSheet(); toast('Mesin dialokasikan', 'success');
    await openOrderDetail(OD.id);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}

/* ============================================================
   PESANKAN (kasir buat order untuk pelanggan)
   ============================================================ */
const PROMO_LABEL = {
  gratis_cuci_pelanggan_baru: 'Cuci Gratis — Pelanggan Baru',
  gratis_cuci_jumat_berkah: 'Cuci Gratis — Jumat Berkah',
};

const PSN = {
  step: 1,
  pelanggan: null,          // { id, nama, telepon, ... } kalau lama
  baru: false,              // mode pelanggan baru
  katalog: null,
  searchTimer: null,
  order: null,
};
function psnResetOrder() {
  return { berat_kg: '', cuci: false, kering: null, kering_manual: false, lipat: null, antar: null, antar_km: '', dropoffQty: 0, produk: {}, alamat_antar: '', metode: 'cash', hp: '', nama: '', promo_pilihan: null, promo_label: null, cafeSearch: '' };
}

/**
 * Rekomendasi durasi Kering berdasar berat cucian (kg) -- SAMA PERSIS
 * aturannya dengan role customer (lihat public/customer/app.js):
 *   0-3kg -> 15 menit, 3-7kg -> 30 menit, >7kg -> 45 menit.
 * Cuma default/saran -- kasir tetap bebas pilih durasi lain manual lewat
 * psnPickKering(), gak dikunci.
 */
function rekomendasiDurasiKering(beratKg) {
  const b = Number(beratKg) || 0;
  // Perubahan #42: s/d 6 kg -> 30 menit, 7 kg ke atas -> 45 menit (berat dibulatkan).
  // Kering 15 menit = layanan tambahan (kalau 30/45 belum kering), tidak pernah disarankan.
  if (b <= 6) return 30;
  return 45;
}
function pilihLayananKeringOtomatis(beratKg) {
  const list = layananByKat('kering');
  if (!list.length) return null;
  const target = rekomendasiDurasiKering(beratKg);
  const exact = list.find((h) => Number(h.durasi_menit) === target);
  if (exact) return exact.id;
  let best = list[0];
  let bestDiff = Math.abs((Number(best.durasi_menit) || 0) - target);
  list.forEach((h) => {
    const diff = Math.abs((Number(h.durasi_menit) || 0) - target);
    if (diff < bestDiff) { best = h; bestDiff = diff; }
  });
  return best.id;
}

async function loadPesankan() {
  PSN.step = 1; PSN.pelanggan = null; PSN.baru = false; PSN.order = psnResetOrder();
  const body = $('pesankan-body');
  // muat katalog sekali
  if (!PSN.katalog) {
    body.innerHTML = spinner();
    try { const res = await api('/master/katalog'); PSN.katalog = res.data || { layanan: [], barang: [] }; }
    catch (e) { body.innerHTML = emptyState('Gagal memuat katalog. ' + e.message, 'fa-triangle-exclamation'); return; }
  }
  renderPsnStep1();
}

/* ---- STEP 1: pilih / cari pelanggan ---- */
function renderPsnStep1() {
  $('psn-sub').textContent = 'Langkah 1 — Pilih pelanggan';
  removeTotalBar();
  $('pesankan-body').innerHTML = `
    <div class="search-zl"><i class="fas fa-magnifying-glass"></i>
      <input type="text" id="psn-search" placeholder="Cari nama / nomor HP pelanggan" oninput="onPsnSearch()" autocomplete="off">
    </div>
    <div id="psn-search-result"></div>
    <div style="text-align:center;margin:14px 0;color:var(--slate-light);font-size:12px;">— atau —</div>
    <button class="btn-zl btn-light-zl" onclick="psnPelangganBaru()"><i class="fas fa-user-plus"></i> Pelanggan Baru</button>
    <div id="psn-jatah-slot"></div>`;
  PSN.jatah = null;
  // Perubahan #39: "Pesan untuk saya" (jatah cuci kasir)
  if (S.user && S.user.role === 'kasir') muatJatah().then((j) => { if ($('psn-jatah-slot') && j && j.berhak) $('psn-jatah-slot').innerHTML = psnKartuSayaHtml(j); });
}
function psnKartuSayaHtml(j) {
  return `<div class="jt-me" onclick="psnPesanSaya()">
      <div class="ic"><i class="fas fa-id-badge"></i></div>
      <div style="flex:1;min-width:0;"><b>Pesan untuk saya (${esc((j.nama || '').split(' ')[0])})</b><small>Jatah cuci minggu ini: sisa ${rupiah(j.sisa)}</small></div>
      <i class="fas fa-chevron-right"></i></div>`;
}
async function psnPesanSaya() {
  const j = S.jatah || await muatJatah();
  if (!j || !j.berhak) { toast('Akun ini tidak mendapat jatah cuci', 'warning'); return; }
  if (!j.telepon) {
    openSheet(`<h3><i class="fas fa-mobile-screen"></i> Nomor HP kamu</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Diisi sekali, dipakai untuk pesanan jatah & WA status cucian.</div>
      <div class="field"><input type="tel" id="jt-hp" placeholder="08xxxxxxxxxx" inputmode="tel"></div>
      <button class="btn-zl btn-primary-zl" id="btn-jt-hp" onclick="psnSimpanHpSaya()"><i class="fas fa-check"></i> Simpan &amp; lanjut</button>`);
    return;
  }
  PSN.jatah = j; PSN.baru = false;
  PSN.pelanggan = { nama: j.nama, telepon: j.telepon, kunjungan: 0, point: 0 };
  PSN.order = psnResetOrder();
  renderPsnStep2();
}
async function psnSimpanHpSaya() {
  const btn = $('btn-jt-hp'); btnLoad(btn, true);
  try {
    S.jatah = (await api('/absensi/jatah/telepon', { method: 'PUT', body: { telepon: ($('jt-hp').value || '').trim() } })).data;
    closeSheet(); toast('Nomor HP disimpan', 'success'); psnPesanSaya();
  } catch (e) { toast(e.message || 'Gagal menyimpan', 'danger'); btnLoad(btn, false); }
}
function onPsnSearch() {
  const q = $('psn-search').value.trim();
  clearTimeout(PSN.searchTimer);
  if (q.length < 2) { $('psn-search-result').innerHTML = ''; return; }
  PSN.searchTimer = setTimeout(async () => {
    try {
      const res = await api('/pelanggan/search?q=' + encodeURIComponent(q));
      const list = res.data || [];
      $('psn-search-result').innerHTML = list.length
        ? list.map((p) => `
            <div class="cust-result" onclick='psnPilihPelanggan(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
              <div><div class="cr-nama">${esc(p.nama)}</div><div class="cr-hp">${esc(p.telepon)} · ${p.kunjungan}x · ${p.point} poin</div></div>
              <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
            </div>`).join('')
        : `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px;">Tidak ditemukan. Gunakan "Pelanggan Baru".</div>`;
    } catch (e) { $('psn-search-result').innerHTML = ''; }
  }, 350);
}
function psnPilihPelanggan(p) {
  PSN.pelanggan = p; PSN.baru = false; PSN.jatah = null;
  PSN.order = psnResetOrder();
  PSN.order.hp = p.telepon; PSN.order.nama = p.nama;
  renderPsnStep2();
}
function psnPelangganBaru() {
  PSN.pelanggan = null; PSN.baru = true; PSN.jatah = null;
  PSN.order = psnResetOrder();
  renderPsnStep2();
}

/* ---- STEP 2: form order ---- */
function findL(id) { return (PSN.katalog.layanan || []).find((l) => l.id === id); }
function layananByKat(kat) { return (PSN.katalog.layanan || []).filter((l) => l.kategori === kat); }
function layananPertama(kat) { return layananByKat(kat)[0] || null; }

/** Pilih baris "Cuci" sesuai berat -- lihat penjelasan lengkap di customer/app.js. */
function pilihCuci(beratKg) {
  const opsi = layananByKat('cuci');
  if (opsi.length <= 1) return opsi[0] || null;
  const urutan = [...opsi].sort((a, b) => {
    if (a.berat_maks == null) return 1;
    if (b.berat_maks == null) return -1;
    return Number(a.berat_maks) - Number(b.berat_maks);
  });
  const berat = Number(beratKg) || 0;
  return urutan.find((r) => r.berat_maks == null || berat <= Number(r.berat_maks)) || urutan[urutan.length - 1];
}

/** Render daftar barang (qty stepper) untuk 1 grup kategori. onQtyFn = nama function global utk +/-. */
function renderBarangQtyList(list, produkState, onQtyFn) {
  return list.map((b) => {
    const qty = produkState[b.id] || 0;
    return `
      <div class="qty-row">
        <div class="qr-info"><div class="qr-name">${esc(b.nama)}</div><div class="qr-price">${rupiah(b.harga_jual)}</div></div>
        <div class="qty-stepper">
          <button onclick="${onQtyFn}(${b.id},-1)" ${qty <= 0 ? 'disabled' : ''}>−</button>
          <span class="qv">${qty}</span>
          <button onclick="${onQtyFn}(${b.id},1)">+</button>
        </div>
      </div>`;
  }).join('');
}

function renderPsnStep2() {
  $('psn-sub').textContent = 'Langkah 2 — Detail pesanan';
  const o = PSN.order;
  const cuciL = pilihCuci(window.IK3D.beratHitung(o.berat_kg));
  const keringList = layananByKat('kering');
  const lipatGrup = [...layananByKat('lipat'), ...layananByKat('setrika_lipat')];
  const antarGrup = [...layananByKat('antar'), ...layananByKat('antar_jemput'), ...layananByKat('jemput')]; // #73
  const dropL = layananPertama('drop_off');
  const barang = PSN.katalog.barang || [];

  let html = `<div class="card-zl" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <button class="ph-back" style="background:var(--bg-soft);color:var(--text);" onclick="renderPsnStep1()"><i class="fas fa-arrow-left"></i></button>
      <div style="flex:1;">
        ${PSN.jatah
          ? `<div style="font-size:14px;font-weight:700;">${esc(PSN.jatah.nama)} · Jatah karyawan</div><div style="font-size:11px;color:#047857;">Sisa jatah ${rupiah(PSN.jatah.sisa)} · hanya cuci &amp; kering</div>`
          : PSN.baru
          ? `<div style="font-size:13px;font-weight:600;">Pelanggan Baru</div><div style="font-size:11px;color:var(--text-muted);">Isi HP & nama di bawah</div>`
          : `<div style="font-size:14px;font-weight:700;">${esc(PSN.pelanggan.nama)}</div><div style="font-size:11px;color:var(--text-muted);">${esc(PSN.pelanggan.telepon)} · ${PSN.pelanggan.kunjungan}x · ${PSN.pelanggan.point} poin</div>`}
      </div>
    </div>`;

  // ===== Perubahan #35: kartu ikon 3D (sama dengan app customer) =====
  const IK = window.IK3D;
  const bH = IK.beratHitung(o.berat_kg);
  const bAsli = Number(o.berat_kg) || 0;
  PSN.expand = PSN.expand || { tambahan: false, laundry: false, cafe: false };

  html += `
    <div class="section-label"><i class="fas fa-weight-hanging"></i> Berat Cucian</div>
    <div class="ik-berat"><div class="ik-ico g-berat"><i class="fas fa-weight-hanging"></i></div>
      <div class="ik-bin"><label for="psn-berat">Berat cucian</label>
        <div class="ik-brow">
          <button type="button" onclick="psnGeserBerat(-0.1)">−</button>
          <div class="v"><input class="vin" id="psn-berat" inputmode="decimal" autocomplete="off" placeholder="0" value="${IK.fmtBerat(o.berat_kg)}" style="width:${IK.lebarBerat(IK.fmtBerat(o.berat_kg))}" oninput="psnOnBeratInput()" onblur="psnOnBeratBlur()"> <small>kg</small></div>
          <button type="button" onclick="psnGeserBerat(0.1)">+</button>
        </div>
        <div class="ik-bh" id="psn-berat-info">${psnBeratInfo(bAsli, bH)}</div>
      </div>
    </div>`;

  html += `<div class="section-label"><i class="fas fa-star"></i> Layanan Utama <span style="font-weight:400;font-size:11px;">(wajib pilih min. 1)</span></div><div class="ik-grid2">`;
  if (cuciL) {
    // Perubahan #87: tombol promo cuma tampil kalau ada promo buat pelanggan ini (atau lagi dipakai)
    psnMuatPromo(o.hp || '');
    const promo = o.cuci && !PSN.jatah ? `<div class="ik-promo" id="psn-promo" style="${o.promo_pilihan || psnAdaPromo() ? '' : 'display:none;'}" onclick="event.stopPropagation();openPsnPromoSheet()"><i class="fas fa-gift"></i> ${o.promo_pilihan ? esc(o.promo_label || 'Promo dipakai') : 'Gunakan Promo'}</div>` : '';
    html += IK.tile({ sel: o.cuci, ...IK.ikonLayanan('cuci'), nama: 'Cuci', desc: cuciL.berat_maks ? `s/d ${Number(cuciL.berat_maks)} kg · per load` : 'per load',
      harga: rupiah(cuciL.harga), onclick: 'psnToggleCuci()', extra: promo });
  }
  // Perubahan #52: satu kartu Kering, berputar tiap diklik
  if (keringList.length) html += IK.tileKering(o, keringList, pilihLayananKeringOtomatis(IK.beratHitung(o.berat_kg)), rupiah, 'psnPutarKering()');
  html += `</div>`;

  const adaUtama = o.cuci || !!o.kering;
  const antarKat = o.antar ? (findL(o.antar) || {}).kategori : null;
  const isAntarJemput = antarKat === 'antar_jemput';

  // Perubahan #39: pesanan jatah -> hanya cuci & kering
  if (PSN.jatah) {
    html += `<div class="ik-cap" style="margin-top:4px;"><i class="fas fa-circle-info"></i> Jatah dipakai dengan harga normal. Kalau kurang, sisanya dibayar cash / QRIS.</div><div style="height:260px;"></div>`;
    $('pesankan-body').innerHTML = html;
    psnRenderTotal();
    return;
  }

  // LAYANAN TAMBAHAN (tertutup default)
  const dq = o.dropoffQty || 0;
  const tbBuka = PSN.expand.tambahan || !!o.lipat || !!o.antar || dq > 0;
  const tbRing = [o.lipat ? (lipatGrup.find((h) => h.id === o.lipat) || {}).nama_paket : null,
    o.antar ? (antarGrup.find((h) => h.id === o.antar) || {}).nama_paket : null,
    dq > 0 ? `${dropL ? dropL.nama_paket : 'Drop-off'} ×${dq}` : null].filter(Boolean).join(', ');
  html += IK.sec('fa-plus', 'Layanan Tambahan', tbBuka, tbRing, "psnToggleExpand('tambahan')");
  if (tbBuka) {
    if (!adaUtama) html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"><i class="fas fa-lock"></i> Lipat, setrika & antar terkunci. Tambahkan Cuci/Kering dulu. (Drop-off & produk tetap bisa.)</div>`;
    html += `<div class="ik-grid2">`;
    lipatGrup.forEach((h) => {
      html += IK.tile({ sel: o.lipat === h.id, ...IK.ikonLayanan(h.kategori), nama: h.nama_paket, desc: h.kategori === 'setrika_lipat' ? 'setrika + lipat' : 'lipat saja',
        harga: `${rupiah(h.harga)}/kg`, onclick: `psnPickLipat(${h.id})`, dis: !adaUtama });
    });
    if (dropL) {
      html += IK.tile({ sel: dq > 0, ...IK.ikonLayanan('drop_off'), nama: dropL.nama_paket, desc: 'dikerjakan petugas', harga: `${rupiah(dropL.harga)}/mesin`,
        onclick: dq > 0 ? '' : 'psnChangeDropoff(1)', extra: IK.qty(dq, 'psnChangeDropoff(-1)', 'psnChangeDropoff(1)', dq >= 2) });
    }
    antarGrup.forEach((h) => {
      const perKm = h.satuan_hitung === 'per_km';
      html += IK.tile({ sel: o.antar === h.id, ...IK.ikonLayanan(h.kategori), nama: h.nama_paket, desc: h.kategori === 'antar_jemput' ? 'dijemput & diantar' : h.kategori === 'jemput' ? 'dijemput, ambil di toko' : 'diantar ke alamat',
        harga: perKm ? `${rupiah(h.harga)}/km` : rupiah(h.harga), onclick: `psnPickAntar(${h.id})`, dis: !adaUtama });
    });
    html += `</div>`;
    if (dropL) html += `<div class="ik-cap">Drop-off 1× = petugas memindahkan ke pengering · 2× = semua dikerjakan petugas</div>`;
    if (o.antar) {
      const la = findL(o.antar) || {};
      const perKm = la.satuan_hitung === 'per_km';
      const jarak = Number(o.antar_km) || 0;
      const subtotalAntar = perKm ? Number(la.harga) * jarak : Number(la.harga);
      html += `
        <div class="card-zl">
          ${perKm ? `
          <div class="field">
            <label>Jarak (km) — verifikasi via Google Maps</label>
            <input type="number" id="psn-jarak" min="0" step="0.1" placeholder="cth: 3.5" value="${o.antar_km}" oninput="psnSetJarak(this.value)">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              Tarif ${rupiah(la.harga)}/km${jarak > 0 ? ` × ${jarak} km = <b style="color:var(--primary);">${rupiah(subtotalAntar)}</b>` : ''}
            </div>
          </div>` : ''}
          <div class="field" style="margin-bottom:0;">
            <label>Alamat ${isAntarJemput ? 'Jemput & Antar' : antarKat === 'jemput' ? 'Jemput' : 'Antar'} + Patokan</label>
            <textarea id="psn-alamat" rows="2" placeholder="Alamat lengkap + patokan" oninput="PSN.order.alamat_antar=this.value">${esc(o.alamat_antar)}</textarea>
          </div>
        </div>`;
    }
  }

  // KEBUTUHAN LAUNDRY & CAFE (tertutup default, kartu ikon/foto + kamera)
  const barangLaundry = barang.filter((b) => (b.kategori || 'laundry') === 'laundry');
  if (barangLaundry.length) {
    const ada = barangLaundry.some((b) => (o.produk[b.id] || 0) > 0);
    const buka = PSN.expand.laundry || ada;
    const ring = barangLaundry.filter((b) => (o.produk[b.id] || 0) > 0).map((b) => `${b.nama} ×${o.produk[b.id]}`).join(', ');
    html += IK.sec('fa-box', 'Kebutuhan Laundry', buka, ring, "psnToggleExpand('laundry')");
    if (buka) html += `<div class="ik-grid2">${barangLaundry.map((b) => psnKartuBarang(b)).join('')}</div>`;
  }
  const barangCafe = barang.filter((b) => b.kategori === 'cafe');
  if (barangCafe.length) {
    const ada = barangCafe.some((b) => (o.produk[b.id] || 0) > 0);
    const buka = PSN.expand.cafe || ada;
    const ring = barangCafe.filter((b) => (o.produk[b.id] || 0) > 0).map((b) => `${b.nama} ×${o.produk[b.id]}`).join(', ');
    html += IK.sec('fa-mug-hot', 'Cafe &amp; Minuman', buka, ring, "psnToggleExpand('cafe')");
    if (buka) {
      html += `<input type="text" id="psn-cafe-search" class="ik-search" placeholder="Cari produk cafe... (kopi, air mineral, dll)" value="${esc(o.cafeSearch || '')}" oninput="onPsnCafeSearchInput()">`;
      html += `<div id="psn-cafe-list" class="ik-grid2">${renderPsnCafeList()}</div>`;
      html += `<div class="ik-cap">Ikon kamera = ganti foto barang</div>`;
    }
  }

  // DATA PEMESAN (hanya pelanggan baru perlu input; lama sudah dikenal)
  if (PSN.baru) {
    html += `<div class="section-label"><i class="fas fa-id-card"></i> Data Pemesan</div>
      <div class="card-zl">
        <div class="field">
          <label>Nomor HP (WhatsApp aktif)</label>
          <input type="tel" id="psn-hp" placeholder="08xxxxxxxxxx" value="${esc(o.hp)}" oninput="PSN.order.hp=this.value;clearTimeout(window._psnHpT);window._psnHpT=setTimeout(()=>psnMuatPromo(PSN.order.hp),600)">
          <div class="hint">Dipakai untuk notifikasi status cucian via WhatsApp.</div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Nama</label>
          <input type="text" id="psn-nama" placeholder="Nama pelanggan" value="${esc(o.nama)}" oninput="PSN.order.nama=this.value">
        </div>
      </div>`;
  }

  // Perubahan #35: metode pembayaran pindah ke panel bawah (menempel)
  html += `<div style="height:260px;"></div>`;

  $('pesankan-body').innerHTML = html;
  psnRenderTotal();
}

/* ===== Perubahan #35: helper Pesankan (berat desimal, kartu barang, panel bawah, foto) ===== */
function psnBeratInfo(asli, hitung) {
  let t = 'Ketik 9,4 atau 9.4 · tombol −/+ per 0,1 kg';
  if (asli > 0 && hitung !== asli) t += ` · harga dihitung ${hitung} kg (dibulatkan)`;
  return t;
}
function psnOnBeratInput() {
  const IK = window.IK3D;
  IK.pasLebar($('psn-berat'));
  const v = IK.parseBerat($('psn-berat').value);
  PSN.order.berat_kg = isNaN(v) || v <= 0 ? '' : String(v);
  const info = $('psn-berat-info'); if (info) info.textContent = psnBeratInfo(Number(PSN.order.berat_kg) || 0, IK.beratHitung(PSN.order.berat_kg));
  psnRenderTotal();
}
function psnGeserBerat(d) {
  const IK = window.IK3D;
  let b = IK.parseBerat($('psn-berat') ? $('psn-berat').value : PSN.order.berat_kg);
  if (isNaN(b)) b = 0;
  b = Math.max(0, IK.rapikanBerat(b + d));
  PSN.order.berat_kg = b ? String(b) : '';
  psnOnBeratBlur(true);
}
function psnPutarKering() {
  window.IK3D.putarKering(PSN.order, layananByKat('kering'), pilihLayananKeringOtomatis(window.IK3D.beratHitung(PSN.order.berat_kg)));
  psnSyncLock(); renderPsnStep2();
}
function psnPilihKeringKartu(id) {
  const o = PSN.order;
  const rekom = pilihLayananKeringOtomatis(window.IK3D.beratHitung(o.berat_kg));
  // Perubahan #42: klik pertama (belum ada kering) -> selalu yang disarankan; klik berikutnya bebas
  if (!o.kering) { o.kering = rekom || id; o.kering_manual = false; }
  else if (o.kering === id) { o.kering = null; o.kering_manual = false; }
  else { o.kering = id; o.kering_manual = id !== rekom; }
  psnSyncLock(); renderPsnStep2();
}
function psnToggleExpand(k) { PSN.expand = PSN.expand || {}; PSN.expand[k] = !PSN.expand[k]; renderPsnStep2(); }
function psnKartuBarang(b) {
  const IK = window.IK3D;
  const q = PSN.order.produk[b.id] || 0;
  const stok = b.stok_terkini != null ? Number(b.stok_terkini) : null;
  const ik = IK.ikonBarang(b);
  return IK.tile({ sel: q > 0, g: ik.g, ico: ik.ico, foto: IK.fotoUrl(API, b), nama: b.nama, harga: rupiah(b.harga_jual),
    onclick: q > 0 ? '' : `psnQty(${b.id}, 1)`, cam: `bukaFotoBarang(${b.id})`,
    extra: (stok != null ? `<div class="ik-stok">stok ${stok}</div>` : '') + IK.qty(q, `psnQty(${b.id}, -1)`, `psnQty(${b.id}, 1)`, stok != null && q >= stok) });
}
function psnPoinInfo(est) {
  const pelPoin = PSN.pelanggan && !PSN.baru ? (Number(PSN.pelanggan.point) || 0) : 0;
  const NILAI = Number(S.user && S.user.nilai_per_poin) || 10, KEL = 100, MIN_POIN = 500;
  const poinMaks = Math.floor(Math.min(pelPoin, Math.floor(est / NILAI)) / KEL) * KEL;
  return { pelPoin, MIN_POIN, poinMaks, potongan: poinMaks * NILAI, bisa: poinMaks >= KEL && pelPoin >= MIN_POIN };
}
function psnPoinChip() {
  const p = psnPoinInfo(psnEstimate());
  if (!p.bisa) return;
  PSN.order.poin_dipakai = PSN.order.poin_dipakai > 0 ? 0 : p.poinMaks;
  psnRenderTotal();
}

/* ---- ganti foto barang (kasir / manager / owner) ---- */
function bukaFotoBarang(id) {
  const b = (PSN.katalog.barang || []).find((x) => x.id === id); if (!b) return;
  const IK = window.IK3D; const ik = IK.ikonBarang(b); const foto = IK.fotoUrl(API, b);
  openSheet(`<h3><i class="fas fa-camera"></i> Foto ${esc(b.nama)}</h3>
    <div class="ik-sheet-foto">
      <div class="pv" id="fb-pv">${foto ? `<img src="${foto}" alt="">` : `<div class="ik-ico ${ik.g}" style="margin:0"><i class="fas ${ik.ico}"></i></div>`}</div>
      <div style="font-size:12px;color:var(--text-muted);text-align:center;">Foto dipotong persegi & dikecilkan otomatis. Tampil di app kasir & customer.</div>
      <input type="file" id="fb-kamera" accept="image/*" capture="environment" style="display:none" onchange="pilihFotoBarang(${id}, this)">
      <input type="file" id="fb-file" accept="image/*" style="display:none" onchange="pilihFotoBarang(${id}, this)">
      <div style="display:flex;gap:8px;">
        <button class="btn-zl btn-primary-zl" style="flex:1;" onclick="$('fb-kamera').click()"><i class="fas fa-camera"></i> Kamera</button>
        <button class="btn-zl btn-light-zl" style="flex:1;" onclick="$('fb-file').click()"><i class="fas fa-image"></i> Pilih gambar</button>
      </div>
      ${foto ? `<button class="btn-zl btn-light-zl" id="fb-hapus" onclick="hapusFotoBarang(${id})"><i class="fas fa-trash"></i> Hapus foto (kembali ke ikon)</button>` : ''}
    </div>`);
}
async function pilihFotoBarang(id, input) {
  const file = input.files && input.files[0]; if (!file) return;
  try {
    const data = await window.IK3D.kecilkanFoto(file);
    $('fb-pv').innerHTML = `<img src="${data}" alt="">`;
    const r = await api(`/master/barang/${id}/foto`, { method: 'PUT', body: { data } });
    const b = (PSN.katalog.barang || []).find((x) => x.id === id); if (b) b.foto_v = r.data.foto_v;
    toast('Foto barang disimpan', 'success'); closeSheet(); renderPsnStep2();
  } catch (e) { toast(e.message || 'Gagal menyimpan foto', 'danger'); }
}
async function hapusFotoBarang(id) {
  if (!confirm('Hapus foto barang ini? Kartu kembali memakai ikon.')) return;
  try {
    await api(`/master/barang/${id}/foto`, { method: 'DELETE' });
    const b = (PSN.katalog.barang || []).find((x) => x.id === id); if (b) b.foto_v = null;
    toast('Foto dihapus', 'success'); closeSheet(); renderPsnStep2();
  } catch (e) { toast(e.message, 'danger'); }
}

function psnSyncLock() {
  // kalau tidak ada cuci & kering -> lipat/antar tidak boleh aktif (drop-off independen, tidak ikut terkunci)
  if (!PSN.order.cuci && !PSN.order.kering) {
    PSN.order.lipat = null; PSN.order.antar = null; PSN.order.alamat_antar = '';
  }
}
function psnToggleCuci() { PSN.order.cuci = !PSN.order.cuci; if (!PSN.order.cuci) { PSN.order.promo_pilihan = null; PSN.order.promo_label = null; } psnSyncLock(); renderPsnStep2(); }

/* ---------- Perubahan #87: cek promo tersedia di awal (kasir) ---------- */
const PSN_PROMO = { key: null, list: null };
function psnAdaPromo() { return !!(PSN_PROMO.list && PSN_PROMO.list.length); }
async function psnMuatPromo(hp) {
  hp = String(hp || '').trim();
  const cabangId = S.user && S.user.cabang_id;
  if (!cabangId || hp.length < 9) { PSN_PROMO.key = null; PSN_PROMO.list = null; psnTampilPromo(); return; }
  const k = cabangId + '|' + hp;
  if (PSN_PROMO.key === k) return;
  PSN_PROMO.key = k; PSN_PROMO.list = null;
  let list = [];
  try { list = (await api(`/customer/promo-tersedia?cabang_id=${cabangId}&telepon=${encodeURIComponent(hp)}`)).data || []; } catch (e) { list = []; }
  if (PSN_PROMO.key !== k) return;
  PSN_PROMO.list = list;
  psnTampilPromo();
}
function psnTampilPromo() {
  const el = document.getElementById('psn-promo');
  if (el) el.style.display = ((PSN.order && PSN.order.promo_pilihan) || psnAdaPromo()) ? '' : 'none';
}

/* ---------- GUNAKAN PROMO (kasir) ---------- */
async function openPsnPromoSheet() {
  const hp = (PSN.order.hp || '').trim();
  if (!hp || hp.length < 9) { toast('Isi nomor HP pelanggan dulu buat cek promo', 'warning'); return; }

  openSheet(`<h3><i class="fas fa-gift"></i> Gunakan Promo</h3><div id="psn-promo-body">${spinner()}</div>`);
  try {
    const cabangId = S.user && S.user.cabang_id;
    const res = await api(`/customer/promo-tersedia?cabang_id=${cabangId}&telepon=${encodeURIComponent(hp)}`);
    renderPsnPromoSheet(res.data || []);
  } catch (e) {
    $('psn-promo-body').innerHTML = `<div style="font-size:12px;color:var(--danger);">Gagal memuat: ${esc(e.message || '')}</div>`;
  }
}

function renderPsnPromoSheet(list) {
  const box = $('psn-promo-body');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `${emptyState('Belum ada promo yang bisa dipakai saat ini', 'fa-gift')}
      <button class="btn-zl btn-light-zl" style="margin-top:10px;" onclick="closeSheet()">Tutup</button>`;
    return;
  }
  let html = list.map((p) => `
    <div class="card-zl" style="margin-bottom:8px;cursor:pointer;" onclick="pilihPsnPromo('${p.jenis_promo}','${esc(p.label)}')">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:13px;"><i class="fas fa-gift" style="color:var(--success);"></i> ${esc(p.label)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${rupiah(p.harga_normal)} &rarr; ${rupiah(p.harga_promo)}</div>
        </div>
        <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
      </div>
    </div>`).join('');
  if (PSN.order.promo_pilihan) {
    html += `<button class="btn-zl btn-light-zl" style="margin-top:6px;width:100%;" onclick="pilihPsnPromo(null,null)">Jangan pakai promo</button>`;
  }
  box.innerHTML = html;
}

function pilihPsnPromo(jenis, label) {
  PSN.order.promo_pilihan = jenis;
  PSN.order.promo_label = label;
  closeSheet();
  renderPsnStep2();
  if (jenis) toast('Promo dipilih: ' + label, 'success');
}
function psnToggleKering() {
  if (PSN.order.kering) {
    PSN.order.kering = null;
    PSN.order.kering_manual = false;
  } else {
    PSN.order.kering = pilihLayananKeringOtomatis(window.IK3D.beratHitung(PSN.order.berat_kg)) || ((layananByKat('kering')[0] || {}).id || null);
    PSN.order.kering_manual = false;
  }
  psnSyncLock(); renderPsnStep2();
}
function psnPickKering(id) { PSN.order.kering = id; PSN.order.kering_manual = true; renderPsnStep2(); }
function psnPickLipat(id) { PSN.order.lipat = PSN.order.lipat === id ? null : id; renderPsnStep2(); }
function psnPickAntar(id) { PSN.order.antar = PSN.order.antar === id ? null : id; if (!PSN.order.antar) PSN.order.antar_km = ''; renderPsnStep2(); }
function psnSetJarak(v) { PSN.order.antar_km = v; renderPsnStep2(); }
function psnChangeDropoff(delta) {
  const cur = PSN.order.dropoffQty || 0;
  PSN.order.dropoffQty = Math.max(0, Math.min(2, cur + delta));
  renderPsnStep2();
}
function psnPickMetode(m) { PSN.order.metode = (['qris', 'kiosk'].includes(m) ? m : 'cash'); renderPsnStep2(); }

/* Perubahan #83: 4 cara bayar (Cash / QRIS / Kios-K + Poin) sesuai saklar cabang */
const LABEL_METODE = { cash: 'Cash', qris: 'QRIS', kiosk: 'Kios-K' };
function labelMetode(m) { return LABEL_METODE[m] || (m ? String(m).toUpperCase() : '-'); }
function psnMetodeAktif() {
  return (PSN.katalog && PSN.katalog.metode_bayar) || { cash: true, qris: true, kiosk: false, poin: true };
}
function psnQty(id, d) {
  const cur = PSN.order.produk[id] || 0; const next = Math.max(0, cur + d);
  if (next === 0) delete PSN.order.produk[id]; else PSN.order.produk[id] = next;
  // item cafe: partial-render (cuma #psn-cafe-list) biar fokus search box
  // nggak ke-reset oleh render ulang seluruh step 2.
  const b = (PSN.katalog.barang || []).find((x) => x.id === id);
  if (b && b.kategori === 'cafe' && $('psn-cafe-list')) {
    $('psn-cafe-list').innerHTML = renderPsnCafeList();
    psnRenderTotal();
  } else {
    renderPsnStep2();
  }
}

/** Cari 1 kata di 'nama' barang, dipakai search box cafe kasir. */
function onPsnCafeSearchInput() {
  PSN.order.cafeSearch = $('psn-cafe-search') ? $('psn-cafe-search').value : '';
  const el = $('psn-cafe-list');
  if (el) el.innerHTML = renderPsnCafeList();
}

/**
 * Daftar produk cafe yang ditampilkan: search KOSONG -> cuma yang SUDAH
 * dipilih (qty > 0). Search DIISI -> yang namanya cocok, buat nambah pilihan.
 */
function renderPsnCafeList() {
  // Perubahan #35: kartu ikon/foto; tanpa kata kunci = semua produk cafe aktif & stok > 0
  const barangCafe = (PSN.katalog.barang || []).filter((b) => b.kategori === 'cafe');
  const q = (PSN.order.cafeSearch || '').trim().toLowerCase();
  const list = q ? barangCafe.filter((b) => b.nama.toLowerCase().includes(q)) : barangCafe;
  if (!list.length) return `<div style="grid-column:1/-1;font-size:12px;color:var(--text-muted);padding:6px 2px;">Tidak ada produk cocok "${esc(q)}"</div>`;
  return list.map((b) => psnKartuBarang(b)).join('');
}

function psnEstimate() {
  const o = PSN.order; const berat = window.IK3D.beratHitung(o.berat_kg); let total = 0; // Perubahan #35: berat dibulatkan
  if (o.cuci) { const l = pilihCuci(window.IK3D.beratHitung(o.berat_kg)); if (l) total += Number(l.harga); }
  if (o.kering) { const l = findL(o.kering); if (l) total += Number(l.harga); }
  if (o.lipat) { const l = findL(o.lipat); if (l) total += Number(l.harga) * berat; }
  if (o.antar) { const l = findL(o.antar); if (l) { const km = Number(o.antar_km) || 0; total += l.satuan_hitung === 'per_km' ? Number(l.harga) * km : Number(l.harga); } }
  // drop-off: pilihan bebas 0-2, tarif per mesin, tidak terikat layanan lain
  if (o.dropoffQty > 0) { const l = layananPertama('drop_off'); if (l) total += Number(l.harga) * o.dropoffQty; }
  for (const id in o.produk) { const b = (PSN.katalog.barang || []).find((x) => x.id === Number(id)); if (b) total += Number(b.harga_jual) * o.produk[id]; }
  return total;
}
function removeTotalBar() { const t = document.getElementById('psn-total-bar'); if (t) t.remove(); }
/** Kapasitas mesin cuci (washer) TERBESAR yang ada di tabel mesin cabang ini -- acuan
 * nyata buat batas berat, BUKAN dari layanan/tier harga. Mesin nonaktif (dibuang/
 * permanen mati) tidak dihitung; maintenance/jalan tetap dihitung karena fisiknya ada. */
function maxKapasitasWasher() {
  const mesin = (PSN.katalog && PSN.katalog.mesin) || [];
  const washer = mesin.filter((m) => m.tipe === 'washer' && m.status !== 'nonaktif' && m.kapasitas_kg != null);
  if (!washer.length) return null; // data mesin belum ada -- jangan blokir, biar tidak salah reset
  return Math.max(...washer.map((m) => Number(m.kapasitas_kg)));
}
/** Berat cucian dibulatkan ke kg terdekat (10.4 -> 10, 10.55 -> 11) begitu kasir selesai input.
 * Kalau lebih besar dari kapasitas mesin cuci terbesar yang ada di cabang ini -> langsung
 * di-nol-kan (bukan sekadar warning), sesuai kapasitas mesin sebenarnya di tabel mesin. */
function psnOnBeratBlur(dariTombol) {
  // Perubahan #35: berat desimal (koma/titik, 1 angka di belakang koma);
  // harga/tier/rekomendasi kering memakai berat dibulatkan.
  const IK = window.IK3D;
  let b;
  if (dariTombol) b = Number(PSN.order.berat_kg) || 0;
  else {
    const inp = $('psn-berat'); if (!inp) return;
    if (inp.value === '' || inp.value == null) { PSN.order.berat_kg = ''; renderPsnStep2(); return; }
    b = IK.parseBerat(inp.value);
    if (isNaN(b)) { toast('Berat tidak valid. Contoh: 6,5 atau 6.5', 'warning'); b = 0; }
  }
  b = IK.rapikanBerat(b);
  const maxMesin = maxKapasitasWasher();
  if (maxMesin != null && b > maxMesin) {
    toast(`Berat ${IK.fmtBerat(b)} kg melebihi kapasitas mesin cuci terbesar di cabang ini (maks ${maxMesin} kg). Isian berat direset.`, 'warning');
    b = 0;
  }
  PSN.order.berat_kg = b > 0 ? String(b) : '';
  if (PSN.order.kering && !PSN.order.kering_manual) {
    const rekom = pilihLayananKeringOtomatis(IK.beratHitung(PSN.order.berat_kg));
    if (rekom) PSN.order.kering = rekom;
  }
  renderPsnStep2();
}
function psnRenderTotal() {
  // Perubahan #35: panel bawah menempel = metode pembayaran + ringkasan ikon + total
  removeTotalBar();
  if (S.currentPage !== 'pesankan' || !PSN.katalog || !PSN.order) return;
  const IK = window.IK3D;
  const o = PSN.order;
  const est = psnEstimate();
  const p = psnPoinInfo(est);
  if (!psnMetodeAktif().poin) o.poin_dipakai = 0; // #83: penukaran poin dimatikan owner
  if (o.poin_dipakai > 0 && (!p.bisa || o.poin_dipakai !== p.poinMaks)) o.poin_dipakai = p.bisa ? p.poinMaks : 0; // sesuaikan kalau total berubah
  if (PSN.jatah) o.poin_dipakai = 0; // Perubahan #39: order jatah tanpa poin
  const pakai = o.poin_dipakai > 0;
  const jatahPotong = PSN.jatah ? Math.min(Number(PSN.jatah.sisa) || 0, est) : 0;
  const totalAkhir = PSN.jatah ? est - jatahPotong : (pakai ? Math.max(0, est - p.potongan) : est);
  const res = [];
  if (Number(o.berat_kg) > 0) res.push({ g: 'g-berat', ico: 'fa-weight-hanging', badge: `${IK.fmtBerat(o.berat_kg)}kg`, title: 'Berat' });
  if (o.cuci) res.push({ ...IK.ikonLayanan('cuci'), title: 'Cuci' });
  if (o.kering) { const l = findL(o.kering) || {}; res.push({ ...IK.ikonLayanan('kering'), badge: l.durasi_menit ? `${l.durasi_menit}'` : '', title: l.nama_paket }); }
  if (o.lipat) { const l = findL(o.lipat) || {}; res.push({ ...IK.ikonLayanan(l.kategori || 'lipat'), title: l.nama_paket }); }
  if (o.antar) { const l = findL(o.antar) || {}; res.push({ ...IK.ikonLayanan(l.kategori || 'antar'), title: l.nama_paket }); }
  if (o.dropoffQty > 0) res.push({ ...IK.ikonLayanan('drop_off'), badge: `×${o.dropoffQty}`, title: 'Drop-off' });
  for (const id in o.produk) {
    const b = (PSN.katalog.barang || []).find((x) => x.id === Number(id)); if (!b) continue;
    const ik = IK.ikonBarang(b);
    res.push({ g: ik.g, ico: ik.ico, foto: IK.fotoUrl(API, b), badge: `×${o.produk[id]}`, title: b.nama });
  }
  const MA = psnMetodeAktif();
  if (!PSN.jatah && !MA[o.metode]) o.metode = ['cash', 'qris', 'kiosk'].find((k) => MA[k]) || 'cash';
  // Perubahan #86: tombol besar 1 baris penuh (ikon + nama), sama dengan Pesan customer
  const chips = [
    MA.cash || PSN.jatah ? `<div class="${o.metode === 'cash' ? 'sel' : ''}" onclick="psnPickMetode('cash')"><i class="fas fa-money-bill-wave"></i>Cash</div>` : '',
    MA.qris && !PSN.jatah ? `<div class="${o.metode === 'qris' ? 'sel' : ''}" onclick="psnPickMetode('qris')"><i class="fas fa-qrcode"></i>QRIS</div>` : '',
    MA.kiosk && !PSN.jatah ? `<div class="${o.metode === 'kiosk' ? 'sel' : ''}" onclick="psnPickMetode('kiosk')"><i class="fas fa-tablet-screen-button"></i>Kios-K</div>` : '',
    PSN.jatah ? `<div class="sel jt-met"><i class="fas fa-id-badge"></i>Jatah<small>sisa ${rupiahK(PSN.jatah.sisa)}</small></div>`
      : MA.poin ? `<div class="${pakai ? 'sel' : ''} ${p.bisa ? '' : 'dis'}" onclick="psnPoinChip()"><i class="fas fa-star" style="color:#f59e0b;"></i>Poin<small>${p.bisa ? p.pelPoin : (p.pelPoin > 0 ? p.pelPoin + ' (min. ' + p.MIN_POIN + ')' : 'min. ' + p.MIN_POIN)}</small></div>` : '',
  ].filter(Boolean);
  const bar = document.createElement('div');
  bar.className = 'total-bar ik-panel'; bar.id = 'psn-total-bar';
  bar.innerHTML = `
    <div class="ik-res">${IK.resumeHtml(res)}</div>
    <div class="ik-met besar" style="grid-template-columns:repeat(${chips.length || 1},1fr);">${chips.join('')}</div>
    <div class="ik-tot">
      <div class="t"><small>${PSN.jatah ? 'Bayar' : 'Estimasi Total'}</small><b id="psn-tb-amount" style="color:${pakai || PSN.jatah ? 'var(--success)' : ''};">${rupiah(totalAkhir)}</b>
        ${pakai ? `<div class="ik-hemat">hemat ${rupiah(p.potongan)} · pakai ${o.poin_dipakai} poin</div>` : ''}
        ${PSN.jatah && est > 0 ? `<div class="ik-hemat">${rupiah(est)} − jatah ${rupiah(jatahPotong)}</div>` : ''}</div>
      <button class="btn-zl btn-primary-zl" id="psn-submit" onclick="psnSubmit()">Buat Pesanan</button>
    </div>`;
  document.body.appendChild(bar);
  const pg = document.getElementById('page-pesankan'); if (pg) pg.style.paddingBottom = (bar.offsetHeight + 16) + 'px'; // #86
}

function psnBuildPayload() {
  const o = PSN.order;
  const layanan = [];
  if (o.cuci) { const l = pilihCuci(window.IK3D.beratHitung(o.berat_kg)); if (l) layanan.push({ layanan_id: l.id }); }
  if (o.kering) layanan.push({ layanan_id: o.kering });
  if (o.lipat) layanan.push({ layanan_id: o.lipat });
  if (o.antar) { const l = findL(o.antar); const km = Number(o.antar_km) || 0; layanan.push({ layanan_id: o.antar, qty: (l && l.satuan_hitung === 'per_km') ? km : 1 }); }
  const dropoffQty = Math.max(0, Math.min(2, Number(o.dropoffQty) || 0));
  if (dropoffQty > 0) { const l = layananPertama('drop_off'); if (l) layanan.push({ layanan_id: l.id, qty: dropoffQty }); }
  const barang = Object.entries(o.produk).map(([id, qty]) => ({ barang_id: Number(id), qty }));
  const hp = PSN.baru ? (o.hp || '').trim() : PSN.pelanggan.telepon;
  const nama = PSN.baru ? (o.nama || '').trim() : PSN.pelanggan.nama;
  return {
    pelanggan: { telepon: hp, nama, alamat: o.alamat_antar || null },
    berat_kg: Number(o.berat_kg) || null,
    alamat_antar: o.antar ? (o.alamat_antar || '') : null,
    metode_bayar: o.metode || 'cash',
    promo_pilihan: o.cuci ? (o.promo_pilihan || undefined) : undefined,
    sumber_pesan: 'kasir',
    layanan, barang,
    ...(PSN.jatah ? { jatah_karyawan: true, barang: [], promo_pilihan: undefined } : {}),
  };
}

function psnTogglePoin(aktif, poinEfektif, potongan, totalAsli) {
  const el = document.getElementById('psn-tb-amount');
  if (!el) return;
  PSN.order.poin_dipakai = aktif ? poinEfektif : 0;
  el.textContent = rupiah(aktif ? Math.max(0, totalAsli - potongan) : totalAsli);
  el.style.color = aktif ? 'var(--success)' : '';
}

async function psnSubmit() {
  const o = PSN.order;
  if (o.berat_kg !== '' && o.berat_kg != null) { const _b = window.IK3D.parseBerat(o.berat_kg); o.berat_kg = isNaN(_b) || _b <= 0 ? '' : String(window.IK3D.rapikanBerat(_b)); } // Perubahan #35: desimal 1 angka
  // validasi ringan
  if (PSN.baru && (!(o.hp || '').trim() || !(o.nama || '').trim())) { toast('Isi HP & nama pelanggan baru', 'warning'); return; }
  if (!o.cuci && !o.kering && !o.antar && Object.keys(o.produk).length === 0 && !o.lipat) { toast('Pilih minimal satu layanan/produk', 'warning'); return; }
  const maxMesinSubmit = maxKapasitasWasher();
  if ((o.cuci || o.kering) && maxMesinSubmit != null && Number(o.berat_kg) > maxMesinSubmit) {
    toast(`Berat melebihi kapasitas mesin cuci terbesar di cabang ini (maks ${maxMesinSubmit} kg). Silakan buat pesanan terpisah.`, 'warning');
    if ($('psn-berat')) $('psn-berat').value = '';
    o.berat_kg = '';
    return;
  }
  if (o.cuci) {
    const cuciTerpilih = pilihCuci(window.IK3D.beratHitung(o.berat_kg));
    if (cuciTerpilih && cuciTerpilih.berat_maks != null && Number(o.berat_kg) > Number(cuciTerpilih.berat_maks)) {
      toast(`Berat melebihi kapasitas layanan Cuci yang tersedia (maks ${cuciTerpilih.berat_maks} kg). Silakan buat pesanan terpisah.`, 'warning');
      return;
    }
  }
  if (o.antar) {
    const la = findL(o.antar) || {};
    if (la.satuan_hitung === 'per_km' && (!(Number(o.antar_km) > 0))) { toast('Isi jarak (km) untuk antar/jemput', 'warning'); return; }
    if (!(o.alamat_antar || '').trim()) { toast('Isi alamat antar/jemput', 'warning'); return; }
  }
  const payload = psnBuildPayload();
  const btn = $('psn-submit'); btnLoad(btn, true);
  try {
    const res = await api('/transaksi', { method: 'POST', body: payload });
    const trx = res.data;
    // reserve poin: update diskon/total transaksi, point belum dikurangi
    if (PSN.order.poin_dipakai >= 40) {
      try {
        await api('/transaksi/' + trx.id + '/reserve-poin', { method: 'POST', body: { poin_dipakai: PSN.order.poin_dipakai } });
        OD._poinDipakai = PSN.order.poin_dipakai; // akan dikurangi saat doBayar
      } catch (pe) { toast('Poin gagal direservasi: ' + pe.message, 'warning'); }
    }
    removeTotalBar();
    // Perubahan #39: jatah menanggung seluruh harga -> langsung diproses (tanpa bayar)
    if (PSN.jatah && Number(trx.total) === 0) {
      try { await api('/transaksi/' + trx.id + '/bayar', { method: 'POST', body: { metode_bayar: 'cash' } }); }
      catch (be) { toast('Pesanan dibuat, tapi gagal diproses otomatis: ' + be.message, 'warning'); }
    }
    if (PSN.jatah) { PSN.jatah = null; muatJatah(); }
    toast('Pesanan dibuat: ' + (trx.no_invoice || ''), 'success');
    if (trx.jenis_promo && PROMO_LABEL[trx.jenis_promo]) {
      toast('🎁 Promo kepakai: ' + PROMO_LABEL[trx.jenis_promo], 'success', 5000);
    }
    openOrderDetail(trx.id);
  } catch (e) { toast(e.message || 'Gagal membuat pesanan', 'danger'); btnLoad(btn, false); }
}


/* ============================================================
   KAS KECIL
   ============================================================ */
const KAS = { kategori: null };

async function loadKas() {
  const body = $('kas-body'); if (!body) return;
  body.innerHTML = spinner();
  try {
    const res = await api('/kas');
    KAS.data = res.data;
    if (!KAS.expanded) KAS.expanded = {};
    renderKas(res.data);
  } catch (e) {
    body.innerHTML = emptyState('Gagal memuat kas. ' + e.message, 'fa-triangle-exclamation');
  }
}

function mutasiIcon(m) {
  if (m.jenis === 'keluar') return { ic: 'fa-arrow-up', col: 'var(--danger)' };
  return { ic: 'fa-arrow-down', col: 'var(--success)' };
}

function renderKas(d) {
  const s = d.saldo || { cash: 0, gopay: 0, total: 0 };
  const mutasi = d.mutasi || [];
  let html = '';

  // saldo card (cash | gopay | total)
  html += `
    <div class="saldo-card">
      <div class="sc-label">Total Saldo Kas Kecil</div>
      <div class="sc-total">${rupiah(s.total)}</div>
      <div class="sc-split sc-3">
        <div class="sc-item"><div class="l"><i class="fas fa-money-bill-wave"></i> Cash</div><div class="v">${rupiah(s.cash)}</div></div>
        <div class="sc-item"><div class="l"><i class="fas fa-qrcode"></i> Gopay</div><div class="v">${rupiah(s.gopay)}</div></div>
        <div class="sc-item"><div class="l"><i class="fas fa-coins"></i> Total</div><div class="v">${rupiah(s.total)}</div></div>
      </div>
    </div>`;

  // tombol catat belanja
  // aksi: catat belanja | top up gopay | setor | rekap setoran
  html += `<div style="display:flex;gap:6px;margin-bottom:14px;">
      <button class="btn-zl btn-light-zl kas-act" onclick="openBelanjaSheet()"><i class="fas fa-cart-shopping"></i><span>Catat Belanja</span></button>
      <button class="btn-zl btn-light-zl kas-act" onclick="openTopupSheet()"><i class="fas fa-wallet"></i><span>Top Up Gopay</span></button>
      <button class="btn-zl btn-primary-zl kas-act" onclick="openSetorSheet()"><i class="fas fa-paper-plane"></i><span>Setor</span></button>
      <button class="btn-zl btn-light-zl kas-act" onclick="openRekapSetoranSheet()"><i class="fas fa-clipboard-check"></i><span>Rekap Setoran</span></button>
    </div>`;

  // rekap per hari (bulan berjalan) - card expandable
  const rekap = d.rekap_harian || [];
  html += `<div class="section-label"><i class="fas fa-calendar-day"></i> Rekap Mutasi Harian</div>`;
  if (!rekap.length) {
    html += emptyState('Belum ada mutasi bulan ini', 'fa-receipt');
  } else {
    html += `<div id="kas-rekap">`;
    rekap.forEach((r) => {
      const open = KAS.expanded && KAS.expanded[r.tanggal];
      const isHariIni = r.tanggal === (d.tanggal || '');
      html += `
        <div class="card-zl" style="padding:0;overflow:hidden;margin-bottom:8px;">
          <div onclick="kasToggleHari('${r.tanggal}')" style="display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;">
            <i class="fas fa-chevron-${open ? 'down' : 'right'}" style="font-size:11px;color:var(--slate-light);width:12px;"></i>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:700;">${tglHari(r.tanggal)}${isHariIni ? ' <span style="font-size:9px;background:var(--primary-light);color:var(--primary);padding:1px 6px;border-radius:4px;">Hari ini</span>' : ''}</div>
              <div style="font-size:10px;color:var(--text-muted);">${r.jml} mutasi</div>
            </div>
            <div style="text-align:right;font-size:11px;line-height:1.9;">
              <div onclick="event.stopPropagation();kasToggleFilter('${r.tanggal}','pendapatan')" style="cursor:pointer;color:var(--success);">+${rupiahK(r.pendapatan||0)} <span style="color:var(--text-muted);font-size:9px;">pendapatan ›</span></div>
              <div onclick="event.stopPropagation();kasToggleFilter('${r.tanggal}','belanja_ops')" style="cursor:pointer;color:var(--danger);">−${rupiahK(r.belanja||0)} <span style="color:var(--text-muted);font-size:9px;">belanja ›</span></div>
              <div onclick="event.stopPropagation();kasToggleFilter('${r.tanggal}','reimburse')" style="cursor:pointer;color:var(--primary);">+${rupiahK(r.reimburse||0)} <span style="color:var(--text-muted);font-size:9px;">reimburse ›</span></div>
              <div onclick="event.stopPropagation();kasToggleFilter('${r.tanggal}','setor')" style="cursor:pointer;color:var(--warning);">−${rupiahK(r.setor||0)} <span style="color:var(--text-muted);font-size:9px;">setor ›</span></div>
              ${r.biaya_loyalty > 0 ? `<div onclick="event.stopPropagation();kasToggleFilter('${r.tanggal}','biaya_loyalty')" style="cursor:pointer;color:var(--danger);">−${rupiahK(r.biaya_loyalty)} <span style="color:var(--text-muted);font-size:9px;">loyalty/promo ›</span></div>` : ''}
            </div>
          </div>
          <div id="kas-hari-${r.tanggal}">${open ? renderMutasiHari(r.tanggal) : ''}</div>
        </div>`;
    });
    html += `</div>`;
  }

  $('kas-body').innerHTML = html;
}

function tglHari(ymd) {
  const [y, m, dd] = ymd.split('-').map(Number);
  const hari = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const bln = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const d = new Date(Date.UTC(y, m - 1, dd));
  return `${hari[d.getUTCDay()]}, ${dd} ${bln[m - 1]} ${y}`;
}

/** Format 'YYYY-MM-DD HH:mm:ss' -> "Sen, 8 Sep 2026 · 16:30" (dipakai Rekap Setoran). */
function fmtTanggalJam(dt) {
  if (!dt) return '-';
  const s = String(dt).replace(' ', 'T');
  const [ymd, hms] = s.split('T');
  const jam = (hms || '').slice(0, 5);
  return `${tglHari(ymd)} · ${jam}`;
}

/* ---------- REKAP SETORAN (tab ke-4 di Kas Kecil) ---------- */
const REKAP_SETORAN = { bulan: null };

const NAMA_BULAN = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function labelBulan(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${NAMA_BULAN[m]} ${y}`;
}

async function openRekapSetoranSheet() {
  openSheet(`<h3><i class="fas fa-clipboard-check"></i> Rekap Setoran</h3><div id="rekap-setoran-body">${spinner()}</div>`);
  await loadRekapSetoran();
}

async function loadRekapSetoran(bulan) {
  try {
    const q = bulan ? `?bulan=${bulan}` : '';
    const res = await api('/kas/setoran' + q);
    REKAP_SETORAN.bulan = res.data.bulan;
    renderRekapSetoran(res.data);
  } catch (e) {
    const box = $('rekap-setoran-body');
    if (box) box.innerHTML = `<div style="font-size:12px;color:var(--danger);">Gagal memuat: ${esc(e.message || '')}</div>`;
  }
}

function gantiBulanSetoran(sel) {
  loadRekapSetoran(sel.value);
}

function renderRekapSetoran(d) {
  const box = $('rekap-setoran-body');
  if (!box) return;
  const list = d.list || [];
  const bulanTersedia = d.bulan_tersedia || [d.bulan];

  let html = `
    <div class="field" style="margin-bottom:12px;">
      <select onchange="gantiBulanSetoran(this)" style="width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-family:'Poppins';font-size:13px;font-weight:600;">
        ${bulanTersedia.map((b) => `<option value="${b}" ${b === d.bulan ? 'selected' : ''}>${labelBulan(b)}</option>`).join('')}
      </select>
    </div>`;

  if (!list.length) {
    html += emptyState(`Belum ada setoran di ${labelBulan(d.bulan)}`, 'fa-clipboard-check');
    box.innerHTML = html;
    return;
  }

  const totalSemua = list.reduce((s, r) => s + (r.nominal_transfer || 0), 0);
  html += `
    <div class="card-zl" style="text-align:center;margin-bottom:12px;">
      <div style="font-size:12px;color:var(--text-muted);">Total ${list.length} kali setor — ${labelBulan(d.bulan)}</div>
      <div style="font-size:20px;font-weight:800;color:var(--primary);">${rupiah(totalSemua)}</div>
    </div>`;
  list.forEach((r) => {
    html += `
      <div class="card-zl" style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-size:13px;font-weight:700;">${rupiah(r.nominal_transfer)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;"><i class="fas fa-clock"></i> ${fmtTanggalJam(r.tanggal)}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${esc(r.id_transfer)} · ${r.jumlah_transaksi} transaksi</div>
          </div>
          ${r.bukti_url
            ? `<a href="${esc(r.bukti_url)}" target="_blank" style="font-size:11px;color:var(--primary);white-space:nowrap;"><i class="fas fa-image"></i> Bukti</a>`
            : `<span style="font-size:10px;color:var(--warning);white-space:nowrap;"><i class="fas fa-triangle-exclamation"></i> Belum ada bukti</span>`}
        </div>
      </div>`;
  });
  box.innerHTML = html;
}

// Filter per jenis_mutasi dalam satu hari
const _kasFilter = {};
function kasToggleFilter(tgl, jenisMutasi) {
  if (_kasFilter[tgl] === jenisMutasi) {
    delete _kasFilter[tgl];
    const el = $('kas-hari-' + tgl);
    if (el) el.innerHTML = renderMutasiHari(tgl);
    return;
  }
  _kasFilter[tgl] = jenisMutasi;
  // Kalau hari belum di-expand, expand dulu lalu apply filter setelah data load
  if (!KAS.expanded || !KAS.expanded[tgl] || KAS.expanded[tgl] === true) {
    kasToggleHari(tgl, jenisMutasi); return;
  }
  // Reimburse: tampilkan detail belanja yang di-reimburse
  if (jenisMutasi === 'reimburse') {
    kasShowReimburseDetail(tgl); return;
  }
  const el = $('kas-hari-' + tgl);
  if (el) el.innerHTML = renderMutasiHari(tgl);
}

async function kasShowReimburseDetail(tgl) {
  const el = $('kas-hari-' + tgl);
  if (!el) return;
  el.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--text-muted);">' + spinner() + '</div>';
  try {
    // Cari transfer_id dari baris reimburse di hari itu
    const list = KAS.expanded && KAS.expanded[tgl] || [];
    const reimburseItem = list.find(m => m.jenis_mutasi === 'reimburse');
    if (!reimburseItem || !reimburseItem.transfer_id) {
      el.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--text-muted);">Tidak ada data reimburse</div>';
      return;
    }
    const res = await api('/kas/reimburse/' + reimburseItem.transfer_id);
    const items = res.data || [];
    const filterNames = { pendapatan: 'Pendapatan', belanja_ops: 'Belanja', reimburse: 'Reimburse', setor: 'Setor' };
    let h = '<div style="border-top:1px solid var(--border);">'
      + '<div style="padding:6px 14px;font-size:10px;background:var(--primary-light);color:var(--primary);display:flex;justify-content:space-between;">'
      + '<span>Detail Belanja yang Di-reimburse (' + items.length + ' item)</span>'
      + '<span onclick="kasToggleFilter(\'' + tgl + '\',\'reimburse\')" style="cursor:pointer;">&#x2715; Semua</span>'
      + '</div>';
    if (!items.length) {
      h += '<div style="padding:10px 14px;font-size:11px;color:var(--text-muted);">Tidak ada item belanja</div>';
    } else {
      items.forEach(function(b) {
        h += '<div class="proc-row" style="padding:10px 14px;">'
          + '<div style="width:28px;height:28px;border-radius:8px;background:#fef3c7;display:flex;align-items:center;justify-content:center;color:#d97706;"><i class="fas fa-receipt"></i></div>'
          + '<div style="flex:1;min-width:0;">'
          + '<div style="font-size:12px;font-weight:600;">' + esc(b.keterangan || '-') + '</div>'
          + '<div style="font-size:10px;color:var(--text-muted);">' + esc((b.akun||'').toUpperCase()) + ' · ' + esc(String(b.tanggal).slice(0,10)) + '</div>'
          + '</div>'
          + '<div style="font-weight:700;color:var(--danger);white-space:nowrap;font-size:12px;">−' + rupiah(b.nominal) + '</div>'
          + '</div>';
      });
    }
    h += '</div>';
    el.innerHTML = h;
  } catch (e) {
    el.innerHTML = '<div style="padding:10px 14px;font-size:11px;color:var(--danger);">Gagal: ' + e.message + '</div>';
  }
}

function renderMutasiHari(tgl) {
  const list = KAS.expanded && KAS.expanded[tgl];
  if (list === true || list == null) return '<div style="padding:10px 14px;font-size:11px;color:var(--text-muted);">' + spinner() + '</div>';
  if (!list.length) return '<div style="padding:10px 14px;font-size:11px;color:var(--slate-light);">Tidak ada mutasi</div>';

  const activeFilter = _kasFilter && _kasFilter[tgl];
  const filtered = activeFilter ? list.filter(function(m){ return m.jenis_mutasi === activeFilter; }) : list;
  const filterNames = { pendapatan: 'Pendapatan', belanja_ops: 'Belanja', reimburse: 'Reimburse', setor: 'Setor' };

  let filterLabel = '';
  if (activeFilter) {
    filterLabel = '<div style="padding:6px 14px;font-size:10px;background:var(--primary-light);color:var(--primary);display:flex;justify-content:space-between;">'
      + '<span>Filter: ' + (filterNames[activeFilter]||activeFilter) + ' (' + filtered.length + ' item)</span>'
      + '<span onclick="kasToggleFilter(\'' + tgl + '\',\'' + activeFilter + '\')" style="cursor:pointer;">&#x2715; Semua</span>'
      + '</div>';
  }

  let h = '<div style="border-top:1px solid var(--border);">' + filterLabel;
  filtered.forEach(function(m) {
    const ic = mutasiIcon(m);
    const sign = m.jenis === 'keluar' ? '\u2212' : '+';
    h += '<div class="proc-row" style="padding:10px 14px;">'
      + '<div style="width:28px;height:28px;border-radius:8px;background:var(--bg-soft);display:flex;align-items:center;justify-content:center;color:' + ic.col + ';"><i class="fas ' + ic.ic + '"></i></div>'
      + '<div style="flex:1;min-width:0;">'
      + '<div style="font-size:12px;font-weight:600;">' + esc(m.jenis_label) + '</div>'
      + '<div class="pr-sub" style="font-size:10px;">' + esc(m.keterangan || '-') + ' \u00b7 ' + esc((m.akun || '').toUpperCase()) + ' \u00b7 ' + esc(String(m.tanggal).slice(11, 16)) + '</div>'
      + '</div>'
      + '<div style="font-weight:700;color:' + ic.col + ';white-space:nowrap;font-size:12px;">' + sign + rupiah(m.nominal) + '</div>'
      + '</div>';
  });
  h += '</div>';
  return h;
}

async function kasToggleHari(tgl, autoFilter) {
  if (!KAS.expanded) KAS.expanded = {};
  // Kalau sudah expand dan tidak ada autoFilter, collapse
  if (KAS.expanded[tgl] && !autoFilter) { delete KAS.expanded[tgl]; delete _kasFilter[tgl]; renderKas(KAS.data); return; }
  KAS.expanded[tgl] = true; // loading
  renderKas(KAS.data);
  try {
    const res = await api('/kas/mutasi?tanggal=' + tgl);
    KAS.expanded[tgl] = res.data || [];
  } catch (e) { KAS.expanded[tgl] = []; }
  // Setelah data load, apply filter langsung jika ada
  if (autoFilter === 'reimburse') {
    kasShowReimburseDetail(tgl); return;
  } else if (autoFilter) {
    const el = $('kas-hari-' + tgl);
    if (el) el.innerHTML = renderMutasiHari(tgl);
    return;
  }
  renderKas(KAS.data);
}

/* ---- CATAT BELANJA ---- */
async function openBelanjaSheet() {
  openSheet(`<h3><i class="fas fa-cart-shopping"></i> Catat Belanja</h3><div id="belanja-form">${spinner()}</div>`);
  // muat kategori sekali
  if (!KAS.kategori) {
    try { const res = await api('/kas/kategori'); KAS.kategori = res.data || []; }
    catch (e) { $('belanja-form').innerHTML = emptyState('Gagal memuat kategori. ' + e.message, 'fa-triangle-exclamation'); return; }
  }
  BELANJA = { akun: 'cash', coa_id: null };
  $('belanja-form').innerHTML = `
    <div class="field"><label>Sumber Dana</label>
      <div class="svc-variant" style="margin:0;">
        <div class="vr selected" id="bl-cash" onclick="pickBelanjaAkun('cash')"><div class="vr-label"><i class="fas fa-money-bill-wave"></i> Cash</div></div>
        <div class="vr" id="bl-gopay" onclick="pickBelanjaAkun('gopay')"><div class="vr-label"><i class="fas fa-qrcode"></i> Gopay</div></div>
      </div>
    </div>
    <div class="field"><label>Kategori</label>
      <select id="bl-kategori" onchange="setBelanjaKategori(this.value)">
        <option value="">— pilih kategori —</option>
        ${KAS.kategori.map((k) => `<option value="${k.id}">${esc(k.nama)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Nominal</label>
      <input type="number" id="bl-nominal" placeholder="0" min="0" step="500">
    </div>
    <div class="field"><label>Keterangan (opsional)</label>
      <input type="text" id="bl-ket" placeholder="cth: beli detergen 5kg">
    </div>
    ${S.allowBackdate ? `<div class="field"><label>Tanggal (backdate aktif)</label><input type="datetime-local" id="bl-tanggal"></div>` : ''}
    <button class="btn-zl btn-primary-zl" id="btn-belanja" onclick="doBelanja()">Simpan</button>`;
}
var BELANJA = { akun: 'cash', coa_id: null };
function setBelanjaKategori(v) { BELANJA.coa_id = v; }
function pickBelanjaAkun(a) {
  BELANJA.akun = a;
  $('bl-cash').classList.toggle('selected', a === 'cash');
  $('bl-gopay').classList.toggle('selected', a === 'gopay');
}
async function doBelanja() {
  const coa_id = $('bl-kategori').value;
  const nominal = Number($('bl-nominal').value);
  const keterangan = $('bl-ket').value.trim();
  if (!coa_id) { toast('Pilih kategori', 'warning'); return; }
  if (!nominal || nominal <= 0) { toast('Nominal harus lebih dari 0', 'warning'); return; }
  const btn = $('btn-belanja'); btnLoad(btn, true);
  try {
    const tglEl = $('bl-tanggal');
    const tanggal = tglEl && tglEl.value ? tglEl.value.replace('T', ' ') : undefined;
    await api('/kas/belanja', { method: 'POST', body: { akun: BELANJA.akun, coa_id: Number(coa_id), nominal, keterangan, tanggal } });
    closeSheet(); toast('Belanja dicatat', 'success');
    await loadKas();
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}

/* ---- TOP UP GOPAY ---- */
function openTopupSheet() {
  const saldoCash = (KAS.data && KAS.data.saldo) ? KAS.data.saldo.cash : null;
  openSheet(`<h3><i class="fas fa-wallet"></i> Top Up Gopay</h3>
    <div id="topup-form">
      ${saldoCash != null ? `<div class="hint" style="margin-bottom:10px;"><i class="fas fa-money-bill-wave"></i> Saldo Cash: <b>${rupiah(saldoCash)}</b></div>` : ''}
      <div class="field"><label>Nominal Top Up (pokok)</label>
        <input type="number" id="tu-pokok" placeholder="cth: 100000" min="0" step="1000" oninput="tuHitung()">
      </div>
      <div class="field"><label>Biaya Admin (boleh 0)</label>
        <input type="number" id="tu-admin" placeholder="cth: 2500" min="0" step="500" value="0" oninput="tuHitung()">
      </div>
      <div class="card-zl" style="font-size:12px;color:var(--text-muted);">
        <div style="display:flex;justify-content:space-between;"><span>Gopay bertambah</span><b id="tu-gopay" style="color:var(--text);">Rp0</b></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Cash berkurang</span><b id="tu-cash" style="color:var(--danger);">Rp0</b></div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Biaya admin (beban)</span><b id="tu-adm" style="color:var(--text);">Rp0</b></div>
      </div>
      <div class="field"><label>Keterangan (opsional)</label>
        <input type="text" id="tu-ket" placeholder="cth: topup di Indomaret">
      </div>
      ${S.allowBackdate ? `<div class="field"><label>Tanggal (backdate aktif)</label><input type="datetime-local" id="tu-tanggal"></div>` : ''}
      <button class="btn-zl btn-primary-zl" id="btn-topup" onclick="doTopup()"><i class="fas fa-wallet"></i> Top Up</button>
    </div>`);
}
function tuHitung() {
  const pokok = Number($('tu-pokok').value) || 0;
  const admin = Number($('tu-admin').value) || 0;
  $('tu-gopay').textContent = rupiah(pokok);
  $('tu-cash').textContent = rupiah(pokok + admin);
  $('tu-adm').textContent = rupiah(admin);
}
async function doTopup() {
  const pokok = Number($('tu-pokok').value) || 0;
  const admin = Number($('tu-admin').value) || 0;
  const keterangan = $('tu-ket').value.trim();
  if (pokok <= 0) { toast('Nominal top up harus lebih dari 0', 'warning'); return; }
  if (admin < 0) { toast('Biaya admin tidak boleh negatif', 'warning'); return; }
  const btn = $('btn-topup'); btnLoad(btn, true);
  try {
    const tglEl = $('tu-tanggal');
    const tanggal = tglEl && tglEl.value ? tglEl.value.replace('T', ' ') : undefined;
    await api('/kas/topup', { method: 'POST', body: { pokok, admin, keterangan, tanggal } });
    closeSheet(); toast('Top up Gopay berhasil', 'success');
    await loadKas();
  } catch (e) { toast(e.message || 'Gagal top up', 'danger'); btnLoad(btn, false); }
}

/* ---- SETOR ---- */
var SETOR = { transferId: null, idTransfer: null };
async function openSetorSheet() {
  openSheet(`<h3><i class="fas fa-paper-plane"></i> Setor ke Management</h3><div id="setor-body">${spinner()}</div>`);
  try {
    const res = await api('/transfer/preview');
    renderSetorPreview(res.data);
  } catch (e) {
    $('setor-body').innerHTML = emptyState('Gagal memuat rencana setor. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderSetorPreview(d) {
  if (!d.jumlah_belum_setor && !d.total_reimburse) {
    $('setor-body').innerHTML = emptyState('Tidak ada transaksi maupun belanja yang perlu disetor', 'fa-circle-check');
    return;
  }

  const isMinus = (d.nominal_transfer || 0) < 0;
  const nominalAbs = Math.abs(d.nominal_transfer || 0);
  const labelTransfer = isMinus ? 'Diterima dari Management' : 'Transfer ke Management (real)';
  const labelTombol = isMinus ? `Terima ${rupiah(nominalAbs)}` : `Setor ${rupiah(nominalAbs)}`;
  const warnaTransfer = isMinus ? 'var(--success)' : 'var(--primary)';

  let html = `
    <div class="saldo-card" style="margin-bottom:12px;">
      <div class="sc-label">${labelTransfer}</div>
      <div class="sc-total">${rupiah(nominalAbs)}</div>
      <div class="sc-split sc-3">
        <div class="sc-item"><div class="l">Transaksi</div><div class="v">${d.transaksi_dipilih.length}</div></div>
        <div class="sc-item"><div class="l">Cash</div><div class="v">${rupiah(d.saldo_cash)}</div></div>
        <div class="sc-item"><div class="l">Gopay</div><div class="v">${rupiah(d.saldo_gopay)}</div></div>
      </div>
    </div>`;

  if (isMinus) {
    html += `<div class="card-zl" style="font-size:11px;color:var(--text-muted);background:#ecfdf5;">
        <i class="fas fa-circle-info"></i> Belanja yang harus diganti (${rupiah(d.total_reimburse)}) lebih besar dari pendapatan yang tersedia (${rupiah(d.total_pendapatan)}). Management akan transfer selisihnya ke kas kecil saat setor ini dieksekusi.
      </div>`;
  }

  // rincian net-off: pendapatan - penggantian belanja - loyalty = transfer real
  html += `<div class="card-zl" style="font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Setor pendapatan</span><b>${rupiah(d.total_pendapatan)}</b></div>`;
  if (d.total_reimburse > 0) {
    html += `<div style="display:flex;justify-content:space-between;margin-top:6px;"><span style="color:var(--text-muted);">Penggantian belanja (${d.jumlah_belanja})</span><b style="color:var(--success);">− ${rupiah(d.total_reimburse)}</b></div>`;
  }
  if (d.total_loyalty > 0) {
    html += `<div style="display:flex;justify-content:space-between;margin-top:6px;"><span style="color:var(--text-muted);">⭐ Biaya Loyalty (${d.loyalty_items ? d.loyalty_items.length : 0} trx)</span><b style="color:var(--warning);">− ${rupiah(d.total_loyalty)}</b></div>`;
  }
  html += `<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);"><span style="font-weight:700;">${isMinus ? 'Diterima dari management' : 'Transfer real'}</span><b style="color:${warnaTransfer};font-size:15px;">${rupiah(nominalAbs)}</b></div>
    </div>`;

  // info batas & sisa
  html += `<div class="card-zl" style="font-size:12px;color:var(--text-muted);">
      <div style="display:flex;justify-content:space-between;"><span>Batas transfer per setor</span><b style="color:var(--text);">${rupiah(d.cap_per_transfer)}</b></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Total belum disetor</span><b style="color:var(--text);">${rupiah(d.total_belum_setor)}</b></div>`;
  if (d.ada_sisa) {
    html += `<div style="display:flex;justify-content:space-between;margin-top:4px;"><span>Sisa setelah transfer ini</span><b style="color:var(--warning);">${rupiah(d.sisa_setelah_setor)}</b></div>
      <div style="margin-top:8px;color:var(--warning);"><i class="fas fa-circle-info"></i> Masih ada sisa. Klik Setor lagi setelah transfer ini untuk batch berikutnya.</div>`;
  }
  html += `</div>`;

  // penggantian belanja (rincian)
  if (d.belanja_reimburse && d.belanja_reimburse.length) {
    html += `<div class="section-label"><i class="fas fa-receipt"></i> Penggantian belanja</div><div class="card-zl">`;
    d.belanja_reimburse.forEach((b) => {
      html += `<div class="proc-row">
          <div style="flex:1;"><div style="font-size:12px;">${esc(b.keterangan || 'Belanja')}</div></div>
          <div style="font-weight:700;color:var(--success);">${rupiah(b.nominal)}</div>
        </div>`;
    });
    html += `</div>`;
  }

  // biaya loyalty (rincian)
  if (d.loyalty_items && d.loyalty_items.length) {
    html += `<div class="section-label"><i class="fas fa-star"></i> Biaya Loyalty / Redeem Poin</div><div class="card-zl">`;
    d.loyalty_items.forEach((b) => {
      html += `<div class="proc-row">
          <div style="flex:1;"><div style="font-size:12px;">${esc(b.keterangan || 'Redeem poin')}</div></div>
          <div style="font-weight:700;color:var(--warning);">${rupiah(b.nominal)}</div>
        </div>`;
    });
    html += `</div>`;
  }

  // daftar transaksi yang masuk batch
  if (d.transaksi_dipilih.length) {
    html += `<div class="section-label"><i class="fas fa-list-check"></i> Transaksi dalam transfer ini</div><div class="card-zl">`;
    d.transaksi_dipilih.forEach((t) => {
      html += `<div class="proc-row">
          <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${esc(t.no_invoice)}</div></div>
          <div style="font-weight:700;">${rupiah(t.total)}</div>
        </div>`;
    });
    html += `</div>`;
  }

  if (S.allowBackdate) {
    html += `<div class="field" style="margin-top:10px;"><label>Tanggal setor (backdate aktif)</label><input type="date" id="setor-tanggal"></div>`;
  }
  html += `<button class="btn-zl btn-primary-zl" id="btn-setor" onclick="doSetor()"><i class="fas fa-paper-plane"></i> ${labelTombol}</button>`;
  $('setor-body').innerHTML = html;
}

async function doSetor() {
  const btn = $('btn-setor'); btnLoad(btn, true);
  try {
    const tglEl = $('setor-tanggal');
    const tanggal = tglEl && tglEl.value ? tglEl.value : undefined; // YYYY-MM-DD
    const res = await api('/transfer', { method: 'POST', body: tanggal ? { tanggal } : {} });
    SETOR.transferId = res.data.transfer_id;
    SETOR.idTransfer = res.data.id_transfer;
    renderSetorSukses(res.data);
    await loadKas();
  } catch (e) { toast(e.message || 'Gagal setor', 'danger'); btnLoad(btn, false); }
}

function renderSetorSukses(d) {
  $('setor-body').innerHTML = `
    <div class="card-zl" style="text-align:center;">
      <div style="width:54px;height:54px;border-radius:50%;background:var(--success-light);color:var(--success);display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 10px;"><i class="fas fa-check"></i></div>
      <div style="font-size:13px;color:var(--text-muted);">Setoran berhasil</div>
      <div style="font-size:22px;font-weight:800;color:var(--primary);">${rupiah(d.nominal_transfer)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${esc(d.id_transfer)} · ${d.jumlah_transaksi} transaksi</div>
    </div>
    <div class="field"><label>Upload Bukti Transfer (opsional)</label>
      <input type="file" id="setor-bukti" accept="image/*" capture="environment" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:11px;font-family:'Poppins';">
    </div>
    <button class="btn-zl btn-primary-zl" id="btn-bukti" onclick="doUploadBukti()"><i class="fas fa-upload"></i> Simpan Bukti</button>
    <button class="btn-zl btn-light-zl" onclick="closeSheet()" style="margin-top:8px;">Nanti Saja</button>`;
}

async function doUploadBukti() {
  const f = $('setor-bukti').files[0];
  if (!f) { toast('Pilih file bukti dulu', 'warning'); return; }
  const btn = $('btn-bukti'); btnLoad(btn, true);
  try {
    const fd = new FormData(); fd.append('bukti', f);
    const r = await fetch(API + '/transfer/' + SETOR.transferId + '/bukti', {
      method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: fd,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.message) || 'Gagal upload');
    closeSheet(); toast('Bukti tersimpan', 'success');
  } catch (e) { toast(e.message || 'Gagal upload bukti', 'danger'); btnLoad(btn, false); }
}


/* ============================================================
   RIWAYAT
   ============================================================ */
const RW = { filter: 'semua', q: '', offset: 0, limit: 20, items: [], adaLagi: false, timer: null };

function rwSetFilter(f) {
  if (f === 'rekap') RK.tgl = rkHariIni(); // Perubahan #64: buka tab -> rekap hari ini
  RW.filter = f;
  document.querySelectorAll('#rw-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.f === f));
  rwReload();
}
function rwSearch(v) {
  RW.q = v;
  clearTimeout(RW.timer);
  RW.timer = setTimeout(() => rwReload(), 350);
}
function rwReload() {
  // Perubahan #64: tab "Rekap Penjualan" -> tanpa daftar & pencarian
  const rekap = RW.filter === 'rekap';
  const sb = $('rw-search-box'); if (sb) sb.style.display = rekap ? 'none' : '';
  if (rekap) { ++_rwSeq; const body = $('riwayat-body'); if (body) body.innerHTML = ''; loadRekapTerjual(); return; }
  const el = $('rw-rekap'); if (el) el.innerHTML = '';
  RW.offset = 0; RW.items = []; loadRiwayat();
}

/* ---- Perubahan #62/#64: Rekap Penjualan (lunas + belum bayar, semua transaksi pada tanggal dipilih) ---- */
let _rkSeq = 0;
const RK = { tgl: null };
function rkHariIni() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
function rkSetTgl(v) { RK.tgl = v && v <= rkHariIni() ? v : rkHariIni(); loadRekapTerjual(); }
async function loadRekapTerjual() {
  const el = $('rw-rekap'); if (!el) return;
  if (!RK.tgl) RK.tgl = rkHariIni();
  const seq = ++_rkSeq;
  if (!el.querySelector('.rk-wrap')) el.innerHTML = spinner();
  try {
    const d = (await api('/transaksi/rekap-terjual?tanggal=' + RK.tgl)).data;
    if (seq !== _rkSeq || RW.filter !== 'rekap') return;
    const hariIni = d.tanggal === rkHariIni();
    const tglTxt = new Date(d.tanggal + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const angka = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 });
    const jum = (list) => list.reduce((a, x) => a + Number(x.nominal || 0), 0);
    const S3 = [
      { k: 'layanan', lbl: 'Layanan', ico: 'fa-soap' },
      { k: 'laundry', lbl: 'Barang laundry', ico: 'fa-pump-soap' },
      { k: 'cafe', lbl: 'Barang cafe', ico: 'fa-mug-hot' },
    ];
    const belum = d.transaksi - d.lunas;
    el.innerHTML = `<div class="rk-wrap">
      <div class="rk-tgl"><input type="date" id="rk-tgl" value="${d.tanggal}" max="${rkHariIni()}" onchange="rkSetTgl(this.value)">
        ${hariIni ? '' : '<button onclick="rkSetTgl()"><i class="fas fa-calendar-day"></i> Hari ini</button>'}</div>
      <div class="sk-s" style="font-size:11px;color:var(--text-muted);margin:-4px 0 10px;">${hariIni ? 'Hari ini · ' : ''}${tglTxt} · ${d.transaksi} transaksi${belum ? ` (${belum} belum bayar)` : ''}</div>
      <div class="rk-sum">${S3.map((x) => `<div><small><i class="fas ${x.ico}"></i> ${x.lbl}</small><b>${rupiah(jum(d[x.k]))}</b></div>`).join('')}</div>
      <div class="rk-streams">${S3.map((x) => `<div class="rk-card">
          <div class="rk-sh"><i class="fas ${x.ico}"></i> ${x.lbl}<span>${rupiah(jum(d[x.k]))}</span></div>
          ${d[x.k].length ? d[x.k].map((it) => `<div class="rk-r"><span class="n">${esc(it.nama)}</span><span class="q">${angka(it.qty)} ${it.satuan}</span><span class="p">${angka(it.nominal)}</span></div>`).join('')
            : '<div class="rk-kosong">Belum ada penjualan</div>'}
        </div>`).join('')}</div>
      <div class="rk-card rk-total-card">
        ${d.potongan ? `<div class="rk-tot"><span>Total item</span><span>${rupiah(d.total_item)}</span></div><div class="rk-tot"><span>Potongan poin / promo</span><span>-${rupiah(d.potongan)}</span></div>` : ''}
        <div class="rk-tot b"><span>Total penjualan</span><span>${rupiah(d.total)}</span></div>
        <div class="rk-tot"><span>Lunas ${rupiah(d.total_lunas)}</span><span>Belum bayar ${rupiah(d.total_belum)}</span></div>
      </div>
    </div>`;
  } catch (e) {
    if (seq === _rkSeq) el.innerHTML = emptyState('Gagal memuat rekap. ' + (e.message || ''), 'fa-triangle-exclamation');
  }
}

let _rwSeq = 0;
async function loadRiwayat(append = false) {
  const body = $('riwayat-body'); if (!body) return;
  if (!append) body.innerHTML = spinner();
  const seq = ++_rwSeq; // Perubahan #7: abaikan jawaban basi
  try {
    const qs = `?pelanggan=${RW.filter}&limit=${RW.limit}&offset=${RW.offset}` + (RW.q.trim() ? `&q=${encodeURIComponent(RW.q.trim())}` : '');
    const res = await api('/transaksi/riwayat' + qs);
    if (seq !== _rwSeq) return;
    const d = res.data;
    RW.items = append ? RW.items.concat(d.items) : d.items;
    RW.adaLagi = d.ada_lagi;
    renderRiwayat();
  } catch (e) {
    if (seq !== _rwSeq) return;
    body.innerHTML = emptyState('Gagal memuat riwayat. ' + e.message, 'fa-triangle-exclamation');
  }
}

function rwBadgePelanggan(p) {
  if (p.baru) return `<span class="cust-badge cb-baru"><i class="fas fa-star"></i> BARU</span>`;
  return `<span class="cust-badge cb-lama"><i class="fas fa-user-check"></i> Kunjungan ke-${p.kunjungan} · ${p.point} poin</span>`;
}

function renderRiwayat() {
  const body = $('riwayat-body');
  if (!RW.items.length) {
    body.innerHTML = emptyState(RW.q ? 'Tidak ada hasil untuk pencarian itu' : 'Belum ada transaksi hari ini', 'fa-receipt');
    return;
  }
  let html = '';
  RW.items.forEach((t) => {
    const p = t.pelanggan || {};
    const waktu = t.tanggal ? new Date(t.tanggal.replace(' ', 'T') + '+07:00').toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : '';
    html += `
      <div class="order-card" onclick="openOrderDetail(${t.id})">
        <div class="oc-top">
          <div class="oc-inv">${esc(t.no_invoice)}</div>
          ${statusBadge(t.status_kode, t.status_bayar, t.status_nama)}
        </div>
        <div class="oc-nama">${esc(p.nama || '-')}</div>
        <div class="oc-sub">${esc(p.telepon || '')} · ${waktu}</div>
        <div style="margin:6px 0;">${rwBadgePelanggan(p)}</div>
        ${t.layanan ? `<div class="oc-line"><i class="fas fa-box-open"></i> ${esc(t.layanan)}</div>` : ''}
        <div class="oc-bottom">
          <span class="oc-krj">${esc(labelMetode(t.metode_bayar).toUpperCase())} · ${t.status_bayar === 'lunas' ? 'Lunas' : 'Belum bayar'}</span>
          <span class="oc-total">${rupiah(t.total)}</span>
        </div>
      </div>`;
  });
  // tombol muat lebih banyak
  if (RW.adaLagi) {
    html += `<button class="btn-zl btn-light-zl" id="rw-more" onclick="rwMore()" style="margin-top:4px;"><i class="fas fa-chevron-down"></i> Muat lebih banyak</button>`;
  }
  body.innerHTML = html;
}

async function rwMore() {
  RW.offset += RW.limit;
  const btn = $('rw-more'); if (btn) btnLoad(btn, true);
  await loadRiwayat(true);
}


/* ---------- SHORTCUT DASHBOARD ---------- */
async function goPesanan(tab) {
  // Perubahan #7: set tab tujuan DULU, baru buka halaman -> cuma 1 permintaan
  // daftar (dulu navTo() memuat tab LAMA lalu switchPesananTab() memuat tab
  // baru; mana yang jawabannya datang terakhir itu yang tampil -> kadang nyasar).
  PESANAN.tab = PESANAN_KARTU_BY[tab] ? tab : 'belum_bayar';
  document.querySelectorAll('#pesanan-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === PESANAN.tab));
  await navTo('pesanan');
}
async function goRiwayat(filter) {
  RW.filter = filter || 'semua'; RW.q = ''; RW.offset = 0; RW.items = [];
  const s = $('rw-search'); if (s) s.value = '';
  document.querySelectorAll('#rw-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.f === RW.filter));
  await navTo('riwayat'); // navTo sudah memuat daftar (rwReload) -- jangan dobel (Perubahan #7)
}
async function goKas() { await navTo('kas'); }
async function goSetor() { await navTo('kas'); setTimeout(() => openSetorSheet(), 200); }

/* ============================================================
   Perubahan #27 -- ABSENSI KASIR
   - Role kasir: menu lain terkunci sampai absen masuk (server juga menolak
     dengan kode ABSEN_WAJIB). Manager/owner bebas tanpa absen.
   - Absen masuk / pulang wajib dalam radius outlet (cek GPS di server).
   - Riwayat sesi + benefit (lipat / drop-off / antar) + koreksi lupa pulang.
   ============================================================ */
const ABS = { status: null, riwayat: null, bulan: null };

// Perubahan #29b: absensi bisa dimatikan per cabang (cabang.absensi_aktif)
function wajibAbsen() { return !!(S.user && S.user.role === 'kasir' && S.absenAktif); }
function setKunciAbsen(kunci) {
  S.absenKunci = !!kunci;
  document.body.classList.toggle('absen-kunci', S.absenKunci);
}
function terapkanStatusAbsen(d) {
  ABS.status = d;
  S.absenAktif = !!(d && d.absensi_aktif);
  document.body.classList.toggle('absen-wajib', wajibAbsen());
  setKunciAbsen(wajibAbsen() && !d.boleh_akses);
  if (d && d.interval_lokasi_detik) ABS.intervalLokasi = d.interval_lokasi_detik;
}
/** Dipanggil saat masuk app: kasir tanpa sesi aktif -> langsung ke halaman absen. */
async function cekGerbangAbsen() {
  S.absenAktif = false;
  document.body.classList.remove('absen-wajib');
  if (!(S.user && S.user.role === 'kasir')) { setKunciAbsen(false); return true; }
  try {
    const r = await api('/absensi/status');
    terapkanStatusAbsen(r.data);
  } catch (e) {
    // gagal cek: biarkan server yang menentukan (403 ABSEN_WAJIB -> dikunci)
    setKunciAbsen(false);
  }
  if (wajibAbsen() && !S.absenKunci) laporLokasiSekarang();
  muatJatah();
  return !S.absenKunci;
}

/* ---------- Perubahan #39: jatah cuci kasir ---------- */
async function muatJatah() {
  S.jatah = null;
  if (S.user && S.user.role === 'kasir') {
    try { S.jatah = (await api('/absensi/jatah')).data; } catch (e) { S.jatah = null; }
  }
  terapkanNavBenefit();
  return S.jatah;
}
/** Menu bawah: "Absen" kalau absensi aktif; kalau tidak aktif tetap muncul sebagai "Benefit" (khusus jatah cuci). */
function terapkanNavBenefit() {
  const ada = !!(S.jatah && S.jatah.berhak);
  document.body.classList.toggle('ada-jatah', ada);
  const a = document.querySelector('#footer-nav a[data-nav="absensi"]');
  if (a) a.innerHTML = wajibAbsen() ? '<i class="fas fa-fingerprint"></i><span>Absen</span>' : '<i class="fas fa-gift"></i><span>Benefit</span>';
  const t = document.querySelector('#page-absensi .ph-title');
  if (t) t.textContent = wajibAbsen() ? 'Absensi' : 'Benefit';
  const sub = $('abs-sub-head');
  if (sub) sub.textContent = wajibAbsen() ? 'Absen masuk & pulang · benefit' : 'Jatah cuci karyawan';
}
function tglJatah(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function kartuJatahHtml(j) {
  if (!j || !j.berhak) return '';
  const pct = j.nominal ? Math.round((j.sisa / j.nominal) * 100) : 0;
  const rw = (j.riwayat || []).map((r) => `<div class="jt-r" onclick="openOrderDetail(${r.transaksi_id})">
      <span>${esc(tglPendek(r.waktu))} · ${esc(r.no_invoice || '')}<small>${esc(r.layanan || '')}${r.dibayar > 0 ? ` · bayar ${rupiah(r.dibayar)}` : ''}</small></span>
      <b>−${rupiah(r.jatah)}</b></div>`).join('');
  return `<div class="card-zl jt-card">
      <div class="jt-k"><i class="fas fa-id-badge"></i> JATAH CUCI MINGGU INI</div>
      <div class="jt-v">${rupiah(j.sisa)} <small>sisa dari ${rupiah(j.nominal)}</small></div>
      <div class="jt-bar"><i style="width:${pct}%"></i></div>
      <div class="jt-h">${tglJatah(j.minggu_mulai)} – ${tglJatah(j.minggu_akhir)} · sisa hangus Minggu 23:59, jatah baru tiap Senin.</div>
      <div class="jt-h">Pakai lewat <b>Pesankan › Pesan untuk saya</b> (cuci &amp; kering).</div>
    </div>
    <div class="card-zl jt-rw"><div class="jt-rh">Pemakaian minggu ini</div>${rw || '<div class="jt-h">Belum dipakai minggu ini.</div>'}</div>`;
}

/* ---------- Perubahan #30: lapor lokasi berkala -> pulang otomatis ---------- */
let _lokasiTimer = null; let _lokasiJalan = false;
function mulaiLaporLokasi() {
  if (_lokasiTimer) clearInterval(_lokasiTimer);
  const detik = ABS.intervalLokasi || 300;
  _lokasiTimer = setInterval(() => laporLokasiSekarang(), detik * 1000);
}
async function laporLokasiSekarang() {
  if (_lokasiJalan || !S.token || !wajibAbsen() || S.absenKunci || document.visibilityState !== 'visible') return;
  if (!navigator.geolocation) return;
  _lokasiJalan = true;
  try {
    const lok = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, akurasi: p.coords.accuracy }), rej,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }));
    const r = await api('/absensi/lokasi', { method: 'POST', body: lok });
    const d = r.data || {};
    if (d.pulang_otomatis) {
      setKunciAbsen(true); closeSheet();
      toast(`Kamu terdeteksi sudah di luar outlet setelah jadwal selesai. Absen pulang otomatis jam ${jamSaja(d.jam_pulang)}.`, 'warning', 8000);
      navTo('absensi');
    } else if (d.sesi_aktif === false && wajibAbsen()) {
      setKunciAbsen(true); navTo('absensi');
    }
  } catch (e) { /* diam: GPS mati / izin ditolak / jaringan */ }
  _lokasiJalan = false;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') laporLokasiSekarang(); });
mulaiLaporLokasi();

function absenDitolakServer() {
  if (!(S.user && S.user.role === 'kasir')) return;
  if (!S.absenAktif) { S.absenAktif = true; document.body.classList.add('absen-wajib'); }
  const sudah = S.absenKunci && S.currentPage === 'absensi';
  setKunciAbsen(true);
  if (!sudah) {
    closeSheet(); toast('Absen masuk dulu untuk membuka menu kasir', 'warning'); navTo('absensi'); }
}

function ambilLokasi() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('HP / browser ini tidak mendukung lokasi'));
    if (window.isSecureContext === false) return reject(new Error('Lokasi hanya bisa dibaca lewat alamat https://'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, akurasi: p.coords.accuracy }),
      (err) => {
        const pesan = err.code === 1 ? 'Izin lokasi ditolak. Buka pengaturan browser > izinkan Lokasi untuk situs ini, lalu coba lagi.'
          : err.code === 3 ? 'GPS terlalu lama merespon. Pastikan GPS/Lokasi HP menyala, lalu coba lagi.'
          : 'Lokasi belum terbaca. Nyalakan GPS lalu coba lagi.';
        reject(new Error(pesan));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

function jamSaja(s) {
  if (!s) return '-';
  return String(s).slice(11, 16);
}
function tglPendek(s) {
  if (!s) return '-';
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
}
function durasiTeks(m) {
  if (m == null) return '-';
  const j = Math.floor(m / 60); const n = m % 60;
  return j ? `${j}j ${n}m` : `${n}m`;
}
function bulanIni() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function rentangBulan(b) {
  const [y, m] = b.split('-').map(Number);
  const akhir = new Date(y, m, 0).getDate();
  return { dari: `${b}-01`, sampai: `${b}-${String(akhir).padStart(2, '0')}` };
}

async function loadAbsensi() {
  const body = $('absensi-body');
  body.innerHTML = spinner();
  if (!(S.user && S.user.role === 'kasir')) {
    body.innerHTML = `<div class="card-zl abs-info"><i class="fas fa-user-shield"></i> Akun ${esc(S.user && S.user.role)} tidak wajib absen dan bisa langsung memakai semua menu kasir.</div>`;
    return;
  }
  ABS.bulan = ABS.bulan || bulanIni();
  try {
    const [st, rw] = await Promise.all([
      api('/absensi/status'),
      api('/absensi/riwayat?' + new URLSearchParams(rentangBulan(ABS.bulan)).toString()),
    ]);
    terapkanStatusAbsen(st.data); ABS.riwayat = rw.data;
    await muatJatah();
    if (!st.data.absensi_aktif) {
      // Perubahan #39: absensi mati -> halaman Benefit hanya berisi jatah cuci
      body.innerHTML = kartuJatahHtml(S.jatah) || `<div class="card-zl abs-info"><i class="fas fa-circle-info"></i> Absensi tidak aktif di cabang ini. Semua menu kasir bisa langsung dipakai.</div>`;
      return;
    }
    renderAbsensi();
  } catch (e) {
    body.innerHTML = emptyState('Gagal memuat absensi. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderAbsensi() {
  const st = ABS.status || {}; const rw = ABS.riwayat || { sesi: [], benefit: { per_karyawan: [], rincian: [] } };
  const cab = st.cabang || {};
  const sesi = st.sesi;
  let html = '';

  // --- kartu status + tombol absen
  if (sesi) {
    html += `<div class="card-zl abs-card abs-on">
      <div class="abs-state"><span class="abs-dot"></span> Sedang bertugas</div>
      <div class="abs-big">${jamSaja(sesi.jam_masuk)}</div>
      <div class="abs-sub">Masuk ${tglPendek(sesi.jam_masuk)} · ${sesi.jarak_masuk_m != null ? sesi.jarak_masuk_m + ' m dari outlet' : 'lokasi outlet belum diatur'}
        ${Number(sesi.lembur_ganti_shift) ? '<span class="abs-tag abs-tag-lembur">Lembur ganti shift</span>' : ''}</div>
      <label class="abs-cek"><input type="checkbox" id="abs-pulang-lembur"> <span>Pulang terlambat karena lembur</span></label>
      <button class="btn-zl btn-danger-zl" id="btn-abs-pulang" onclick="doAbsen('pulang')"><i class="fas fa-person-walking-arrow-right"></i> Absen Pulang</button>
    </div>`;
  } else {
    html += `<div class="card-zl abs-card">
      <div class="abs-state abs-state-off"><span class="abs-dot"></span> Belum absen masuk</div>
      <div class="abs-sub">Menu kasir terbuka setelah absen masuk. Absen hanya bisa dalam radius <b>${esc(cab.radius_m || 50)} m</b> dari ${esc(cab.nama || 'outlet')}.</div>
      <label class="abs-cek"><input type="checkbox" id="abs-lembur-shift"> <span>Lembur (gantikan shift orang)</span></label>
      <button class="btn-zl btn-primary-zl" id="btn-abs-masuk" onclick="doAbsen('masuk')"><i class="fas fa-fingerprint"></i> Absen Masuk</button>
    </div>`;
  }

  // --- lupa absen pulang
  (st.lupa_pulang || []).forEach((l) => {
    const ks = l.koreksi_status;
    html += `<div class="card-zl abs-lupa">
      <div><b><i class="fas fa-triangle-exclamation"></i> Lupa absen pulang</b><br>
      <span class="abs-sub">Masuk ${tglPendek(l.jam_masuk)} ${jamSaja(l.jam_masuk)}</span></div>
      ${ks === 'menunggu' ? '<span class="abs-tag abs-tag-wait">Koreksi menunggu persetujuan</span>'
        : `<button class="btn-zl btn-light-zl abs-btn-kecil" onclick="bukaKoreksiAbsen(${l.id})">${ks === 'ditolak' ? 'Koreksi ditolak · Ajukan lagi' : 'Ajukan koreksi'}</button>`}
    </div>`;
  });

  html += kartuJatahHtml(S.jatah); // Perubahan #39: jatah cuci (mingguan) di atas ringkasan bulanan

  // --- Perubahan #29: ringkasan benefit & absensi (detail disembunyikan)
  html += `<div class="abs-head-row">
      <div class="abs-h">Ringkasan</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="month" id="abs-bulan" value="${ABS.bulan}" max="${bulanIni()}" onchange="ABS.bulan=this.value||bulanIni();loadAbsensi()">
        <button class="abs-xls" onclick="unduhExcelAbsen()" title="Download Excel"><i class="fas fa-file-excel"></i> Excel</button>
      </div>
    </div>`;
  html += ringkasBenefitHtml(rw.benefit);
  html += ringkasAbsenHtml(rw.rekap, rw.sesi);
  $('absensi-body').innerHTML = html;
}

/* ---------- Perubahan #29: ringkasan benefit / absensi + Excel ---------- */
function ringkasBenefitHtml(ben) {
  const b = (ben && ben.per_karyawan && ben.per_karyawan[0]) || { lipat: 0, drop_off: 0, antar: 0, total: 0, trx_lipat: 0, trx_drop_off: 0, trx_antar: 0, jumlah_order: 0 };
  const rinci = (ben && ben.rincian) || [];
  const baris = [['Lipat', b.trx_lipat, b.lipat], ['Drop-off', b.trx_drop_off, b.drop_off], ['Antar jemput', b.trx_antar, b.antar]];
  let h = `<div class="card-zl abs-tabel abs-sum"><div class="abs-sum-h"><i class="fas fa-hand-holding-dollar"></i> Benefit</div>
    <table><thead><tr><th>Item</th><th style="text-align:center">Transaksi</th><th style="text-align:right">Rupiah</th></tr></thead><tbody>`;
  baris.forEach(([n, t, r]) => { h += `<tr><td>${n}</td><td style="text-align:center">${t || 0}</td><td style="text-align:right">${rupiah(r)}</td></tr>`; });
  h += `<tr class="abs-total"><td>Total</td><td style="text-align:center">${b.jumlah_order || 0} order</td><td style="text-align:right">${rupiah(b.total)}</td></tr></tbody></table>`;
  if (rinci.length) {
    h += `<details class="abs-det"><summary>Lihat rincian (${rinci.length})</summary><table><thead><tr><th>Order</th><th>Peran</th><th style="text-align:right">Benefit</th></tr></thead><tbody>`;
    rinci.forEach((r) => {
      h += `<tr><td>${esc(r.no_invoice)}<div class="abs-muted">${tglPendek(r.waktu)} ${jamSaja(r.waktu)}</div></td>
        <td>${esc(r.peran)}<div class="abs-muted">${Math.round(r.persen * 10) / 10}% × ${rupiah(r.dasar)}</div></td>
        <td style="text-align:right;font-weight:700">${rupiah(r.nilai)}</td></tr>`;
    });
    h += `</tbody></table></details>`;
  }
  return h + `</div>`;
}
function teksLembur(s) {
  return [Number(s.lembur_ganti_shift) ? 'Ganti shift' : '', Number(s.pulang_lembur) ? 'Pulang lembur' : ''].filter(Boolean).join(', ') || '-';
}
function ringkasAbsenHtml(rekap, sesi) {
  const r = (rekap && rekap.saya) || null;
  sesi = sesi || [];
  const jamKerja = sesi.reduce((a, x) => a + (x.durasi_menit || 0), 0);
  const hari = new Set(sesi.map((x) => String(x.jam_masuk).slice(0, 10))).size;
  let h = `<div class="card-zl abs-tabel abs-sum"><div class="abs-sum-h"><i class="fas fa-calendar-check"></i> Absensi</div>
    <div class="abs-sum-grid">
      <div><span>Hari masuk</span><b>${hari}</b></div>
      <div><span>Jam kerja</span><b>${durasiTeks(jamKerja)}</b></div>
      <div><span>Lembur</span><b>${sesi.filter((x) => Number(x.lembur_ganti_shift) || Number(x.pulang_lembur)).length}</b></div>
    </div>`;
  if (rekap && rekap.shift_diatur && r) {
    h += `<table><thead><tr><th>Shift</th><th style="text-align:center">Hadir / Jadwal</th><th style="text-align:center">Telat</th><th style="text-align:center">Absen</th><th style="text-align:center">Luar jadwal</th></tr></thead><tbody>`;
    rekap.shifts.forEach((sh) => {
      const x = r.shift[sh.shift] || {};
      h += `<tr><td>${esc(sh.label)}<div class="abs-muted">${sh.parts.map((p) => esc(p.nama)).join(' · ')}</div></td>
        <td style="text-align:center">${x.hadir || 0} / ${x.dijadwalkan || 0}</td><td style="text-align:center">${x.telat || 0}</td>
        <td style="text-align:center">${x.tidak_hadir || 0}</td><td style="text-align:center">${x.luar_jadwal || 0}</td></tr>`;
    });
    h += `</tbody></table>`;
  }
  if (sesi.length) {
    h += `<details class="abs-det"><summary>Lihat detail (${sesi.length} sesi)</summary><table><thead><tr><th>Tanggal</th><th>Datang</th><th>Pulang</th><th>Durasi</th><th>Lembur</th></tr></thead><tbody>`;
    sesi.forEach((x) => {
      const ex = [Number(x.pulang_dikoreksi) ? '<span class="abs-tag">Dikoreksi</span>' : '',
        Number(x.pulang_otomatis) ? '<span class="abs-tag abs-tag-wait">Pulang otomatis</span>' : '',
        !x.jam_pulang && x.koreksi_status === 'menunggu' ? '<span class="abs-tag abs-tag-wait">Koreksi menunggu</span>' : ''].join('');
      h += `<tr><td>${tglPendek(x.jam_masuk)}${ex ? '<div>' + ex + '</div>' : ''}</td><td>${jamSaja(x.jam_masuk)}</td>
        <td>${x.jam_pulang ? jamSaja(x.jam_pulang) + (x.jam_pulang.slice(0, 10) !== x.jam_masuk.slice(0, 10) ? ' <small>(+1)</small>' : '') : '-'}</td>
        <td>${durasiTeks(x.durasi_menit)}</td><td>${teksLembur(x)}</td></tr>`;
    });
    h += `</tbody></table></details>`;
  } else h += `<div class="abs-muted" style="padding:6px 0">Belum ada absen di bulan ini</div>`;
  return h + `</div>`;
}
function unduhExcelAbsen() {
  if (typeof XLSX === 'undefined') { toast('Library Excel belum dimuat, coba lagi', 'danger'); return; }
  const rw = ABS.riwayat || {}; const ben = rw.benefit || {}; const b = (ben.per_karyawan && ben.per_karyawan[0]) || {};
  const nama = (S.user && S.user.nama) || 'Kasir';
  const ringkas = [['Nama', nama], ['Periode', `${rw.periode.dari} s/d ${rw.periode.sampai}`], [],
    ['BENEFIT', 'Transaksi', 'Rupiah'], ['Lipat', b.trx_lipat || 0, b.lipat || 0], ['Drop-off', b.trx_drop_off || 0, b.drop_off || 0],
    ['Antar jemput', b.trx_antar || 0, b.antar || 0], ['Total', b.jumlah_order || 0, b.total || 0], []];
  const r = rw.rekap && rw.rekap.saya;
  ringkas.push(['ABSENSI', 'Hadir', 'Dijadwalkan', 'Telat', 'Tidak hadir', 'Luar jadwal']);
  if (r) (rw.rekap.shifts || []).forEach((sh) => { const x = r.shift[sh.shift] || {}; ringkas.push([sh.label, x.hadir || 0, x.dijadwalkan || 0, x.telat || 0, x.tidak_hadir || 0, x.luar_jadwal || 0]); });
  const sesi = [['Tanggal', 'Datang', 'Pulang', 'Durasi (menit)', 'Part', 'Lembur', 'Dikoreksi', 'Pulang otomatis']];
  (rw.sesi || []).forEach((x) => sesi.push([String(x.jam_masuk).slice(0, 10), jamSaja(x.jam_masuk), x.jam_pulang ? String(x.jam_pulang).slice(0, 16) : '', x.durasi_menit,
    ((r && r.sesi.find((z) => z.id === x.id)) || { part: [] }).part.join(', '), teksLembur(x), Number(x.pulang_dikoreksi) ? 'ya' : '', Number(x.pulang_otomatis) ? 'ya' : '']));
  const rinci = [['Invoice', 'Waktu', 'Jenis', 'Peran', 'Persen', 'Dasar', 'Benefit']];
  (ben.rincian || []).forEach((x) => rinci.push([x.no_invoice, x.waktu, x.jenis, x.peran, Math.round(x.persen * 10) / 10, x.dasar, x.nilai]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ringkas), 'Ringkasan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sesi), 'Absensi');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rinci), 'Benefit');
  XLSX.writeFile(wb, `Absen_Benefit_${nama.replace(/\s+/g, '_')}_${ABS.bulan}.xlsx`);
}

async function doAbsen(jenis) {
  const btn = $(jenis === 'masuk' ? 'btn-abs-masuk' : 'btn-abs-pulang');
  if (jenis === 'pulang' && !confirm('Absen pulang sekarang? Menu kasir akan terkunci sampai absen masuk lagi.')) return;
  btnLoad(btn, true);
  if (btn) btn.innerHTML = '<i class="fas fa-location-crosshairs fa-spin"></i> Membaca lokasi...';
  try {
    const lok = await ambilLokasi();
    const body = { ...lok };
    if (jenis === 'masuk') body.lembur_ganti_shift = !!($('abs-lembur-shift') || {}).checked;
    else body.pulang_lembur = !!($('abs-pulang-lembur') || {}).checked;
    const r = await api('/absensi/' + jenis, { method: 'POST', body });
    if (jenis === 'masuk') {
      toast(`Absen masuk ${jamSaja(r.data.jam_masuk)} tercatat. Selamat bekerja!`, 'success');
      setKunciAbsen(false);
      if (ABS.status) ABS.status.sudah_masuk = true;
      navTo('dashboard');
    } else {
      toast(`Absen pulang ${jamSaja(r.data.jam_pulang)} tercatat. Terima kasih!`, 'success');
      setKunciAbsen(true);
      loadAbsensi();
    }
  } catch (e) {
    toast(e.message || 'Absen gagal', 'danger', 6000);
    btnLoad(btn, false);
  }
}

function bukaKoreksiAbsen(absensiId) {
  const l = ((ABS.status && ABS.status.lupa_pulang) || []).find((x) => Number(x.id) === Number(absensiId));
  if (!l) return;
  const minV = String(l.jam_masuk).slice(0, 16).replace(' ', 'T');
  openSheet(`
    <h3>Koreksi Absen Pulang</h3>
    <div class="abs-sub" style="margin-bottom:10px;">Masuk ${tglPendek(l.jam_masuk)} jam ${jamSaja(l.jam_masuk)}. Koreksi berlaku setelah disetujui manager/owner.</div>
    <div class="field"><label>Jam pulang sebenarnya</label><input type="datetime-local" id="kor-jam" min="${minV}" value="${minV}"></div>
    <div class="field"><label>Alasan</label><textarea id="kor-alasan" rows="3" placeholder="cth: lupa absen pulang, HP mati"></textarea></div>
    <label class="abs-cek"><input type="checkbox" id="kor-lembur"> <span>Pulang terlambat karena lembur</span></label>
    <button class="btn-zl btn-primary-zl" id="btn-kor" onclick="kirimKoreksiAbsen(${l.id})"><i class="fas fa-paper-plane"></i> Ajukan Koreksi</button>`);
}
async function kirimKoreksiAbsen(absensiId) {
  const btn = $('btn-kor'); btnLoad(btn, true);
  try {
    await api('/absensi/koreksi', { method: 'POST', body: {
      absensi_id: absensiId, jam_pulang: $('kor-jam').value, alasan: $('kor-alasan').value.trim(), pulang_lembur: $('kor-lembur').checked,
    } });
    closeSheet(); toast('Koreksi diajukan, menunggu persetujuan manager', 'success');
    loadAbsensi();
  } catch (e) { toast(e.message, 'danger', 5000); btnLoad(btn, false); }
}

/* ---------- BOOT ---------- */
let _autoRefresh = null;
function startAutoRefresh() {
  if (_autoRefresh) clearInterval(_autoRefresh);
  // refresh ringan tiap 60 detik, hanya kalau di dashboard & tab terlihat & sudah login
  _autoRefresh = setInterval(() => {
    if (S.token && S.currentPage === 'dashboard' && document.visibilityState === 'visible') {
      loadDashboard({ diam: true }); // Perubahan #75
    }
  }, 60000);
}

function boot() {
  loadSession();
  startAutoRefresh();
  if (S.token && S.user) enterApp();
  else showScreen('login');
}
document.addEventListener('DOMContentLoaded', boot);
