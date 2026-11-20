/* ============================================================
   ZLaundry Manager App v2 — app.js
   Tahap 1: Login (JWT) + Dashboard (omzet, transaksi, laba, tren 7h, mesin).
   ============================================================ */
const CFG = window.APP_CONFIG;
const API = CFG.API_BASE;
const $ = (id) => document.getElementById(id);

const S = { token: null, user: null, currentPage: 'dashboard' };
const DASH = { data: null };

/* ---------- sesi (localStorage) ---------- */
function saveSession() {
  try {
    localStorage.setItem(CFG.LS_TOKEN, S.token || '');
    localStorage.setItem(CFG.LS_USER, JSON.stringify(S.user || null));
    localStorage.setItem('zl_manager_backdate', S.allowBackdate ? '1' : '0');
  } catch (e) {}
}
function loadSession() {
  try {
    S.token = localStorage.getItem(CFG.LS_TOKEN) || null;
    const u = localStorage.getItem(CFG.LS_USER);
    S.user = u ? JSON.parse(u) : null;
    S.allowBackdate = localStorage.getItem('zl_manager_backdate') === '1';
  } catch (e) { S.token = null; S.user = null; S.allowBackdate = false; }
}
function clearSession() {
  try { localStorage.removeItem(CFG.LS_TOKEN); localStorage.removeItem(CFG.LS_USER); localStorage.removeItem('zl_manager_backdate'); } catch (e) {}
  S.token = null; S.user = null; S.allowBackdate = false;
}

/* ---------- API helper (auto Bearer) ---------- */
async function api(path, { method = 'GET', body = null, auth = true } = {}) {
  const opt = { method, headers: {} };
  if (auth && S.token) opt.headers['Authorization'] = 'Bearer ' + S.token;
  if (auth && window.OwnerCabang && !CFG.OWNER_MODE) Object.assign(opt.headers, window.OwnerCabang.headers(S.user)); // Perubahan #47
  // Perubahan #47: app owner memakai layar Performa & Customer manager -> tambahkan pilihan cabang
  if (CFG.OWNER_MODE && window.OWNER && /^\/(performa|pelanggan)(\/|\?|$)/.test(path)) path = window.OWNER.denganCabang(path);
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(API + path, opt);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (res.status === 401) { handleExpired(json); throw new Error((json && json.message) || 'Sesi berakhir'); }
  if (!res.ok) throw new Error((json && json.message) || `Error ${res.status}`);
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
/* Perubahan #83: label metode bayar */
const LABEL_METODE = { cash: 'Cash', qris: 'QRIS', kiosk: 'Kios-K' };
function labelMetode(m) { return LABEL_METODE[m] || (m ? String(m).toUpperCase() : '-'); }
function rupiahK(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'jt';
  if (n >= 1000) return Math.round(n / 1000) + 'rb';
  return String(n);
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
      toast('Akun ini tidak punya akses manager', 'danger'); btnLoad(btn, false); return;
    }
    S.token = token; S.user = user; S.allowBackdate = !!(app && app.allow_backdate); saveSession();
    enterApp();
  } catch (e) {
    toast(e.message || 'Login gagal', 'danger');
  } finally { btnLoad(btn, false); }
}
function doLogout() {
  clearSession(); closeSheet(); showScreen('login');
  if (window.OwnerCabang) window.OwnerCabang.terapkan(null);
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
    <div class="section-label"><i class="fas fa-gift"></i> Pengaturan Promo Cuci Gratis</div>
    <div class="card-zl" id="promo-setting-body">${spinner()}</div>
    <button class="btn-zl gp-btn" onclick="GantiPassword.buka()"><i class="fas fa-key"></i> Ganti Password</button>
    <button class="btn-zl btn-danger-zl" onclick="doLogout()"><i class="fas fa-right-from-bracket"></i> Keluar</button>`);
  loadPromoSetting();
}

/* ---------- PENGATURAN PROMO (di sheet Profil) ---------- */
async function loadPromoSetting() {
  const box = $('promo-setting-body'); if (!box) return;
  try {
    const res = await api('/promo/pengaturan');
    renderPromoSetting(res.data);
  } catch (e) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Gagal memuat pengaturan promo. ${esc(e.message || '')}</div>`;
  }
}

function togglePill(r) {
  const label = LABEL_PROMO_LAYANAN[r.jenis_promo] || r.nama_paket;
  const expired = r.aktif && !r.sedang_berjalan;
  let infoTanggal = '';
  if (r.tanggal_mulai || r.tanggal_selesai) {
    const fmt = (t) => t ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '...';
    infoTanggal = `<br><span style="font-size:10px;color:${expired ? 'var(--danger)' : 'var(--text-muted)'};">
      ${expired ? '⚠ Sudah lewat periode: ' : 'Periode: '}${fmt(r.tanggal_mulai)} – ${fmt(r.tanggal_selesai)}
    </span>`;
  }
  return `
    <div class="drow">
      <span class="dl">${esc(label)}<br><span style="font-weight:400;font-size:11px;color:var(--text-muted);">${rupiah(r.harga_normal)} → ${rupiah(r.harga_promo)}</span>${infoTanggal}</span>
      <span class="dv">
        <button data-jenis="${esc(r.jenis_promo)}" onclick="togglePromoSetting('${esc(r.jenis_promo)}')"
          style="border:none;cursor:pointer;padding:6px 14px;border-radius:20px;font-size:11px;font-weight:700;
                 background:${r.aktif ? 'var(--success-light)' : '#f1f5f9'};color:${r.aktif ? 'var(--success)' : 'var(--text-muted)'};"
          data-aktif="${r.aktif ? '1' : '0'}">
          ${r.aktif ? 'AKTIF' : 'NONAKTIF'}
        </button>
      </span>
    </div>`;
}

const LABEL_PROMO_LAYANAN = {
  gratis_cuci_pelanggan_baru: 'Pelanggan Baru',
  gratis_cuci_jumat_berkah: 'Jumat Berkah',
};

function renderPromoSetting(rows) {
  const box = $('promo-setting-body'); if (!box) return;
  if (!rows || rows.length === 0) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Belum ada layanan promo yang di-setup untuk cabang ini. Minta admin tambahkan baris layanan promo dulu (is_promo=1) di database.</div>`;
    return;
  }
  box.innerHTML = rows.map(togglePill).join('');
}

async function togglePromoSetting(jenisPromo) {
  const btn = document.querySelector(`button[data-jenis="${jenisPromo}"]`); if (!btn) return;
  const aktifBaru = btn.dataset.aktif !== '1'; // kebalikan dari kondisi sekarang
  btn.disabled = true;
  try {
    const res = await api('/promo/pengaturan', { method: 'PATCH', body: { jenis_promo: jenisPromo, aktif: aktifBaru } });
    renderPromoSetting(res.data);
    toast(aktifBaru ? 'Promo diaktifkan' : 'Promo dinonaktifkan', 'success');
  } catch (e) {
    toast(e.message || 'Gagal ubah pengaturan', 'danger');
    btn.disabled = false;
  }
}

/* ---------- MASUK APP ---------- */
function enterApp() {
  showScreen('app');
  if (CFG.OWNER_MODE && window.OWNER) { window.OWNER.mulai(); return; } // Perubahan #47: app owner
  if (window.OwnerCabang) window.OwnerCabang.terapkan(S.user, S.token, API); // Perubahan #47: owner pilih cabang
  $('dash-nama').textContent = (S.user && S.user.nama) ? S.user.nama : 'Manager';
  $('dash-outlet').textContent = (S.user && S.user.cabang_nama) ? S.user.cabang_nama : '-';
  navTo('dashboard');
}

/* ---------- NAV ---------- */
function navTo(page) {
  S.currentPage = page;
  document.body.classList.toggle('pg-barang', page === 'barang');
  document.querySelectorAll('.app-page').forEach((p) => p.classList.remove('active'));
  const pg = $('page-' + page); if (pg) pg.classList.add('active');
  document.querySelectorAll('#footer-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === 'dashboard') loadDashboard();
  else if (page === 'karyawan') loadKaryawan();
  else if (page === 'performa') loadPerforma();
  else if (page === 'kasbesar') loadKasBesar();
  else if (page === 'customer') loadCustomer();
  else if (page === 'barang') loadBarang();
  else if (window.OWNER) window.OWNER.nav(page); // Perubahan #47: halaman app owner
  if (window.OWNER && (page === 'performa' || page === 'customer')) window.OWNER.barCabang(page);
}

/* ============================================================
   DASHBOARD
   ============================================================ */
async function loadDashboard(opts = {}) {
  // Perubahan #75: opts.diam = pembaruan latar tiap 1 menit (tanpa spinner, patch tanpa kedip)
  const body = $('dashboard-body');
  const diam = !!opts.diam && !!DASH.data && body && body.children.length > 0;
  if (!diam) body.innerHTML = spinner();
  try {
    const res = await api('/dashboard/manager');
    DASH.data = res.data;
    renderDashboard(res.data, { patch: diam });
  } catch (e) {
    if (!diam) body.innerHTML = emptyState('Gagal memuat dashboard. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderDashboard(d, opt = {}) {
  const o = d.omzet_hari_ini || {};
  const ops = d.operasional || {};
  const lr = d.laba_hari_ini || {};
  let html = '';

  // kartu omzet
  html += `
    <div class="saldo-card" style="margin-bottom:12px;">
      <div class="sc-label">Omzet hari ini</div>
      <div class="sc-total">${rupiah(o.total)}</div>
      <div class="sc-split sc-3 ${o.kiosk ? 'sc-4' : ''}">
        <div class="sc-item"><div class="l"><i class="fas fa-money-bill-wave"></i> Cash</div><div class="v">${rupiahK(o.cash)}</div></div>
        <div class="sc-item"><div class="l"><i class="fas fa-qrcode"></i> Gopay/QRIS</div><div class="v">${rupiahK(o.qris)}</div></div>
        ${o.kiosk ? `<div class="sc-item"><div class="l"><i class="fas fa-tablet-screen-button"></i> Kios-K</div><div class="v">${rupiahK(o.kiosk)}</div></div>` : ''}
        <div class="sc-item"><div class="l"><i class="fas fa-receipt"></i> Transaksi</div><div class="v">${o.jumlah_transaksi || 0}</div></div>
      </div>
    </div>`;

  // kartu bulan ini: omzet (kiri) | laba bersih (kanan)
  const bln = d.bulan_ini || {};
  html += `
    <div class="card-zl" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;">
      <div style="flex:1;text-align:left;">
        <div style="font-size:11px;color:var(--text-muted);">Omzet Bulan Ini</div>
        <div style="font-size:18px;font-weight:800;color:var(--primary);">${rupiah(bln.omzet)}</div>
        <div style="font-size:10px;color:var(--slate-light);">${bln.jumlah_transaksi || 0} transaksi</div>
      </div>
      <div style="width:1px;align-self:stretch;background:var(--border);"></div>
      <div style="flex:1;text-align:right;">
        <div style="font-size:11px;color:var(--text-muted);">Laba Bersih Bulan Ini</div>
        <div style="font-size:18px;font-weight:800;color:${(bln.laba_bersih || 0) >= 0 ? 'var(--success)' : 'var(--danger)'};">${rupiah(bln.laba_bersih)}</div>
      </div>
    </div>`;

  // statistik transaksi
  html += `
    <div class="cust-stat" style="margin-bottom:12px;">
      <div class="cs-box"><div class="cs-num">${o.jumlah_transaksi || 0}</div><div class="cs-lbl">Total</div></div>
      <div class="cs-box cs-proses"><div class="cs-num">${ops.proses || 0}</div><div class="cs-lbl"><i class="fas fa-spinner"></i> Proses</div></div>
      <div class="cs-box cs-siap"><div class="cs-num">${ops.siap || 0}</div><div class="cs-lbl"><i class="fas fa-box"></i> Siap</div></div>
    </div>`;

  // mesin
  html += renderMesinBoard(d.mesin || []);

  // Perubahan #66/#67: grafik transaksi per jam (paling bawah), rentang tanggal bisa dipilih
  html += `<div id="dash-tpj">${opt.patch && TPJ.html ? TPJ.html : ''}</div>`;
  html += `<div style="text-align:center;font-size:11px;color:var(--text-muted);margin:6px 0 4px;"><i class="fas fa-clock"></i> Diperbarui ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · otomatis tiap 1 menit</div>`;

  if (opt.patch) { window.IK3D.patchHtml($('dashboard-body'), html); loadTpjManager({ diam: true }); }
  else { $('dashboard-body').innerHTML = html; loadTpjManager(); }
}

/* ---- Perubahan #66: transaksi per jam (lunas + bayar saat ambil terkonfirmasi), tanggal bisa dipilih ---- */
const TPJ = { dari: null, sampai: null, preset: 'hari', html: '', pemb: null, pembKey: '' };
let _tpjSeq = 0;
function tpjYmd(offsetHari = 0) { return new Date(Date.now() + 7 * 3600000 - offsetHari * 86400000).toISOString().slice(0, 10); }
function tpjPreset(p) {
  TPJ.preset = p;
  if (p === 'hari') { TPJ.dari = TPJ.sampai = tpjYmd(0); }
  else if (p === 'kemarin') { TPJ.dari = TPJ.sampai = tpjYmd(1); }
  else if (p === '7') { TPJ.dari = tpjYmd(6); TPJ.sampai = tpjYmd(0); }
  else if (p === '30') { TPJ.dari = tpjYmd(29); TPJ.sampai = tpjYmd(0); }
  loadTpjManager();
}
function tpjSetTgl() {
  const a = $('tpj-dari').value; const b = $('tpj-sampai').value;
  if (!a || !b) return;
  TPJ.preset = 'custom'; TPJ.dari = a <= b ? a : b; TPJ.sampai = a <= b ? b : a;
  loadTpjManager();
}
async function loadTpjManager(opts = {}) {
  const el = $('dash-tpj'); if (!el) return;
  if (!TPJ.dari) { TPJ.dari = TPJ.sampai = tpjYmd(0); }
  // Perubahan #75: pembaruan latar hanya bila rentang memuat hari ini; garis riwayat (4 minggu) tidak diambil ulang
  const key = `${TPJ.dari}|${TPJ.sampai}`;
  const diam = !!opts.diam && TPJ.html && TPJ.pembKey === key;
  if (diam && TPJ.sampai < tpjYmd(0)) return;
  const seq = ++_tpjSeq;
  try {
    const d = (await api(`/dashboard/transaksi-per-jam?dari=${TPJ.dari}&sampai=${TPJ.sampai}${diam ? '&pembanding=0' : ''}`)).data;
    if (seq !== _tpjSeq) return;
    if (d.pembanding) { TPJ.pemb = d.pembanding; TPJ.pembKey = key; } else d.pembanding = TPJ.pemb;
    const tot = Array(18).fill(0);
    d.per_jam.forEach((r) => { tot[Math.max(0, Number(r.jam) - 6)] += r.jumlah; });
    const iMax = tot.indexOf(Math.max(...tot));
    const hariIni = tpjYmd(0);
    const pres = [['hari', 'Hari ini'], ['kemarin', 'Kemarin'], ['7', '7 hari'], ['30', '30 hari']];
    const tglTxt = (x) => new Date(x + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const satuHari = d.dari === d.sampai;
    const lblGaris = satuHari ? `Rata² 4 ${HARI[new Date(d.dari + 'T00:00:00Z').getUTCDay()]} lalu` : 'Rata² 4 minggu sebelumnya';
    const pb = d.pembanding;
    const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
    const jamNow = satuHari && d.dari === hariIni ? Number(new Date(Date.now() + 7 * 3600000).toISOString().slice(11, 13)) : null;
    const htmlTpj = `<div class="section-label"><i class="fas fa-chart-column"></i> Transaksi per Jam</div>
      <div class="tpj-ctl">
        <div class="tpj-chips">${pres.map(([k, l]) => `<button class="${TPJ.preset === k ? 'on' : ''}" onclick="tpjPreset('${k}')">${l}</button>`).join('')}</div>
        <div class="tpj-tgl"><input type="date" id="tpj-dari" value="${d.dari}" max="${hariIni}" onchange="tpjSetTgl()"><span>s/d</span><input type="date" id="tpj-sampai" value="${d.sampai}" max="${hariIni}" onchange="tpjSetTgl()"></div>
        <div class="tpj-ms">${satuHari ? tglTxt(d.dari) : `${tglTxt(d.dari)} – ${tglTxt(d.sampai)} (${d.hari} hari)`}${d.total ? ` · tersibuk ${String(iMax + 6).padStart(2, '0')}:00 (${tot[iMax]})` : ''}</div>
      </div>
      ${window.IK3D.grafikJam(d.per_jam, {
        jamNow, pembanding: pb ? pb.per_jam : null, labelGaris: lblGaris,
        kiri: `${d.total} transaksi${d.bayar_saat_ambil ? ` (${d.bayar_saat_ambil} bayar saat ambil)` : ''}`,
        kanan: pb ? `${lblGaris} ${fmt(pb.total_rata)}` : '',
      })}`;
    TPJ.html = htmlTpj;
    if (diam) window.IK3D.patchHtml(el, htmlTpj); else el.innerHTML = htmlTpj;
  } catch (e) {
    if (seq === _tpjSeq) el.innerHTML = `<div class="card-zl" style="margin-bottom:12px;font-size:12px;color:var(--text-muted);">Grafik transaksi per jam gagal dimuat. ${esc(e.message)}</div>`;
  }
}

function renderTren(tren) {
  if (!tren.length) return '';
  const max = Math.max(...tren.map((t) => t.omzet), 1);
  let bars = '';
  let labels = '';
  tren.forEach((t, i) => {
    const h = Math.max(4, Math.round((t.omzet / max) * 100));
    const last = i === tren.length - 1;
    const tgl = t.tanggal.slice(8, 10);
    bars += `<div style="flex:1;height:100%;display:flex;align-items:flex-end;">
        <div style="width:100%;background:${last ? 'var(--primary)' : '#b5d4f4'};height:${h}%;border-radius:4px 4px 0 0;min-height:4px;" title="${tglHari(t.tanggal)} · ${rupiah(t.omzet)}"></div>
      </div>`;
    labels += `<div style="flex:1;text-align:center;font-size:9px;color:var(--text-muted);">${tgl}</div>`;
  });
  return `
    <div class="card-zl" style="margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:10px;">Tren omzet 7 hari</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:90px;">${bars}</div>
      <div style="display:flex;gap:6px;margin-top:5px;">${labels}</div>
    </div>`;
}

/* ---------- MESIN BOARD ---------- */
const MESIN_STATUS = {
  running: { txt: 'Jalan', cls: 'mst-run' },
  idle: { txt: 'Idle', cls: 'mst-idle' },
  teralokasi: { txt: 'Teralokasi', cls: 'mst-alloc' },
  maintenance: { txt: 'Maintenance', cls: 'mst-maint' },
  nonaktif: { txt: 'Nonaktif', cls: 'mst-off' },
};

function renderMesinBoard(mesin) {
  if (!mesin.length) return `<div class="section-label"><i class="fas fa-gear"></i> Mesin</div>${emptyState('Belum ada mesin', 'fa-gear')}`;
  const dryer = mesin.filter((m) => m.tipe === 'dryer');
  const washer = mesin.filter((m) => m.tipe === 'washer');
  let html = `<div class="section-label"><i class="fas fa-gear"></i> Mesin</div>`;
  const kol = Math.max(dryer.length, washer.length, 1); // Perubahan #56: 1 baris per jenis
  if (dryer.length) {
    html += `<div class="mesin-grouplbl"><i class="fas fa-wind" style="margin-right:4px;"></i>Dryer</div>`;
    html += `<div class="mz-grid" style="--mz-kol:${kol}">${dryer.map(mesinCard).join('')}</div>`;
  }
  if (washer.length) {
    html += `<div class="mesin-grouplbl" style="margin-top:12px;"><i class="fas fa-soap" style="margin-right:4px;"></i>Washer</div>`;
    html += `<div class="mz-grid" style="--mz-kol:${kol}">${washer.map(mesinCard).join('')}</div>`;
  }
  return html;
}

function mesinCard(m) {
  // Perubahan #56: ikon 3D seragam (shared/ikon3d.css .mz-*), kode singkat D1 (tampilan saja),
  // tanpa baris status terpisah -- warnanya pindah ke label menit / Idle.
  const st = MESIN_STATUS[m.status] || MESIN_STATUS.idle;
  const IK = window.IK3D;
  const usage = m.usage;
  let sub;
  if (m.status === 'running') sub = usage && usage.durasi_menit != null ? usage.durasi_menit + ' mnt' : 'Jalan';
  else if (m.status === 'maintenance') sub = 'Maint.';
  else if (m.status === 'nonaktif') sub = 'Nonaktif';
  else if (m.status === 'teralokasi') sub = 'Alokasi';
  else sub = 'Idle';
  const kls = IK.kelasMesin(m.status);
  const cycleLabel = (m.total_cycle || 0).toLocaleString('id-ID') + ' cy';
  return `
    <div class="mz-card" style="cursor:pointer;" title="${esc(m.kode_mesin)} · ${st.txt}" onclick="openMesinSheet(${m.id},'${esc(m.kode_mesin)}','${m.tipe}','${m.status}','${m.status_raw || ''}','${m.iot_provider || 'bypass'}')">
      <div class="mz-ico ${kls}"><i class="fas fa-${m.tipe === 'dryer' ? 'wind' : 'soap'}"></i></div>
      <div class="mz-kode">${esc(IK.kodeMesin(m.kode_mesin))}</div>
      <div class="mz-bdg ${kls}">${sub}</div>
      <div class="mz-sub">${cycleLabel}</div>
    </div>`;
}

function openMesinSheet(id, kode, tipe, status, statusRaw, iotProvider) {
  const running = status === 'running';
  const icon = tipe === 'dryer' ? 'wind' : 'soap';
  const providerLabel = { tuya: 'Tuya', hallo: 'HalloLaundry', bypass: 'Bypass' };
  const providerColor = { tuya: '#1d4ed8', hallo: '#0f6e56', bypass: '#6b7280' };
  const prov = iotProvider || 'bypass';

  let aksiHtml = `<div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">`;

  // IoT Provider selector
  aksiHtml += `
    <div class="card-zl" style="padding:10px 12px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;"><i class="fas fa-plug"></i> IoT Provider</div>
      <div style="display:flex;gap:8px;">
        ${['tuya','hallo','bypass'].map(p => `
          <button onclick="doSetIotProvider(${id},'${p}','${esc(kode)}')"
            style="flex:1;padding:6px 4px;font-size:11px;font-weight:600;border-radius:8px;border:2px solid ${p===prov?providerColor[p]:'var(--border)'};background:${p===prov?providerColor[p]+'18':'transparent'};color:${p===prov?providerColor[p]:'var(--text-muted)'};cursor:pointer;">
            ${providerLabel[p]}
          </button>`).join('')}
      </div>
    </div>`;

  aksiHtml += `<button class="btn-zl btn-primary-zl" onclick="closeSheet();setTimeout(()=>openTriggerSheet(${id},'${esc(kode)}'),200)">
    <i class="fas fa-bolt"></i> Trigger IoT
  </button>`;

  if (running) {
    aksiHtml += `<button class="btn-zl btn-light-zl" onclick="closeSheet();setTimeout(()=>openSwitchSheet(${id},'${esc(kode)}','${tipe}'),200)">
      <i class="fas fa-right-left"></i> Switch Mesin
    </button>`;
  } else {
    aksiHtml += `<button class="btn-zl btn-light-zl" onclick="closeSheet();setTimeout(()=>openStatusSheet(${id},'${esc(kode)}','${esc(statusRaw)}'),200)">
      <i class="fas fa-screwdriver-wrench"></i> Ubah Status
    </button>`;
  }

  aksiHtml += `</div>`;
  openSheet(`<h3><i class="fas fa-${icon}"></i> ${esc(kode)}</h3>${aksiHtml}`);
}

async function doSetIotProvider(id, provider, kode) {
  try {
    await api(`/mesin/${id}/iot-provider`, { method: 'POST', body: { provider } });
    toast(`IoT provider ${kode} → ${provider}`, 'success');
    loadDashboard();
    // Re-open sheet dengan provider baru
    closeSheet();
  } catch (e) { toast(e.message || 'Gagal ubah provider', 'danger'); }
}

/* ---------- MESIN ACTIONS ---------- */
async function openTriggerSheet(id, kode) {
  openSheet(`<h3><i class="fas fa-bolt"></i> Trigger IoT ${esc(kode)}</h3><div id="trg-body">${spinner()}</div>`);
  try {
    const res = await api(`/mesin/${id}/commands`);
    const d = res.data;
    if (!d.punya_sn) { $('trg-body').innerHTML = emptyState('Mesin ini belum punya SN untuk IoT', 'fa-plug-circle-xmark'); return; }
    if (!d.commands || !d.commands.length) { $('trg-body').innerHTML = emptyState('Tidak ada command terdaftar di mesin ini', 'fa-ban'); return; }
    let html = `<div class="sub" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Pilih command untuk dikirim. Manager menentukan urutannya (mis. matikan dulu, lalu start).</div><div style="display:flex;flex-direction:column;gap:8px;">`;
    d.commands.forEach((c) => {
      html += `<button class="btn-zl btn-light-zl" style="justify-content:flex-start;text-align:left;" onclick="konfirmasiTriggerCmd(${id},'${esc(c)}','${esc(kode)}')"><i class="fas fa-circle-play" style="color:var(--primary);margin-right:8px;"></i> ${esc(c)}</button>`;
    });
    html += '</div>';
    $('trg-body').innerHTML = html;
  } catch (e) {
    $('trg-body').innerHTML = emptyState('Gagal memuat command. ' + e.message, 'fa-triangle-exclamation');
  }
}

/** Step konfirmasi -- wajib isi alasan dulu sebelum command beneran terkirim (audit trail). */
function konfirmasiTriggerCmd(id, command, kode) {
  $('trg-body').innerHTML = `
    <div style="font-size:13px;margin-bottom:12px;">Command <b>${esc(command)}</b> akan dikirim ke <b>${esc(kode)}</b>. Ini akan tercatat di riwayat mesin.</div>
    <label style="font-size:11px;color:var(--text-muted);font-weight:600;">Alasan trigger manual (wajib)</label>
    <textarea id="trg-alasan" placeholder="Contoh: testing setelah ganti sparepart" style="width:100%;min-height:70px;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:'Poppins';font-size:13px;margin:6px 0 12px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-zl btn-light-zl" style="flex:1;" onclick="openTriggerSheet(${id},'${esc(kode)}')">Batal</button>
      <button class="btn-zl btn-primary-zl" style="flex:1;" id="btn-trg-kirim" onclick="doTriggerCmd(${id},'${esc(command)}','${esc(kode)}')"><i class="fas fa-paper-plane"></i> Kirim</button>
    </div>`;
}

async function doTriggerCmd(id, command, kode) {
  const alasan = ($('trg-alasan') ? $('trg-alasan').value : '').trim();
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-trg-kirim'); if (btn) btnLoad(btn, true);
  try {
    await api(`/mesin/${id}/trigger`, { method: 'POST', body: { command, alasan } });
    toast(`Command "${command}" → ${kode} terkirim`, 'success');
    openTriggerSheet(id, kode); // balik ke daftar command, bisa kirim command berikutnya (off lalu start, dst)
  } catch (e) {
    toast(e.message || 'Gagal trigger', 'danger');
    if (btn) btnLoad(btn, false);
  }
}

function openSwitchSheet(id, kode, tipe) {
  const mesin = (DASH.data && DASH.data.mesin) || [];
  // kandidat tujuan: tipe sama, bukan diri sendiri, status idle (aktif & kosong)
  const kandidat = mesin.filter((m) => m.tipe === tipe && m.id !== id && m.status === 'idle');
  let opsi = kandidat.map((m) => `
    <div class="card-zl" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:8px;" onclick="doSwitch(${id},${m.id},'${esc(kode)}','${esc(m.kode_mesin)}')">
      <div class="mc-icon mst-idle"><i class="fas fa-${tipe === 'dryer' ? 'wind' : 'soap'}"></i></div>
      <div style="flex:1;"><div class="mc-kode">${esc(m.kode_mesin)}</div><div class="mc-sub">${(m.total_cycle || 0).toLocaleString('id-ID')} cycle</div></div>
      <i class="fas fa-arrow-right" style="color:var(--primary);"></i>
    </div>`).join('');
  if (!kandidat.length) opsi = emptyState('Tidak ada mesin sejenis yang kosong', 'fa-ban');
  openSheet(`
    <h3><i class="fas fa-right-left"></i> Switch dari ${esc(kode)}</h3>
    <div class="sub" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Pilih mesin tujuan. Transaksi pindah & lanjut dari titik yang sama. ${esc(kode)} tidak otomatis maintenance — ubah statusnya manual setelah ini.</div>
    ${opsi}`);
}

async function doSwitch(dari, ke, kodeDari, kodeKe) {
  if (!confirm(`Pindahkan transaksi dari ${kodeDari} ke ${kodeKe}?`)) return;
  try {
    await api('/mesin/switch', { method: 'POST', body: { dari, ke } });
    closeSheet();
    toast(`Transaksi pindah ${kodeDari} → ${kodeKe}`, 'success');
    loadDashboard();
  } catch (e) { toast(e.message || 'Gagal switch', 'danger'); }
}

function openStatusSheet(id, kode, statusRaw) {
  const opt = (val, label, icon, desc) => `
    <div class="card-zl" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:8px;${statusRaw === val ? 'border-color:var(--primary);' : ''}" onclick="doSetStatus(${id},'${val}','${esc(kode)}')">
      <i class="fas ${icon}" style="font-size:18px;width:24px;text-align:center;"></i>
      <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${label}</div><div style="font-size:11px;color:var(--text-muted);">${desc}</div></div>
      ${statusRaw === val ? '<i class="fas fa-check" style="color:var(--primary);"></i>' : ''}
    </div>`;
  openSheet(`
    <h3><i class="fas fa-screwdriver-wrench"></i> Status ${esc(kode)}</h3>
    ${opt('aktif', 'Idle (aktif)', 'fa-circle-check', 'Siap dipakai')}
    ${opt('maintenance', 'Maintenance', 'fa-screwdriver-wrench', 'Sedang diperbaiki')}
    ${opt('nonaktif', 'Nonaktif', 'fa-ban', 'Tidak digunakan')}`);
}

async function doSetStatus(id, status, kode) {
  try {
    await api(`/mesin/${id}/status`, { method: 'POST', body: { status } });
    closeSheet();
    toast(`Status ${kode} → ${status}`, 'success');
    loadDashboard();
  } catch (e) { toast(e.message || 'Gagal ubah status', 'danger'); }
}

/* ============================================================
   PLACEHOLDER MENU LAIN (tahap berikutnya)
   ============================================================ */
/* ============================================================
   KARYAWAN (CRUD)
   ============================================================ */
const KRY = { items: [], tab: 'daftar' };
const ROLE_OPSI = ['kasir', 'operator', 'kurir'];
const ROLE_LABEL = { kasir: 'Kasir', operator: 'Operator', kurir: 'Kurir' };

async function loadKaryawan() {
  const body = $('karyawan-body'); body.innerHTML = spinner();
  await kryMuatPending(); // Perubahan #31: saklar absensi menentukan tab yang tampil
  if (KRY.tab && KRY.tab !== 'daftar' && KRYB.absensiAktif) return krySetTab(KRY.tab);
  try {
    const res = await api('/karyawan');
    KRY.items = res.data || [];
    renderKaryawan();
  } catch (e) {
    body.innerHTML = emptyState('Gagal memuat karyawan. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderKaryawan() {
  KRY.tab = 'daftar';
  let html = kryTabsHtml() + `<div class="kry-full">${saklarAbsenHtml()}</div>`
    + `<button class="btn-zl btn-primary-zl" onclick="openTambahKaryawan()" style="margin-bottom:14px;"><i class="fas fa-user-plus"></i> Tambah Karyawan</button>`;
  if (!KRY.items.length) {
    html += emptyState('Belum ada karyawan', 'fa-users');
    $('karyawan-body').innerHTML = html;
    return;
  }
  html += KRY.items.map(kryCard).join('');
  $('karyawan-body').innerHTML = html;
}

function kryCard(k) {
  const nonaktif = k.status === 'nonaktif';
  const inisial = (k.nama || '?').trim().slice(0, 1).toUpperCase();
  return `
    <div class="card-zl" style="display:flex;align-items:center;gap:12px;${nonaktif ? 'opacity:.55;' : ''}">
      <div style="width:42px;height:42px;border-radius:50%;background:var(--primary-light);color:var(--primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;">${esc(inisial)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;">${esc(k.nama)}</div>
        <div style="font-size:11px;color:var(--text-muted);">@${esc(k.username)} · ${ROLE_LABEL[k.role] || esc(k.role)}${nonaktif ? ' · nonaktif' : ''}${k.telepon ? ` · ${esc(k.telepon)}` : ''}</div>
        ${k.role === 'kasir' ? `<div style="font-size:10.5px;color:${Number(k.jatah_cuci_mingguan) > 0 ? '#047857' : 'var(--text-muted)'};"><i class="fas fa-id-badge"></i> Jatah cuci ${Number(k.jatah_cuci_mingguan) > 0 ? rupiah(k.jatah_cuci_mingguan) + '/minggu' : 'tidak dapat'}</div>` : ''}
      </div>
      <button class="btn-mesin" style="flex:0 0 auto;padding:7px 12px;" onclick="openKaryawanAksi(${k.id})"><i class="fas fa-ellipsis-vertical"></i></button>
    </div>`;
}

/* ============================================================
   Perubahan #27 -- BENEFIT KARYAWAN & KOREKSI ABSEN
   Tab di halaman Karyawan: [Karyawan] [Benefit] [Koreksi Absen]
   ============================================================ */
const KRYB = { bulan: null, data: null, koreksiStatus: 'menunggu', koreksi: [], pending: 0 };

function kryBulanIni() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function kryRentang(b) {
  const [y, m] = b.split('-').map(Number);
  return { dari: `${b}-01`, sampai: `${b}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}
function kryTabsHtml() {
  if (!KRYB.absensiAktif) return ''; // Perubahan #31: absensi nonaktif -> tanpa tab
  const t = KRY.tab || 'daftar';
  const badge = KRYB.pending ? ` <span class="kry-badge">${KRYB.pending}</span>` : '';
  const b = (k, label) => `<button class="${t === k ? 'active' : ''}" onclick="krySetTab('${k}')">${label}</button>`;
  return `<div class="tabs-zl tabs-zl-6" id="kry-tabs">
    ${b('daftar', 'Karyawan')}${b('jadwal', 'Jadwal')}${b('absensi', 'Absensi')}
    ${b('benefit', 'Benefit')}${b('koreksi', 'Koreksi Absen' + badge)}
  </div>`;
}
function krySetTab(t) {
  if (!KRYB.absensiAktif) t = 'daftar'; // Perubahan #31: absensi nonaktif -> hanya daftar karyawan
  KRY.tab = t;
  if (t === 'daftar') { if (KRY.items && KRY.items.length) renderKaryawan(); else loadKaryawan(); }
  else if (t === 'jadwal') loadJadwal();
  else if (t === 'absensi') loadRekapAbsen();
  else if (t === 'benefit') loadBenefit();
  else loadKoreksiAbsen();
}
async function kryMuatPending() {
  try {
    const st = await api('/absensi/status');
    KRYB.absensiAktif = st.data.absensi_aktif ? 1 : 0;
  } catch (e) { /* abaikan */ }
  try {
    const r = await api('/absensi/koreksi?status=menunggu');
    KRYB.pending = (r.data || []).length;
  } catch (e) { KRYB.pending = 0; }
  const el = $('kry-tabs'); if (el) el.outerHTML = kryTabsHtml();
}
function kryJam(s) { return s ? String(s).slice(11, 16) : '-'; }
function kryTgl(s) {
  if (!s) return '-';
  return new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function loadBenefit() {
  KRYB.bulan = KRYB.bulan || kryBulanIni();
  const body = $('karyawan-body');
  body.innerHTML = kryTabsHtml() + `<div class="kry-full">${spinner()}</div>`;
  try {
    const r = await api('/absensi/benefit?' + new URLSearchParams(kryRentang(KRYB.bulan)).toString());
    KRYB.data = r.data;
    renderBenefit();
  } catch (e) {
    body.innerHTML = kryTabsHtml() + `<div class="kry-full">${emptyState('Gagal memuat benefit. ' + e.message, 'fa-triangle-exclamation')}</div>`;
  }
}
function renderBenefit() {
  const d = KRYB.data || { per_karyawan: [] };
  const rows = d.per_karyawan || [];
  const tot = rows.reduce((a, r) => ({ lipat: a.lipat + r.lipat, drop_off: a.drop_off + r.drop_off, antar: a.antar + r.antar, total: a.total + r.total,
    trx_lipat: a.trx_lipat + (r.trx_lipat || 0), trx_drop_off: a.trx_drop_off + (r.trx_drop_off || 0), trx_antar: a.trx_antar + (r.trx_antar || 0), jumlah_order: a.jumlah_order + r.jumlah_order }),
    { lipat: 0, drop_off: 0, antar: 0, total: 0, trx_lipat: 0, trx_drop_off: 0, trx_antar: 0, jumlah_order: 0 });
  const sel = (rp, n) => `${rupiah(rp)}<div class="kry-muted">${n || 0} trx</div>`;
  let html = `<div class="kry-full">` + kryToolbar('unduhExcelBenefit()') +
    `<div style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px;">Lipat 50% · Drop-off 50% · Antar 80% (beda orang dibagi dua)</div>`;
  if (!rows.length) html += emptyState('Belum ada benefit di bulan ini', 'fa-hand-holding-dollar');
  else {
    html += `<div class="card-zl kry-tabel"><table><thead><tr><th>Karyawan</th><th>Lipat</th><th>Drop-off</th><th>Antar</th><th>Total</th></tr></thead><tbody>`;
    rows.forEach((r) => {
      html += `<tr onclick="bukaRincianBenefit(${r.karyawan_id})" style="cursor:pointer;"><td><b>${esc(r.nama)}</b><div class="kry-muted">${esc(ROLE_LABEL[r.role] || r.role || '')}</div></td>
        <td>${sel(r.lipat, r.trx_lipat)}</td><td>${sel(r.drop_off, r.trx_drop_off)}</td><td>${sel(r.antar, r.trx_antar)}</td><td><b>${rupiah(r.total)}</b><div class="kry-muted">${r.jumlah_order} order</div></td></tr>`;
    });
    html += `<tr class="kry-total"><td>Total</td><td>${sel(tot.lipat, tot.trx_lipat)}</td><td>${sel(tot.drop_off, tot.trx_drop_off)}</td><td>${sel(tot.antar, tot.trx_antar)}</td><td>${rupiah(tot.total)}<div class="kry-muted">${tot.jumlah_order} order</div></td></tr>`;
    html += `</tbody></table></div><div class="kry-muted" style="margin-top:6px;">Klik nama untuk rincian per order.</div>`;
  }
  html += `</div>`;
  $('karyawan-body').innerHTML = kryTabsHtml() + html;
}
async function bukaRincianBenefit(karyawanId) {
  const r0 = ((KRYB.data && KRYB.data.per_karyawan) || []).find((x) => x.karyawan_id === karyawanId) || {};
  openSheet(`<h3>${esc(r0.nama || 'Rincian')}</h3>${spinner()}`);
  try {
    const q = new URLSearchParams({ ...kryRentang(KRYB.bulan), karyawan_id: karyawanId }).toString();
    const r = await api('/absensi/benefit?' + q);
    const rinci = r.data.rincian || [];
    let html = `<h3>${esc(r0.nama || '')}</h3><div class="kry-muted" style="margin-bottom:10px;">${KRYB.bulan}</div>`;
    html += `<div class="kry-tabel"><table><thead><tr><th>Item</th><th style="text-align:center">Transaksi</th><th style="text-align:right">Rupiah</th></tr></thead><tbody>
      <tr><td>Lipat</td><td style="text-align:center">${r0.trx_lipat || 0}</td><td style="text-align:right">${rupiah(r0.lipat)}</td></tr>
      <tr><td>Drop-off</td><td style="text-align:center">${r0.trx_drop_off || 0}</td><td style="text-align:right">${rupiah(r0.drop_off)}</td></tr>
      <tr><td>Antar jemput</td><td style="text-align:center">${r0.trx_antar || 0}</td><td style="text-align:right">${rupiah(r0.antar)}</td></tr>
      <tr class="kry-total"><td>Total</td><td style="text-align:center">${r0.jumlah_order || 0} order</td><td style="text-align:right">${rupiah(r0.total)}</td></tr></tbody></table></div>`;
    html += `<details class="kry-det"><summary>Lihat rincian (${rinci.length})</summary><div class="kry-tabel"><table><thead><tr><th>Order</th><th>Peran</th><th style="text-align:right">Benefit</th></tr></thead><tbody>`;
    rinci.forEach((x) => {
      html += `<tr><td>${esc(x.no_invoice)}<div class="kry-muted">${kryTgl(x.waktu)} ${kryJam(x.waktu)}</div></td>
        <td>${esc(x.peran)}<div class="kry-muted">${Math.round(x.persen * 10) / 10}% × ${rupiah(x.dasar)}</div></td>
        <td style="text-align:right;font-weight:700">${rupiah(x.nilai)}</td></tr>`;
    });
    html += `</tbody></table></div></details>`;
    $('sheet-content').innerHTML = html;
  } catch (e) { $('sheet-content').innerHTML = emptyState(e.message, 'fa-triangle-exclamation'); }
}

async function loadKoreksiAbsen() {
  const body = $('karyawan-body');
  if (KRYB.absensiAktif === undefined) await kryMuatPending();
  if (!KRYB.absensiAktif) { body.innerHTML = kryTabsHtml() + absenNonaktifHtml(); return; }
  body.innerHTML = kryTabsHtml() + `<div class="kry-full">${spinner()}</div>`;
  try {
    const r = await api('/absensi/koreksi?status=' + KRYB.koreksiStatus);
    KRYB.koreksi = r.data || [];
    if (KRYB.koreksiStatus === 'menunggu') KRYB.pending = KRYB.koreksi.length;
    renderKoreksiAbsen();
  } catch (e) {
    body.innerHTML = kryTabsHtml() + `<div class="kry-full">${emptyState('Gagal memuat koreksi. ' + e.message, 'fa-triangle-exclamation')}</div>`;
  }
}
function renderKoreksiAbsen() {
  const semua = KRYB.koreksiStatus === 'semua';
  let html = `<div class="kry-full">
    <div class="tabs-zl" style="margin-bottom:12px;">
      <button class="${!semua ? 'active' : ''}" onclick="KRYB.koreksiStatus='menunggu';loadKoreksiAbsen()">Menunggu</button>
      <button class="${semua ? 'active' : ''}" onclick="KRYB.koreksiStatus='semua';loadKoreksiAbsen()">Semua</button>
    </div>`;
  if (!KRYB.koreksi.length) html += emptyState(semua ? 'Belum ada pengajuan koreksi' : 'Tidak ada koreksi yang menunggu', 'fa-circle-check');
  KRYB.koreksi.forEach((k) => {
    const label = { menunggu: 'Menunggu', disetujui: 'Disetujui', ditolak: 'Ditolak' }[k.status];
    html += `<div class="card-zl kry-kor">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
        <div><b>${esc(k.karyawan_nama)}</b> <span class="kry-muted">${esc(k.cabang_kode)}</span></div>
        <span class="kry-st kry-st-${k.status}">${label}</span>
      </div>
      <div class="kry-kor-jam">
        <div><span>Masuk</span><b>${kryTgl(k.jam_masuk)} ${kryJam(k.jam_masuk)}</b></div>
        <div><span>Usulan pulang</span><b>${kryTgl(k.jam_pulang_usulan)} ${kryJam(k.jam_pulang_usulan)}</b></div>
      </div>
      <div style="font-size:13px;"><i class="fas fa-comment"></i> ${esc(k.alasan)}</div>
      ${Number(k.pulang_lembur) ? '<div class="kry-muted" style="margin-top:4px;"><i class="fas fa-clock"></i> Pulang terlambat karena lembur</div>' : ''}
      ${Number(k.lembur_ganti_shift) ? '<div class="kry-muted"><i class="fas fa-people-arrows"></i> Sesi lembur ganti shift</div>' : ''}
      ${k.status === 'menunggu' ? `<div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn-zl btn-light-zl" onclick="putuskanKoreksiAbsen(${k.id},'tolak',this)"><i class="fas fa-xmark"></i> Tolak</button>
          <button class="btn-zl btn-primary-zl" onclick="putuskanKoreksiAbsen(${k.id},'setuju',this)"><i class="fas fa-check"></i> Setujui</button>
        </div>` : `<div class="kry-muted" style="margin-top:6px;">oleh ${esc(k.diputuskan_nama || '-')} · ${kryTgl(k.diputuskan_at)} ${kryJam(k.diputuskan_at)}</div>`}
    </div>`;
  });
  html += `</div>`;
  $('karyawan-body').innerHTML = kryTabsHtml() + html;
}
async function putuskanKoreksiAbsen(id, keputusan, btn) {
  if (keputusan === 'tolak' && !confirm('Tolak pengajuan koreksi ini?')) return;
  btnLoad(btn, true);
  try {
    await api(`/absensi/koreksi/${id}/putuskan`, { method: 'POST', body: { keputusan } });
    toast(keputusan === 'setuju' ? 'Koreksi disetujui, jam pulang diperbarui' : 'Koreksi ditolak', 'success');
    loadKoreksiAbsen();
  } catch (e) { toast(e.message, 'danger'); btnLoad(btn, false); }
}

/* ============================================================
   Perubahan #29 -- JADWAL SHIFT & REKAP ABSENSI (manager/owner)
   ============================================================ */
const JDW = { data: null };
const NAMA_HARI_PENDEK = ['', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

async function loadJadwal() {
  const body = $('karyawan-body');
  body.innerHTML = kryTabsHtml() + `<div class="kry-full">${spinner()}</div>`;
  try {
    const r = await api('/absensi/jadwal');
    JDW.data = r.data;
    renderJadwal();
  } catch (e) {
    body.innerHTML = kryTabsHtml() + `<div class="kry-full">${emptyState('Gagal memuat jadwal. ' + e.message, 'fa-triangle-exclamation')}</div>`;
  }
}
function renderJadwal() {
  const d = JDW.data;
  KRYB.absensiAktif = d.absensi_aktif ? 1 : 0;
  let html = `<div class="kry-full">`;
  // definisi part shift
  html += `<div class="kry-sec-h"><span>Shift &amp; Part</span><button class="kry-mini" onclick="bukaPart(null)"><i class="fas fa-plus"></i> Part</button></div>`;
  if (!d.parts.length) html += `<div class="card-zl kry-muted" style="font-size:13px;">Shift cabang ini belum diatur. Tambah part (mis. 1A Pagi 06:00–10:00) dulu, lalu isi jadwal.</div>`;
  else {
    html += `<div class="card-zl kry-tabel"><table><thead><tr><th>Shift</th><th>Part</th><th>Jam</th><th>Hari</th><th></th></tr></thead><tbody>`;
    d.parts.forEach((p) => {
      const hari = p.hari_berlaku === '1234567' ? 'Setiap hari' : p.hari_berlaku.split('').map((x) => NAMA_HARI_PENDEK[x]).join(', ');
      html += `<tr><td>Shift ${p.shift}</td><td><b>${esc(p.kode)}</b> ${esc(p.nama)}</td><td>${p.jam_mulai}–${p.jam_selesai}</td><td>${hari}</td>
        <td><button class="kry-mini" onclick="bukaPart(${p.id})"><i class="fas fa-pen"></i></button></td></tr>`;
    });
    html += `</tbody></table></div>`;
    // grid jadwal hari x part
    html += `<div class="kry-sec-h"><span>Jadwal Mingguan</span></div>
      <div class="kry-muted" style="margin:-4px 0 8px;">Perubahan berlaku mulai hari ini (jadwal minggu lalu tetap untuk rekap).</div>
      <div class="card-zl kry-tabel kry-jadwal"><table><thead><tr><th>Hari</th>${d.parts.map((p) => `<th>${esc(p.kode)} ${esc(p.nama)}<div class="kry-muted">${p.jam_mulai}–${p.jam_selesai}</div></th>`).join('')}</tr></thead><tbody>`;
    for (let h = 1; h <= 7; h++) {
      html += `<tr><td><b>${d.hari[h - 1]}</b></td>`;
      d.parts.forEach((p) => {
        if (!p.hari_berlaku.includes(String(h))) { html += `<td class="kry-off"></td>`; return; }
        const sel = d.sel.find((x) => x.hari === h && x.shift_part_id === p.id) || { nama: [] };
        const isi = sel.nama.length ? sel.nama.map((n) => `<span class="kry-chip">${esc(n)}</span>`).join('') : '<span class="kry-chip kosong">— kosong —</span>';
        html += `<td><button class="kry-selbtn" onclick="bukaSelJadwal(${h},${p.id})">${isi}</button></td>`;
      });
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }
  html += `</div>`;
  $('karyawan-body').innerHTML = kryTabsHtml() + html;
}
function bukaSelJadwal(hari, partId) {
  const d = JDW.data; const p = d.parts.find((x) => x.id === partId);
  const sel = d.sel.find((x) => x.hari === hari && x.shift_part_id === partId) || { karyawan_ids: [] };
  const maks = d.maks_per_sel || 3;
  const opsi = d.karyawan.map((k) => `<label class="kry-pilih"><input type="checkbox" value="${k.id}" ${sel.karyawan_ids.includes(Number(k.id)) ? 'checked' : ''} onchange="batasPilihJadwal(this,${maks})"> ${esc(k.nama)}</label>`).join('');
  openSheet(`
    <h3>${esc(d.hari[hari - 1])} · ${esc(p.kode)} ${esc(p.nama)}</h3>
    <div class="kry-muted" style="margin-bottom:10px;">${p.jam_mulai}–${p.jam_selesai} · pilih 1 sampai ${maks} karyawan (kosongkan semua = tidak ada yang bertugas)</div>
    <div id="sel-jadwal">${opsi || '<div class="kry-muted">Belum ada akun kasir di cabang ini.</div>'}</div>
    <button class="btn-zl btn-primary-zl" id="btn-seljdw" style="margin-top:12px;" onclick="simpanSelJadwal(${hari},${partId})"><i class="fas fa-check"></i> Simpan</button>`);
}
function batasPilihJadwal(el, maks) {
  const n = document.querySelectorAll('#sel-jadwal input:checked').length;
  if (n > maks) { el.checked = false; toast(`Maksimal ${maks} karyawan per part`, 'warning'); }
}
async function simpanSelJadwal(hari, partId) {
  const btn = $('btn-seljdw'); btnLoad(btn, true);
  const ids = [...document.querySelectorAll('#sel-jadwal input:checked')].map((x) => Number(x.value));
  try {
    await api('/absensi/jadwal', { method: 'PUT', body: { hari, shift_part_id: partId, karyawan_ids: ids } });
    closeSheet(); toast('Jadwal disimpan', 'success', 1500); loadJadwal();
  } catch (e) { toast(e.message, 'danger'); btnLoad(btn, false); }
}
/* Saklar absensi cabang (Perubahan #29b) */
function saklarAbsenHtml() {
  const on = !!KRYB.absensiAktif;
  return `<div class="card-zl kry-saklar ${on ? 'on' : ''}">
    <div><b>Absensi cabang: ${on ? 'AKTIF' : 'NONAKTIF'}</b>
      <div class="kry-muted">${on ? 'Kasir wajib absen masuk di outlet; pulang otomatis bila lupa.' : 'Kasir langsung memakai semua menu tanpa absen. Benefit tetap dihitung.'}</div></div>
    <button class="kry-mini" onclick="ubahSaklarAbsen(${on ? 0 : 1})">${on ? 'Nonaktifkan' : 'Aktifkan'}</button>
  </div>`;
}
async function ubahSaklarAbsen(v) {
  if (!confirm(v ? 'Aktifkan absensi? Kasir cabang ini harus absen masuk (cek lokasi) untuk memakai menu kasir.' : 'Nonaktifkan absensi? Kasir bisa memakai menu tanpa absen.')) return;
  try {
    await api('/absensi/pengaturan', { method: 'PUT', body: { absensi_aktif: v } });
    KRYB.absensiAktif = v; toast(v ? 'Absensi diaktifkan' : 'Absensi dinonaktifkan', 'success'); krySetTab(KRY.tab);
  } catch (e) { toast(e.message, 'danger'); }
}
function absenNonaktifHtml() {
  return `<div class="kry-full">${saklarAbsenHtml()}${emptyState('Absensi tidak aktif di cabang ini', 'fa-user-clock')}</div>`;
}

function bukaPart(id) {
  const p = id ? JDW.data.parts.find((x) => x.id === id) : { shift: 1, kode: '', nama: '', jam_mulai: '06:00', jam_selesai: '10:00', hari_berlaku: '1234567' };
  const cek = [1, 2, 3, 4, 5, 6, 7].map((h) => `<label class="kry-hari"><input type="checkbox" value="${h}" ${p.hari_berlaku.includes(String(h)) ? 'checked' : ''}> ${NAMA_HARI_PENDEK[h]}</label>`).join('');
  openSheet(`
    <h3>${id ? 'Ubah' : 'Tambah'} Part Shift</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:8px;">
      <div class="field"><label>Shift</label><input type="number" id="pt-shift" min="1" max="9" value="${p.shift}"></div>
      <div class="field"><label>Kode</label><input type="text" id="pt-kode" maxlength="10" value="${esc(p.kode)}" placeholder="1A"></div>
      <div class="field"><label>Nama</label><input type="text" id="pt-nama" maxlength="30" value="${esc(p.nama)}" placeholder="Pagi"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div class="field"><label>Jam mulai</label><input type="text" id="pt-mulai" value="${p.jam_mulai}" placeholder="06:00"></div>
      <div class="field"><label>Jam selesai</label><input type="text" id="pt-selesai" value="${p.jam_selesai}" placeholder="10:00 (24:00 = tengah malam)"></div>
    </div>
    <div class="field"><label>Hari berlaku</label><div id="pt-hari" class="kry-hari-wrap">${cek}</div></div>
    <button class="btn-zl btn-primary-zl" id="btn-pt" onclick="simpanPart(${id || 'null'})"><i class="fas fa-check"></i> Simpan</button>
    ${id ? `<button class="btn-zl btn-light-zl" style="margin-top:8px;color:#b91c1c;" onclick="hapusPart(${id})"><i class="fas fa-trash"></i> Hapus part</button>` : ''}`);
}
async function simpanPart(id) {
  const btn = $('btn-pt'); btnLoad(btn, true);
  const hari = [...document.querySelectorAll('#pt-hari input:checked')].map((x) => x.value).join('');
  const body = { shift: Number($('pt-shift').value), kode: $('pt-kode').value, nama: $('pt-nama').value, jam_mulai: $('pt-mulai').value.trim(), jam_selesai: $('pt-selesai').value.trim(), hari_berlaku: hari };
  try {
    await api('/absensi/shift' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
    closeSheet(); toast('Part shift disimpan', 'success'); loadJadwal();
  } catch (e) { toast(e.message, 'danger'); btnLoad(btn, false); }
}
async function hapusPart(id) {
  if (!confirm('Hapus part ini? Jadwal di part ini tidak dipakai lagi.')) return;
  try { await api('/absensi/shift/' + id, { method: 'DELETE' }); closeSheet(); toast('Part dihapus', 'success'); loadJadwal(); }
  catch (e) { toast(e.message, 'danger'); }
}

/* ---------- Rekap absensi per shift ---------- */
const RKP = { data: null };
async function loadRekapAbsen() {
  KRYB.bulan = KRYB.bulan || kryBulanIni();
  const body = $('karyawan-body');
  if (KRYB.absensiAktif === undefined) await kryMuatPending();
  if (!KRYB.absensiAktif) { body.innerHTML = kryTabsHtml() + absenNonaktifHtml(); return; }
  body.innerHTML = kryTabsHtml() + `<div class="kry-full">${spinner()}</div>`;
  try {
    const r = await api('/absensi/rekap?' + new URLSearchParams(kryRentang(KRYB.bulan)).toString());
    RKP.data = r.data;
    renderRekapAbsen();
  } catch (e) {
    body.innerHTML = kryTabsHtml() + `<div class="kry-full">${emptyState('Gagal memuat rekap. ' + e.message, 'fa-triangle-exclamation')}</div>`;
  }
}
function kryJamTeks(m) { if (!m) return '0j'; const j = Math.floor(m / 60); return j ? `${j}j ${m % 60}m` : `${m}m`; }
function kryLembur(s) { return [Number(s.lembur_ganti_shift) ? 'Ganti shift' : '', Number(s.pulang_lembur) ? 'Pulang lembur' : ''].filter(Boolean).join(', ') || '-'; }
function kryToolbar(onXls) {
  return `<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:10px;">
    <input type="month" class="kry-bulan" value="${KRYB.bulan}" max="${kryBulanIni()}" onchange="KRYB.bulan=this.value||kryBulanIni();krySetTab(KRY.tab)">
    <button class="kry-xls" onclick="${onXls}"><i class="fas fa-file-excel"></i> Excel</button></div>`;
}
function renderRekapAbsen() {
  const d = RKP.data;
  let html = `<div class="kry-full">` + kryToolbar('unduhExcelRekap()');
  if (!d.shift_diatur) html += `<div class="card-zl kry-muted" style="font-size:13px;margin-bottom:10px;">Shift cabang ini belum diatur (tab Jadwal). Rekap per shift belum bisa dihitung; jam kerja tetap tampil.</div>`;
  if (!d.per_karyawan.length) html += emptyState('Belum ada absen / jadwal di bulan ini', 'fa-calendar-xmark');
  else {
    html += `<div class="card-zl kry-tabel"><table><thead><tr><th>Nama</th>${d.shifts.map((s) => `<th style="text-align:center">${esc(s.label)}</th>`).join('')}<th style="text-align:center">Jam kerja</th></tr></thead><tbody>`;
    d.per_karyawan.forEach((o) => {
      html += `<tr onclick="bukaRekapKaryawan(${o.karyawan_id})" style="cursor:pointer;"><td><b>${esc(o.nama)}</b><div class="kry-muted">${o.hari_masuk} hari${o.lupa_pulang ? ` · <span style="color:#b45309">${o.lupa_pulang} lupa pulang</span>` : ''}${o.pulang_otomatis ? ` · <span style="color:#b45309">${o.pulang_otomatis} pulang otomatis</span>` : ''}</div></td>`;
      d.shifts.forEach((s) => {
        const x = o.shift[s.shift] || {};
        const ket = [x.telat ? `<span class="kry-k-telat">${x.telat} telat</span>` : '', x.tidak_hadir ? `<span class="kry-k-absen">${x.tidak_hadir} absen</span>` : '', x.luar_jadwal ? `<span class="kry-k-luar">+${x.luar_jadwal} ganti</span>` : ''].filter(Boolean).join(' ');
        html += `<td style="text-align:center">${x.dijadwalkan || x.luar_jadwal ? `<b>${x.hadir || 0}/${x.dijadwalkan || 0}</b>${ket ? `<div>${ket}</div>` : ''}` : '<span class="kry-muted">-</span>'}</td>`;
      });
      html += `<td style="text-align:center">${kryJamTeks(o.jam_kerja_menit)}</td></tr>`;
    });
    html += `</tbody></table></div><div class="kry-muted" style="margin-top:6px;">Angka = part hadir / part dijadwalkan. Hadir bila ≥ ${d.aturan.ambang_hadir_persen}% jam part; telat bila datang > ${d.aturan.toleransi_telat_menit} menit. Klik nama untuk detail.</div>`;
  }
  html += `</div>`;
  $('karyawan-body').innerHTML = kryTabsHtml() + html;
}
function bukaRekapKaryawan(id) {
  const d = RKP.data; const o = d.per_karyawan.find((x) => x.karyawan_id === id); if (!o) return;
  const ST = { hadir: 'Hadir', telat: 'Telat', tidak_hadir: 'Tidak hadir', luar_jadwal: 'Luar jadwal', berjalan: 'Berjalan' };
  let html = `<h3>${esc(o.nama)}</h3><div class="kry-muted" style="margin-bottom:10px;">${KRYB.bulan} · ${o.hari_masuk} hari · ${kryJamTeks(o.jam_kerja_menit)} · lembur ganti shift ${o.lembur_ganti_shift} · pulang lembur ${o.pulang_lembur}</div>`;
  if (d.shift_diatur) {
    html += `<div class="kry-tabel"><table><thead><tr><th>Part</th><th style="text-align:center">Hadir/Jadwal</th></tr></thead><tbody>`;
    d.shifts.forEach((s) => {
      const x = o.shift[s.shift] || { part: {} };
      s.parts.forEach((p) => {
        const pp = x.part[p.kode] || { dijadwalkan: 0, hadir: 0 };
        html += `<tr><td>${esc(s.label)} · <b>${esc(p.kode)}</b> ${esc(p.nama)}</td><td style="text-align:center">${pp.hadir}/${pp.dijadwalkan}</td></tr>`;
      });
    });
    html += `</tbody></table></div>`;
  }
  html += `<details class="kry-det"><summary>Detail absen (${o.sesi.length} sesi)</summary><div class="kry-tabel"><table><thead><tr><th>Tanggal</th><th>Datang</th><th>Pulang</th><th>Durasi</th><th>Part</th><th>Lembur</th></tr></thead><tbody>`;
  o.sesi.forEach((s) => {
    html += `<tr><td>${kryTgl(s.jam_masuk)}${Number(s.pulang_dikoreksi) ? '<div class="kry-muted">dikoreksi</div>' : ''}${Number(s.pulang_otomatis) ? '<div class="kry-muted" style="color:#b45309">pulang otomatis</div>' : ''}</td><td>${kryJam(s.jam_masuk)}</td>
      <td>${s.jam_pulang ? kryJam(s.jam_pulang) : (s.status_sesi === 'aktif' ? '<span class="kry-muted">bertugas</span>' : '<span style="color:#b45309">lupa</span>')}</td>
      <td>${s.durasi_menit != null ? kryJamTeks(s.durasi_menit) : '-'}</td><td>${s.part.join(', ') || '-'}</td><td>${kryLembur(s)}</td></tr>`;
  });
  html += `</tbody></table></div></details>`;
  if (o.detail.length) {
    html += `<details class="kry-det"><summary>Detail per part (${o.detail.length})</summary><div class="kry-tabel"><table><thead><tr><th>Tanggal</th><th>Part</th><th>Status</th></tr></thead><tbody>`;
    o.detail.forEach((x) => {
      const ket = x.status === 'telat' ? ` ${x.menit_telat} mnt` : x.status === 'luar_jadwal' && x.menggantikan_nama ? ` (ganti ${esc(x.menggantikan_nama)})` : '';
      html += `<tr><td>${kryTgl(x.tanggal)}</td><td>${esc(x.kode)} ${esc(x.nama_part)}</td><td><span class="kry-ps kry-ps-${x.status}">${ST[x.status]}</span>${ket}</td></tr>`;
    });
    html += `</tbody></table></div></details>`;
  }
  openSheet(html);
}
function unduhExcelRekap() {
  if (typeof XLSX === 'undefined') { toast('Library Excel belum dimuat', 'danger'); return; }
  const d = RKP.data; if (!d) return;
  const ST = { hadir: 'Hadir', telat: 'Telat', tidak_hadir: 'Tidak hadir', luar_jadwal: 'Luar jadwal', berjalan: 'Berjalan' };
  const s1 = [['Nama', 'Hari masuk', 'Jam kerja (menit)', ...d.shifts.flatMap((s) => [`${s.label} hadir`, `${s.label} jadwal`, `${s.label} telat`, `${s.label} absen`, `${s.label} luar jadwal`]), 'Lembur ganti shift', 'Pulang lembur', 'Lupa pulang', 'Pulang otomatis']];
  d.per_karyawan.forEach((o) => s1.push([o.nama, o.hari_masuk, o.jam_kerja_menit,
    ...d.shifts.flatMap((s) => { const x = o.shift[s.shift] || {}; return [x.hadir || 0, x.dijadwalkan || 0, x.telat || 0, x.tidak_hadir || 0, x.luar_jadwal || 0]; }),
    o.lembur_ganti_shift, o.pulang_lembur, o.lupa_pulang, o.pulang_otomatis]));
  const s2 = [['Nama', 'Tanggal', 'Datang', 'Pulang', 'Durasi (menit)', 'Part', 'Lembur', 'Dikoreksi', 'Pulang otomatis']];
  d.per_karyawan.forEach((o) => o.sesi.forEach((s) => s2.push([o.nama, s.tanggal, String(s.jam_masuk).slice(11, 16), s.jam_pulang ? String(s.jam_pulang).slice(0, 16) : (s.status_sesi === 'aktif' ? 'bertugas' : 'lupa pulang'), s.durasi_menit, s.part.join(', '), kryLembur(s), Number(s.pulang_dikoreksi) ? 'ya' : '', Number(s.pulang_otomatis) ? 'ya' : ''])));
  const s3 = [['Nama', 'Tanggal', 'Hari', 'Part', 'Jam', 'Status', 'Menit telat', 'Menggantikan']];
  d.per_karyawan.forEach((o) => o.detail.forEach((x) => s3.push([o.nama, x.tanggal, x.hari, `${x.kode} ${x.nama_part}`, x.jam, ST[x.status], x.menit_telat || '', x.menggantikan_nama || ''])));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Ringkasan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Absensi');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s3), 'Per Part');
  XLSX.writeFile(wb, `Rekap_Absensi_${KRYB.bulan}.xlsx`);
}
async function unduhExcelBenefit() {
  if (typeof XLSX === 'undefined') { toast('Library Excel belum dimuat', 'danger'); return; }
  try {
    const r = await api('/absensi/benefit?' + new URLSearchParams({ ...kryRentang(KRYB.bulan), semua_rincian: 1 }).toString());
    const rows = r.data.per_karyawan || [];
    const s1 = [['Nama', 'Trx lipat', 'Lipat (Rp)', 'Trx drop-off', 'Drop-off (Rp)', 'Trx antar', 'Antar (Rp)', 'Jumlah order', 'Total (Rp)']];
    rows.forEach((x) => s1.push([x.nama, x.trx_lipat, x.lipat, x.trx_drop_off, x.drop_off, x.trx_antar, x.antar, x.jumlah_order, x.total]));
    const nama = new Map(rows.map((x) => [x.karyawan_id, x.nama]));
    const s2 = [['Nama', 'Invoice', 'Waktu', 'Jenis', 'Peran', 'Persen', 'Dasar (Rp)', 'Benefit (Rp)']];
    (r.data.rincian || []).forEach((x) => s2.push([nama.get(x.karyawan_id) || x.karyawan_id, x.no_invoice, x.waktu, x.jenis, x.peran, Math.round(x.persen * 10) / 10, x.dasar, x.nilai]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Ringkasan');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Rincian');
    XLSX.writeFile(wb, `Benefit_${KRYB.bulan}.xlsx`);
  } catch (e) { toast(e.message, 'danger'); }
}

function kryById(id) { return KRY.items.find((k) => k.id === id); }

function openKaryawanAksi(id) {
  const k = kryById(id); if (!k) return;
  const nonaktif = k.status === 'nonaktif';
  openSheet(`
    <h3>${esc(k.nama)}</h3>
    <div class="sub" style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">@${esc(k.username)} · ${ROLE_LABEL[k.role] || esc(k.role)}</div>
    <button class="btn-zl btn-light-zl" style="justify-content:flex-start;margin-bottom:8px;" onclick="openEditKaryawan(${id})"><i class="fas fa-pen" style="margin-right:8px;"></i> Edit nama, role & HP</button>
    <button class="btn-zl btn-light-zl" style="justify-content:flex-start;margin-bottom:8px;" onclick="openResetPassword(${id})"><i class="fas fa-key" style="margin-right:8px;"></i> Reset password</button>
    <button class="btn-zl ${nonaktif ? 'btn-primary-zl' : 'btn-danger-zl'}" style="justify-content:flex-start;" onclick="doUbahStatus(${id},'${nonaktif ? 'aktif' : 'nonaktif'}')"><i class="fas fa-${nonaktif ? 'circle-check' : 'ban'}" style="margin-right:8px;"></i> ${nonaktif ? 'Aktifkan' : 'Nonaktifkan'}</button>`);
}

function roleSelectHtml(selected) {
  return `<select id="kry-role" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
    ${ROLE_OPSI.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
  </select>`;
}

function openTambahKaryawan() {
  openSheet(`
    <h3><i class="fas fa-user-plus"></i> Tambah Karyawan</h3>
    <div class="field"><label>Nama</label><input type="text" id="kry-nama" placeholder="Nama lengkap"></div>
    <div class="field"><label>Username</label><input type="text" id="kry-username" placeholder="username" autocapitalize="off"></div>
    <div class="field"><label>Role</label>${roleSelectHtml('kasir')}</div>
    <div class="field"><label>Password</label><input type="text" id="kry-password" placeholder="minimal 6 karakter"></div>
    <button class="btn-zl btn-primary-zl" id="btn-kry-simpan" onclick="doTambahKaryawan()"><i class="fas fa-check"></i> Simpan</button>`);
}

async function doTambahKaryawan() {
  const nama = $('kry-nama').value.trim();
  const username = $('kry-username').value.trim();
  const role = $('kry-role').value;
  const password = $('kry-password').value;
  if (!nama || !username || !password) { toast('Lengkapi semua field', 'warning'); return; }
  const btn = $('btn-kry-simpan'); btnLoad(btn, true);
  try {
    await api('/karyawan', { method: 'POST', body: { nama, username, role, password } });
    closeSheet(); toast('Karyawan ditambahkan', 'success');
    loadKaryawan();
  } catch (e) { toast(e.message || 'Gagal menambah', 'danger'); btnLoad(btn, false); }
}

function openEditKaryawan(id) {
  const k = kryById(id); if (!k) return;
  openSheet(`
    <h3><i class="fas fa-pen"></i> Edit Karyawan</h3>
    <div class="field"><label>Nama</label><input type="text" id="kry-nama" value="${esc(k.nama)}"></div>
    <div class="field"><label>Username</label><input type="text" value="@${esc(k.username)}" disabled style="opacity:.6;"></div>
    <div class="field"><label>Role</label>${roleSelectHtml(k.role)}</div>
    <div class="field"><label>Nomor HP</label><input type="tel" id="kry-hp" inputmode="tel" placeholder="08xxxxxxxxxx" value="${esc(k.telepon || '')}"></div>
    ${k.role === 'kasir' ? (S.user && S.user.role === 'owner'
      ? `<div class="field"><label><i class="fas fa-crown"></i> Jatah cuci per minggu (Rp) — 0 = tidak dapat</label><input type="text" id="kry-jatah" inputmode="numeric" value="${Number(k.jatah_cuci_mingguan == null ? 20000 : k.jatah_cuci_mingguan)}"></div>`
      : `<div class="field"><label>Jatah cuci per minggu</label><input type="text" value="${Number(k.jatah_cuci_mingguan) > 0 ? rupiah(k.jatah_cuci_mingguan) : 'Tidak dapat'} · diatur owner" disabled style="opacity:.6;"></div>`) : ''}
    <button class="btn-zl btn-primary-zl" id="btn-kry-edit" onclick="doEditKaryawan(${id})"><i class="fas fa-check"></i> Simpan</button>`);
}

async function doEditKaryawan(id) {
  const nama = $('kry-nama').value.trim();
  const role = $('kry-role').value;
  if (!nama) { toast('Nama wajib diisi', 'warning'); return; }
  const btn = $('btn-kry-edit'); btnLoad(btn, true);
  try {
    const telepon = $('kry-hp') ? $('kry-hp').value.trim() : undefined;
    const jatah = $('kry-jatah') ? $('kry-jatah').value.replace(/[^\d]/g, '') : undefined; // Perubahan #46: hanya owner
    await api(`/karyawan/${id}`, { method: 'PATCH', body: { nama, role, telepon, ...(jatah !== undefined ? { jatah_cuci_mingguan: jatah === '' ? 0 : jatah } : {}) } });
    closeSheet(); toast('Karyawan diperbarui', 'success');
    loadKaryawan();
  } catch (e) { toast(e.message || 'Gagal edit', 'danger'); btnLoad(btn, false); }
}

function openResetPassword(id) {
  const k = kryById(id); if (!k) return;
  openSheet(`
    <h3><i class="fas fa-key"></i> Reset Password</h3>
    <div class="sub" style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">${esc(k.nama)} · @${esc(k.username)}</div>
    <div class="field"><label>Password baru</label><input type="text" id="kry-newpass" placeholder="minimal 6 karakter"></div>
    <button class="btn-zl btn-primary-zl" id="btn-kry-reset" onclick="doResetPassword(${id})"><i class="fas fa-check"></i> Reset</button>`);
}

async function doResetPassword(id) {
  const password = $('kry-newpass').value;
  if (!password || password.length < 6) { toast('Password minimal 6 karakter', 'warning'); return; }
  const btn = $('btn-kry-reset'); btnLoad(btn, true);
  try {
    await api(`/karyawan/${id}/reset-password`, { method: 'POST', body: { password } });
    closeSheet(); toast('Password direset', 'success');
  } catch (e) { toast(e.message || 'Gagal reset', 'danger'); btnLoad(btn, false); }
}

async function doUbahStatus(id, status) {
  try {
    await api(`/karyawan/${id}/status`, { method: 'PATCH', body: { status } });
    closeSheet(); toast(`Karyawan ${status === 'aktif' ? 'diaktifkan' : 'dinonaktifkan'}`, 'success');
    loadKaryawan();
  } catch (e) { toast(e.message || 'Gagal ubah status', 'danger'); }
}
/* ============================================================
   PERFORMA
   ============================================================ */
const PERF = { tab: 'ringkasan', periode: 8, mode: 'harian', data: null, chart: null, chart2: null, chart3: null, chart4: null };

function loadPerforma() {
  const body = $('performa-body');
  body.innerHTML = `
    <div class="tabs-zl" id="perf-tab" style="margin-bottom:10px;">
      <button class="${PERF.tab === 'ringkasan' ? 'active' : ''}" onclick="perfSetTab('ringkasan')">Ringkasan</button>
      <button class="${PERF.tab === 'pelanggan' ? 'active' : ''}" onclick="perfSetTab('pelanggan')">Pelanggan</button>
      <button class="${PERF.tab === 'produk' ? 'active' : ''}" onclick="perfSetTab('produk')">Produk</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center;">
      <div class="tabs-zl" id="perf-periode" style="flex:1;margin:0;">
        <button class="${PERF.mode === 'harian' && PERF.periode === 8 ? 'active' : ''}" onclick="perfSetPeriode(8)">8 Hari</button>
        <button class="${PERF.mode === 'harian' && PERF.periode === 30 ? 'active' : ''}" onclick="perfSetPeriode(30)">30 Hari</button>
      </div>
      <select id="perf-mode" onchange="perfSetMode(this.value)" style="border:1px solid var(--border);border-radius:10px;padding:9px 12px;font-size:13px;font-family:'Poppins';background:#fff;color:var(--text);">
        <option value="harian" ${PERF.mode === 'harian' ? 'selected' : ''}>Harian</option>
        <option value="mingguan" ${PERF.mode === 'mingguan' ? 'selected' : ''}>Mingguan</option>
        <option value="bulanan" ${PERF.mode === 'bulanan' ? 'selected' : ''}>Bulanan</option>
      </select>
    </div>
    <div id="perf-content">${spinner()}</div>`;
  perfReload();
}

function perfSetTab(t) {
  PERF.tab = t;
  const idx = { ringkasan: 0, pelanggan: 1, produk: 2 }[t];
  document.querySelectorAll('#perf-tab button').forEach((b, i) => b.classList.toggle('active', i === idx));
  perfReload();
}

function perfSetPeriode(p) {
  PERF.periode = p; PERF.mode = 'harian';
  const sel = $('perf-mode'); if (sel) sel.value = 'harian';
  document.querySelectorAll('#perf-periode button').forEach((b, i) => b.classList.toggle('active', (i === 0) === (p === 8)));
  perfReload();
}

function perfSetMode(m) {
  PERF.mode = m;
  // kalau pilih mingguan/bulanan, toggle 7/30 jadi non-aktif
  if (m !== 'harian') document.querySelectorAll('#perf-periode button').forEach((b) => b.classList.remove('active'));
  else document.querySelectorAll('#perf-periode button').forEach((b, i) => b.classList.toggle('active', (i === 0) === (PERF.periode === 8)));
  perfReload();
}

function perfDestroyCharts() {
  if (PERF.chart) { PERF.chart.destroy(); PERF.chart = null; }
  if (PERF.chart2) { PERF.chart2.destroy(); PERF.chart2 = null; }
  if (PERF.chart3) { PERF.chart3.destroy(); PERF.chart3 = null; }
  if (PERF.chart4) { PERF.chart4.destroy(); PERF.chart4 = null; }
}

async function perfReload() {
  const box = $('perf-content'); if (box) box.innerHTML = spinner();
  perfDestroyCharts();
  try {
    if (PERF.tab === 'pelanggan') {
      const res = await api(`/performa/pelanggan?periode=${PERF.periode}&mode=${PERF.mode}`); // Perubahan #70
      PERF.data = res.data; renderPerfPelanggan();
    } else if (PERF.tab === 'produk') {
      const res = await api(`/performa/produk?periode=${PERF.periode}`);
      PERF.data = res.data; renderPerfProduk();
    } else {
      const res = await api(`/performa/ringkasan?periode=${PERF.periode}&mode=${PERF.mode}`);
      PERF.data = res.data; renderPerforma();
    }
  } catch (e) {
    if (box) box.innerHTML = emptyState('Gagal memuat performa. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderPerforma() {
  const d = PERF.data; const r = d.ringkas || {};
  let html = `
    <div class="mini-stat" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
      <div class="card-zl" style="padding:10px;">
        <div style="font-size:10px;color:var(--text-muted);">Total Omzet</div>
        <div style="font-size:15px;font-weight:800;color:var(--primary);">${rupiahK(r.total_omzet)}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">${d.mode==='harian'?d.periode+' hari':(d.mode==='mingguan'?d.periode+' minggu':d.periode+' bulan')}</div>
      </div>
      <div class="card-zl" style="padding:10px;">
        <div style="font-size:10px;color:var(--text-muted);">Rata-rata / ${d.mode==='mingguan'?'minggu':(d.mode==='bulanan'?'bulan':'hari')}</div>
        <div style="font-size:15px;font-weight:800;">${rupiahK(r.rata_omzet_harian)}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">${r.total_transaksi} transaksi</div>
      </div>
      <div class="card-zl" style="padding:10px;">
        <div style="font-size:10px;color:var(--text-muted);">Non-Mesin</div>
        <div style="font-size:15px;font-weight:800;">${rupiahK(r.total_omzet_nonmesin)}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">drop-off · lipat · dll</div>
      </div>
      <div class="card-zl" style="padding:10px;border-left:3px solid #1d4ed8;">
        <div style="font-size:10px;color:var(--text-muted);">&#x1F9FC; Mesin Cuci</div>
        <div style="font-size:15px;font-weight:800;color:#1d4ed8;">${rupiahK(r.total_omzet_cuci)}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">washer</div>
      </div>
      <div class="card-zl" style="padding:10px;border-left:3px solid #d97706;">
        <div style="font-size:10px;color:var(--text-muted);">&#x1F4A8; Mesin Kering</div>
        <div style="font-size:15px;font-weight:800;color:#d97706;">${rupiahK(r.total_omzet_kering)}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">dryer</div>
      </div>
      <div class="card-zl" style="padding:10px;">
        <div style="font-size:10px;color:var(--text-muted);">Rasio Cuci:Kering</div>
        <div style="font-size:13px;font-weight:800;">${r.total_omzet_kering > 0 ? (r.total_omzet_cuci/r.total_omzet_kering).toFixed(1) + 'x' : '—'}</div>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">avg gas LPG ref.</div>
      </div>
    </div>`;

  // legend custom
  html += `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px;font-size:11px;color:var(--text-muted);">
      <span class="pf-lg${seriOff('ringkasan', 'cuci') ? ' off' : ''}" data-seri="cuci" onclick="perfToggleSeri('ringkasan', 'cuci')"><span style="width:10px;height:10px;border-radius:2px;background:#1d4ed8;"></span>Cuci</span>
      <span class="pf-lg${seriOff('ringkasan', 'kering') ? ' off' : ''}" data-seri="kering" onclick="perfToggleSeri('ringkasan', 'kering')"><span style="width:10px;height:10px;border-radius:2px;background:#d97706;"></span>Kering</span>
      <span class="pf-lg${seriOff('ringkasan', 'non') ? ' off' : ''}" data-seri="non" onclick="perfToggleSeri('ringkasan', 'non')"><span style="width:10px;height:10px;border-radius:2px;background:#85B7EB;"></span>Non-mesin</span>
      <span class="pf-lg${seriOff('ringkasan', 'tx') ? ' off' : ''}" data-seri="tx" onclick="perfToggleSeri('ringkasan', 'tx')"><span style="width:14px;height:3px;background:#0F6E56;"></span>Transaksi</span>
      <span class="pf-lg${seriOff('ringkasan', 'plg') ? ' off' : ''}" data-seri="plg" onclick="perfToggleSeri('ringkasan', 'plg')"><span style="width:14px;height:3px;background:#D85A30;border-top:2px dashed #D85A30;"></span>Pelanggan</span>
      ${d.data && d.data.length && d.data[0].sd_label ? `<span class="pf-lg${seriOff('ringkasan', 'sd') ? ' off' : ''}" data-seri="sd" onclick="perfToggleSeri('ringkasan', 'sd')"><span style="width:16px;height:0;border-top:2px dotted #7c3aed;"></span>Omzet ${esc(d.data[d.data.length - 1].sd_label)} <small style="opacity:.75;">(${d.mode === 'harian' ? 'hour to hour' : d.mode === 'mingguan' ? 'day to day' : 'bulan berjalan'})</small></span>` : ''}
      ${d.mode === 'bulanan' ? `<span class="pf-lg${seriOff('ringkasan', 'biaya') ? ' off' : ''}" data-seri="biaya" onclick="perfToggleSeri('ringkasan', 'biaya')"><span style="width:10px;height:10px;border-radius:2px;background:#dc2626;"></span>Biaya</span>
      <span class="pf-lg${seriOff('ringkasan', 'laba') ? ' off' : ''}" data-seri="laba" onclick="perfToggleSeri('ringkasan', 'laba')"><span style="width:10px;height:10px;border-radius:2px;background:#16a34a;"></span>Laba bersih</span>
      <span style="width:100%;font-size:10px;">Bar kiri = pendapatan transaksi · bar kanan = kas besar (setelah setor): biaya + laba bersih</span>` : ''}
    </div>
    <div style="display:flex;width:100%;height:300px;">
      <div style="position:relative;width:40px;flex-shrink:0;height:300px;" id="perf-axis-left"></div>
      <div style="position:relative;flex:1;min-width:0;height:300px;overflow-x:auto;-webkit-overflow-scrolling:touch;" id="perf-chart-scroll">
        <div style="position:relative;height:300px;" id="perf-chart-inner"><canvas id="perf-chart" role="img" aria-label="Grafik omzet harian, jumlah transaksi, dan pelanggan unik"></canvas></div>
      </div>
      <div style="position:relative;width:40px;flex-shrink:0;height:300px;" id="perf-axis-right"></div>
    </div>
    ${(d.data || []).length > d.periode ? `<div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:4px;"><i class="fas fa-arrows-left-right"></i> Geser buat lihat histori lebih lama</div>` : ''}
    <div id="perf-forecast" style="margin-top:12px;"></div>`;

  $('perf-content').innerHTML = html;
  renderPerfChart();
  renderPerfForecast();
}

async function renderPerfForecast() {
  const el = $('perf-forecast');
  if (!el) return;
  el.innerHTML = spinner();
  await renderForecastTahunan();
}

const _fcTipeStyle = {
  real:     { bg: '#f0fdf4', border: '#bbf7d0', badge: '#166534', badgeBg: '#dcfce7', label: 'Real' },
  berjalan: { bg: '#fffbeb', border: '#fde68a', badge: '#92400e', badgeBg: '#fef3c7', label: 'Berjalan' },
  forecast: { bg: '#eff6ff', border: '#bfdbfe', badge: '#1e40af', badgeBg: '#dbeafe', label: 'Forecast' },
};

function _fcCardHtml(m, tipe, opts) {
  opts = opts || {};
  const st = _fcTipeStyle[tipe] || _fcTipeStyle.forecast;
  const breakdown = opts.ringkas ? '' : `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        <div style="padding:6px 8px;background:rgba(255,255,255,0.6);border-radius:8px;">
          <div style="font-size:9px;color:var(--text-muted);">Pelanggan Baru</div>
          <div style="font-size:13px;font-weight:800;color:var(--primary);">${m.pelanggan_baru||0} orang</div>
        </div>
        <div style="padding:6px 8px;background:rgba(255,255,255,0.6);border-radius:8px;">
          <div style="font-size:9px;color:var(--text-muted);">Pelanggan Loyal</div>
          <div style="font-size:13px;font-weight:800;color:var(--success);">${m.pelanggan_loyal||0} orang</div>
        </div>
        <div style="padding:6px 8px;background:rgba(255,255,255,0.6);border-radius:8px;">
          <div style="font-size:9px;color:var(--text-muted);">Pelanggan Lepas</div>
          <div style="font-size:13px;font-weight:800;color:var(--danger);">${m.pelanggan_lepas||0} orang</div>
          <div style="font-size:9px;color:var(--text-muted);">gak balik bulan ini</div>
        </div>
      </div>`;
  return `
    <div class="card-zl" style="background:${st.bg};border-color:${st.border};margin-bottom:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;">${esc(m.label_singkat)}</div>
        <span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;background:${st.badgeBg};color:${st.badge};text-transform:uppercase;letter-spacing:0.3px;">${st.label}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:${opts.ringkas ? '0' : '8px'};flex-wrap:wrap;">
        <div style="font-size:17px;font-weight:800;color:${st.badge};">Rp${(m.omzet_total||0).toLocaleString('id-ID')}</div>
        <div style="font-size:9px;color:var(--text-muted);">${m.pelanggan_total||0} pelanggan · avg Rp${(m.avg_revenue_per_pelanggan||0).toLocaleString('id-ID')}/pelanggan</div>
      </div>
      ${breakdown}
    </div>`;
}

async function renderForecastTahunan() {
  const el = $('perf-forecast');
  if (!el) return;
  try {
    const res = await api('/pelanggan/forecast-tahunan');
    const d = res.data;
    if (!d.bulan_berjalan) { el.innerHTML = ''; return; }
    const a = d.asumsi;

    let html = `
      <div class="card-zl" style="background:linear-gradient(135deg,#1d4ed808,#0f6e5608);margin-bottom:14px;">
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:8px;">
          <i class="fas fa-chart-line"></i> Asumsi Forecast${d.cabang_buka ? ' (cabang buka ' + esc(d.cabang_buka) + ')' : ''}
        </div>
        <div style="font-size:10px;color:var(--text-muted);line-height:1.9;">
          ${a.basis_cukup ? '' : '<b style="color:var(--danger);">Data histori belum cukup (kurang dari 2 bulan) -- forecast di bawah masih kasar.</b><br>'}
          <b>Bulan berjalan:</b> ${esc(a.metode_bulan_berjalan)}<br>
          <b>6 bulan ke depan:</b> ${esc(a.metode_6bulan_kedepan)} Basis bulan ini: <b>${esc(a.basis_n2.bulan)}</b> (${a.basis_n2.pelanggan_baru} baru, ${a.basis_n2.pelanggan_loyal} loyal, ${a.basis_n2.pelanggan_lepas} lepas)
          &rarr; <b>${esc(a.basis_n1.bulan)}</b> (${a.basis_n1.pelanggan_baru} baru, ${a.basis_n1.pelanggan_loyal} loyal, ${a.basis_n1.pelanggan_lepas} lepas).
        </div>
      </div>`;

    if (d.historis.length) {
      html += `
        <div class="section-label"><i class="fas fa-clock-rotate-left"></i> Histori Sejak Cabang Buka</div>
        <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:10px;margin-bottom:14px;" class="forecast-tahunan-grid">
          ${d.historis.map((m) => _fcCardHtml(m, 'real')).join('')}
        </div>`;
    }

    html += `
      <div class="section-label"><i class="fas fa-calendar-day"></i> Bulan Ini -- Real s.d. Hari Ini (${d.bulan_berjalan.hari_berjalan}/${d.bulan_berjalan.total_hari} hari)</div>
      <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:10px;margin-bottom:6px;" class="forecast-tahunan-grid">
        ${_fcCardHtml(d.bulan_berjalan.real, 'berjalan')}
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin:-2px 0 14px;padding:0 2px;">
        Rata² per hari (${d.bulan_berjalan.hari_berjalan} hari berjalan): Rp${(d.bulan_berjalan.rata_rata_harian.revenue_per_hari||0).toLocaleString('id-ID')}/hari ·
        ${d.bulan_berjalan.rata_rata_harian.pelanggan_lepas_per_hari||0} pelanggan lepas/hari
      </div>
      <div class="section-label"><i class="fas fa-calendar-check"></i> Bulan Ini -- Forecast Sampai Akhir Bulan</div>
      <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:10px;margin-bottom:6px;" class="forecast-tahunan-grid">
        ${_fcCardHtml(d.bulan_berjalan.forecast, 'forecast')}
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin:-2px 0 14px;padding:0 2px;">
        ${d.bulan_berjalan.tren_mingguan && d.bulan_berjalan.tren_mingguan.data_cukup
          ? `Tren 6 minggu terakhir: rata² pelanggan ${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.total>=0?'+':''}${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.total}/minggu (${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.baru>=0?'+':''}${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.baru} baru, ${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.loyal>=0?'+':''}${d.bulan_berjalan.tren_mingguan.rata_rata_kenaikan_per_minggu.loyal} loyal) · rata² omzet Rp${(d.bulan_berjalan.tren_mingguan.rata_rata_omzet_per_minggu.total||0).toLocaleString('id-ID')}/minggu · sisa ${d.bulan_berjalan.tren_mingguan.sisa_minggu} minggu s.d. akhir bulan`
          : 'Data mingguan belum cukup -- forecast pakai angka real apa adanya.'}
      </div>
      <div class="section-label"><i class="fas fa-calendar-days"></i> Forecast 6 Bulan ke Depan</div>
      <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:10px;" class="forecast-tahunan-grid">
        ${d.forecast_6bulan.map((m) => _fcCardHtml(m, 'forecast', {ringkas:true})).join('')}
      </div>`;

    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = emptyState('Gagal memuat forecast. ' + e.message, 'fa-triangle-exclamation');
  }
}

function fmtTgl(ymd) {
  const [, m, d] = ymd.split('-');
  return `${d}/${m}`;
}

function renderPerfChart() {
  if (typeof Chart === 'undefined') {
    $('perf-content').insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--danger);margin-top:8px;">Chart gagal dimuat (cek koneksi).</div>`);
    return;
  }
  const d = PERF.data;
  const labels = d.data.map((x) => {
    if (x.rentang && d.mode !== 'harian') return [x.label, x.rentang]; // 2 baris: "Minggu 1" + "5–11 Mei"
    return x.label || fmtTgl(x.tanggal);
  });
  const omzetCuci = d.data.map((x) => x.omzet_cuci || 0);
  const omzetKering = d.data.map((x) => x.omzet_kering || 0);
  const omzetNon = d.data.map((x) => x.omzet_nonmesin);
  const tx = d.data.map((x) => x.jumlah_transaksi);
  const plg = d.data.map((x) => x.pelanggan_unik);

  // mingguan/bulanan sekarang bawa FULL histori (bisa lebih dari `periode`
  // bucket) -- kasih lebar tetap per-bar, biar total lebar canvas > lebar
  // viewport kalau datanya lebih banyak dari window default, sehingga bisa
  // discroll. Container luar (#perf-chart-scroll) yang batasi viewport-nya.
  const scrollEl = $('perf-chart-scroll');
  const innerEl = $('perf-chart-inner');
  if (innerEl && scrollEl) {
    // Perubahan #18: layar pas menampilkan N bucket terakhir (harian 8/30
    // hari, bulanan 6 bulan), sisanya (sampai cabang buka) digeser ke kiri.
    const lebarMin = scrollEl.clientWidth || 320;
    const jendela = d.mode === 'mingguan' ? 0 : (d.periode || 8);
    const pxPerBar = jendela ? lebarMin / jendela : 46;
    innerEl.style.width = Math.max(lebarMin, Math.round(d.data.length * pxPerBar)) + 'px';
  }

  if (PERF.chart) { PERF.chart.destroy(); PERF.chart = null; }
  const ctx = $('perf-chart').getContext('2d');
  PERF.chart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { kunci: 'cuci', hidden: seriOff('ringkasan', 'cuci'), type: 'bar', label: 'Cuci (washer)', data: omzetCuci, backgroundColor: '#1d4ed8', stack: 'omzet', yAxisID: 'y', order: 3 },
        { kunci: 'kering', hidden: seriOff('ringkasan', 'kering'), type: 'bar', label: 'Kering (dryer)', data: omzetKering, backgroundColor: '#d97706', stack: 'omzet', yAxisID: 'y', order: 3 },
        { kunci: 'non', hidden: seriOff('ringkasan', 'non'), type: 'bar', label: 'Non-mesin', data: omzetNon, backgroundColor: '#85B7EB', stack: 'omzet', yAxisID: 'y', order: 3 },
        ...(d.mode === 'bulanan' ? [
          // Perubahan #81: biaya (merah) di bawah, laba bersih (hijau) di atas
          { kunci: 'biaya', hidden: seriOff('ringkasan', 'biaya'), type: 'bar', label: 'Biaya', data: d.data.map((x) => x.keu_biaya || 0), backgroundColor: '#dc2626', stack: 'keu', yAxisID: 'y', order: 3 },
          { kunci: 'laba', hidden: seriOff('ringkasan', 'laba'), type: 'bar', label: 'Laba bersih', data: d.data.map((x) => x.keu_laba_bar || 0), backgroundColor: '#16a34a', stack: 'keu', yAxisID: 'y', order: 3 },
        ] : []),
        { kunci: 'tx', hidden: seriOff('ringkasan', 'tx'), type: 'line', label: 'Transaksi', data: tx, borderColor: '#0F6E56', backgroundColor: '#0F6E56', yAxisID: 'y1', tension: 0.3, borderWidth: 2, pointRadius: 2, order: 1 },
        { kunci: 'plg', hidden: seriOff('ringkasan', 'plg'), type: 'line', label: 'Pelanggan', data: plg, borderColor: '#D85A30', backgroundColor: '#D85A30', borderDash: [5, 4], yAxisID: 'y1', tension: 0.3, borderWidth: 2, pointRadius: 2, order: 0 },
        // Perubahan #79: omzet total s/d titik waktu yang sama dengan sekarang (sumbu rupiah)
        ...(d.data.some((x) => x.omzet_sd != null) ? [{ kunci: 'sd', hidden: seriOff('ringkasan', 'sd'), type: 'line', label: `Omzet ${d.data[d.data.length - 1].sd_label || 's/d sekarang'}`, data: d.data.map((x) => x.omzet_sd || 0),
          borderColor: '#7c3aed', backgroundColor: '#7c3aed', borderDash: [2, 3], yAxisID: 'y', stack: 'sd', tension: 0.25, borderWidth: 2, pointRadius: 2.5, pointStyle: 'rectRot', order: 0 }] : []),
      ],
    },
    options: {
      onResize: () => requestAnimationFrame(renderPerfAxisLabels),
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const row = d.data[i] || {};
              // Perubahan #71: nama hari
              if (d.mode === 'harian') return tglHari(row.tanggal);
              if (d.mode === 'mingguan') return `${row.label}${row.tgl_awal ? ' · ' + rentangHari(row.tgl_awal, row.tgl_akhir) : row.rentang ? ' (' + row.rentang + ')' : ''}`;
              return judulTooltip(row, 'bulanan');
            },
            label: (c) => {
              const v = c.parsed.y;
              if (c.dataset.yAxisID === 'y') return `${c.dataset.label}: ${rupiah(v)}`;
              return `${c.dataset.label}: ${v}`;
            },
            footer: (items) => {
              const i = items[0].dataIndex;
              const row = d.data[i] || {};
              const baris = [`Total omzet: ${rupiah(row.omzet_total || 0)}`];
              if (d.mode === 'bulanan') {
                baris.push(`Pendapatan kas besar: ${rupiah(row.keu_pendapatan || 0)}`);
                baris.push((row.keu_laba || 0) < 0 ? `RUGI: ${rupiah(-row.keu_laba)}` : `Laba bersih: ${rupiah(row.keu_laba || 0)}`);
              }
              return baris;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { autoSkip: true, maxRotation: 0, font: { size: 10 } }, grid: { display: false } },
        y: { stacked: true, position: 'left', beginAtZero: true, ticks: { display: false }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y1: { position: 'right', beginAtZero: true, ticks: { display: false }, grid: { display: false } },
      },
    },
  });

  // Label sumbu Y digambar MANUAL di #perf-axis-left / #perf-axis-right (di
  // luar area yg discroll), biar tetap kelihatan walau chart-nya digeser jauh
  // ke kiri/kanan -- kalau dibiarkan bawaan Chart.js, labelnya ikut ke-scroll
  // bareng grafiknya (makanya sebelumnya skala kanan ilang pas digeser mentok).
  // Dibungkus requestAnimationFrame biar dijalankan SETELAH layout chart
  // beneran settle (posisi tick baru akurat).
  requestAnimationFrame(() => {
    renderPerfAxisLabels();
    // default: scroll ke ujung KANAN (data terbaru) tiap kali chart mingguan/
    // bulanan di-render ulang -- pengguna tinggal geser ke kiri buat lihat histori.
    if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;
  });
}

/** Gambar ulang label angka sumbu Y kiri (Rupiah) & kanan (Transaksi/Pelanggan) di div fixed, disinkron ke posisi tick asli chart. */
function renderPerfAxisLabels(chartArg, kiriId, kananId, fmtKiri) {
  // Perubahan #70: dipakai juga tab Pelanggan (chart2, id sumbu sendiri, format angka biasa)
  const chart = chartArg && chartArg.scales ? chartArg : PERF.chart;
  const leftEl = $(chartArg && chartArg.scales ? kiriId : 'perf-axis-left');
  const rightEl = $(chartArg && chartArg.scales ? kananId : 'perf-axis-right');
  if (!chart || !leftEl || !rightEl) return;

  function buatLabel(scaleId, formatFn) {
    const scale = chart.scales[scaleId];
    if (!scale) return '';
    // Perubahan #80: sumbu tanpa seri yang tampil -> tanpa label
    if (!chart.data.datasets.some((d) => !d.hidden && (d.yAxisID || 'y') === scaleId)) return '';
    return scale.ticks.map((t, i) => {
      const yPx = scale.getPixelForTick ? scale.getPixelForTick(i) : scale.getPixelForValue(t.value);
      return `<div style="position:absolute;top:${yPx}px;left:0;right:0;transform:translateY(-50%);font-size:9px;color:#6b7280;text-align:${scaleId === 'y' ? 'right' : 'left'};padding:0 2px;white-space:nowrap;">${formatFn(t.value)}</div>`;
    }).join('');
  }

  leftEl.innerHTML = buatLabel('y', chartArg && chartArg.scales && fmtKiri ? fmtKiri : (v) => rupiahK(v));
  rightEl.innerHTML = buatLabel('y1', (v) => Math.round(v));
}

/* Perubahan #80: sembunyikan / munculkan seri grafik Performa lewat legenda (diingat per browser) */
function seriSet(tab) { try { return new Set(JSON.parse(localStorage.getItem('zl_perf_sembunyi_' + tab) || '[]')); } catch (e) { return new Set(); } }
function seriOff(tab, key) { return seriSet(tab).has(key); }
function perfToggleSeri(tab, key) {
  const chart = tab === 'pelanggan' ? PERF.chart2 : PERF.chart;
  if (!chart) return;
  const set = seriSet(tab);
  const ds = chart.data.datasets;
  const mau = !set.has(key);
  if (mau && ds.filter((x) => !x.hidden && x.kunci !== key).length === 0) { toast('Minimal 1 grafik tetap tampil', 'warning'); return; }
  if (mau) set.add(key); else set.delete(key);
  try { localStorage.setItem('zl_perf_sembunyi_' + tab, JSON.stringify([...set])); } catch (e) { /* abaikan */ }
  ds.forEach((x) => { if (x.kunci === key) x.hidden = mau; });
  chart.update();
  document.querySelectorAll(`.pf-lg[data-seri="${key}"]`).forEach((el) => el.classList.toggle('off', mau));
  requestAnimationFrame(() => (tab === 'pelanggan'
    ? renderPerfAxisLabels(PERF.chart2, 'perf2-axis-left', 'perf2-axis-right', (v) => Math.round(v))
    : renderPerfAxisLabels()));
}

/* Perubahan #71: nama hari di keterangan (tooltip) grafik */
const NAMA_HARI_PANJANG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const HARI_PENDEK_TT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const NAMA_BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const NAMA_BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function tglHari(ymd) { // "Senin, 9 Nov 2026"
  if (!ymd) return '';
  const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z');
  return `${NAMA_HARI_PANJANG[d.getUTCDay()]}, ${d.getUTCDate()} ${NAMA_BULAN_PENDEK[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function rentangHari(a, b) { // "Sen 2 – Min 8 Nov 2026"
  const x = new Date(String(a).slice(0, 10) + 'T00:00:00Z'); const y = new Date(String(b).slice(0, 10) + 'T00:00:00Z');
  const kiri = `${HARI_PENDEK_TT[x.getUTCDay()]} ${x.getUTCDate()}${x.getUTCMonth() !== y.getUTCMonth() ? ' ' + NAMA_BULAN_PENDEK[x.getUTCMonth()] : ''}${x.getUTCFullYear() !== y.getUTCFullYear() ? ' ' + x.getUTCFullYear() : ''}`;
  return `${kiri} – ${HARI_PENDEK_TT[y.getUTCDay()]} ${y.getUTCDate()} ${NAMA_BULAN_PENDEK[y.getUTCMonth()]} ${y.getUTCFullYear()}`;
}
function judulTooltip(row, mode) {
  if (!row) return '';
  if (mode === 'bulanan') { const k = row.bulan || String(row.tanggal || row.tgl_awal || '').slice(0, 7); const [y, m] = k.split('-'); return `${NAMA_BULAN_PANJANG[Number(m) - 1]} ${y}`; }
  if (mode === 'mingguan') return `${row.label || ''} · ${rentangHari(row.tgl_awal || row.tanggal, row.tgl_akhir || row.tanggal)}`;
  return tglHari(row.tanggal);
}

function renderPerfPelanggan() {
  const d = PERF.data; const r = d.ringkas || {};
  const satuan = d.mode === 'mingguan' ? `${d.periode} mgg` : d.mode === 'bulanan' ? `${d.periode} bln` : `${d.periode}h`;
  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
      <div class="card-zl" style="padding:12px;">
        <div style="font-size:10px;color:var(--text-muted);">Total Pelanggan</div>
        <div style="font-size:17px;font-weight:800;color:var(--primary);">${r.total_pelanggan}</div>
      </div>
      <div class="card-zl" style="padding:12px;">
        <div style="font-size:10px;color:var(--text-muted);">Baru (${satuan})</div>
        <div style="font-size:17px;font-weight:800;color:var(--success);">${r.pelanggan_baru}</div>
      </div>
      <div class="card-zl" style="padding:12px;">
        <div style="font-size:10px;color:var(--text-muted);">Kunjungan Lama (${satuan})</div>
        <div style="font-size:17px;font-weight:800;">${r.kunjungan_lama}</div>
      </div>
    </div>`;

  // Perubahan #70: bisa digeser sampai toko buka (sumbu Y tetap di luar area geser)
  html += `
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;font-size:11px;color:var(--text-muted);">
      <span class="pf-lg${seriOff('pelanggan', 'lama') ? ' off' : ''}" data-seri="lama" onclick="perfToggleSeri('pelanggan', 'lama')"><span style="width:10px;height:10px;border-radius:2px;background:#185FA5;"></span>Lama</span>
      <span class="pf-lg${seriOff('pelanggan', 'baru') ? ' off' : ''}" data-seri="baru" onclick="perfToggleSeri('pelanggan', 'baru')"><span style="width:10px;height:10px;border-radius:2px;background:#1D9E75;"></span>Baru</span>
      <span class="pf-lg${seriOff('pelanggan', 'akum') ? ' off' : ''}" data-seri="akum" onclick="perfToggleSeri('pelanggan', 'akum')"><span style="width:14px;height:3px;background:#D85A30;"></span>Akumulasi total</span>
    </div>
    <div style="display:flex;width:100%;height:300px;">
      <div style="position:relative;width:34px;flex-shrink:0;height:300px;" id="perf2-axis-left"></div>
      <div style="position:relative;flex:1;min-width:0;height:300px;overflow-x:auto;-webkit-overflow-scrolling:touch;" id="perf2-scroll">
        <div style="position:relative;height:300px;" id="perf2-inner"><canvas id="perf-chart2" role="img" aria-label="Grafik pelanggan baru dan lama dengan akumulasi total"></canvas></div>
      </div>
      <div style="position:relative;width:40px;flex-shrink:0;height:300px;" id="perf2-axis-right"></div>
    </div>
    ${(d.data || []).length > d.periode ? `<div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:4px;"><i class="fas fa-arrows-left-right"></i> Geser buat lihat histori sampai toko buka${d.tanggal_buka ? ' (' + tglHari(d.tanggal_buka) + ')' : ''}</div>` : ''}`;

  $('perf-content').innerHTML = html;
  renderPerfPelangganChart();
}

function renderPerfPelangganChart() {
  if (typeof Chart === 'undefined') {
    $('perf-content').insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--danger);margin-top:8px;">Chart gagal dimuat (cek koneksi).</div>`);
    return;
  }
  const d = PERF.data;
  const labels = d.data.map((x) => (d.mode === 'harian' ? fmtTgl(x.tanggal) : (x.rentang && d.mode === 'mingguan' ? [x.label, x.rentang] : x.label)));
  const lama = d.data.map((x) => x.lama);
  const baru = d.data.map((x) => x.baru);
  const akum = d.data.map((x) => x.akumulasi);

  const scrollEl = $('perf2-scroll'); const innerEl = $('perf2-inner');
  if (innerEl && scrollEl) {
    const lebarMin = scrollEl.clientWidth || 320;
    const pxPerBar = lebarMin / (d.periode || 8);
    innerEl.style.width = Math.max(lebarMin, Math.round(d.data.length * pxPerBar)) + 'px';
  }

  if (PERF.chart2) { PERF.chart2.destroy(); PERF.chart2 = null; }
  const ctx = $('perf-chart2').getContext('2d');
  PERF.chart2 = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { kunci: 'lama', hidden: seriOff('pelanggan', 'lama'), type: 'bar', label: 'Lama', data: lama, backgroundColor: '#185FA5', stack: 'plg', yAxisID: 'y', order: 3 },
        { kunci: 'baru', hidden: seriOff('pelanggan', 'baru'), type: 'bar', label: 'Baru', data: baru, backgroundColor: '#1D9E75', stack: 'plg', yAxisID: 'y', order: 3 },
        { kunci: 'akum', hidden: seriOff('pelanggan', 'akum'), type: 'line', label: 'Akumulasi', data: akum, borderColor: '#D85A30', backgroundColor: '#D85A30', yAxisID: 'y1', tension: 0.3, borderWidth: 2, pointRadius: 2, order: 0 },
      ],
    },
    options: {
      onResize: () => requestAnimationFrame(() => renderPerfAxisLabels(PERF.chart2, 'perf2-axis-left', 'perf2-axis-right', (v) => Math.round(v))),
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (items) => judulTooltip(d.data[items[0].dataIndex], d.mode), // Perubahan #71
          label: (c) => `${c.dataset.label}: ${c.parsed.y}`,
        } },
      },
      scales: {
        x: { stacked: true, ticks: { autoSkip: true, maxRotation: 0, font: { size: 10 } }, grid: { display: false } },
        y: { stacked: true, position: 'left', beginAtZero: true, ticks: { display: false, precision: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y1: { position: 'right', beginAtZero: true, ticks: { display: false, precision: 0 }, grid: { display: false } },
      },
    },
  });
  requestAnimationFrame(() => {
    renderPerfAxisLabels(PERF.chart2, 'perf2-axis-left', 'perf2-axis-right', (v) => Math.round(v));
    if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;
  });
}

function perfBarItem(label, val, max, color, sub) {
  const pct = max > 0 ? Math.round((val / max) * 100) : 0;
  return `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
        <span style="font-weight:600;">${esc(label)}</span>
        <span style="color:var(--text-muted);">${esc(sub)}</span>
      </div>
      <div style="height:8px;background:var(--bg-soft);border-radius:5px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:5px;"></div>
      </div>
    </div>`;
}

function renderPerfProduk() {
  const d = PERF.data;
  let html = '';

  // Layanan terlaris (bar omzet)
  html += `<div class="section-label"><i class="fas fa-ranking-star"></i> Layanan Terlaris</div>`;
  if (!d.layanan.length) html += emptyState('Belum ada data', 'fa-inbox');
  else {
    html += `<div class="card-zl">`;
    const maxO = Math.max(...d.layanan.map((l) => l.omzet));
    d.layanan.forEach((l) => { html += perfBarItem(l.nama, l.omzet, maxO, '#185FA5', `${rupiahK(l.omzet)} · ${l.qty}x`); });
    html += `</div>`;
  }

  // Mesin terlaku (bar pemakaian)
  html += `<div class="section-label"><i class="fas fa-washing-machine"></i> Mesin Terlaku</div>`;
  if (!d.mesin.length) html += emptyState('Belum ada data', 'fa-inbox');
  else {
    html += `<div class="card-zl">`;
    const maxM = Math.max(...d.mesin.map((m) => m.pemakaian));
    d.mesin.forEach((m) => {
      const warna = m.tipe === 'dryer' ? '#D85A30' : '#0F6E56';
      html += perfBarItem(m.kode + (m.nama ? ' · ' + m.nama : ''), m.pemakaian, maxM, warna, `${m.pemakaian}x`);
    });
    html += `</div>`;
  }

  // Barang terlaris (list)
  html += `<div class="section-label"><i class="fas fa-box"></i> Barang Terlaris</div>`;
  if (!d.barang.length) html += emptyState('Belum ada penjualan barang', 'fa-inbox');
  else {
    html += `<div class="card-zl">`;
    d.barang.forEach((b) => {
      html += `<div class="proc-row">
          <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${esc(b.nama)}</div>
            <div style="font-size:10px;color:var(--text-muted);">${b.qty}x terjual</div></div>
          <div style="font-weight:700;">${rupiah(b.omzet)}</div>
        </div>`;
    });
    html += `</div>`;
  }

  // Jam ramai (bar chart 24 jam)
  const jr = d.jam_ramai;
  html += `<div class="section-label"><i class="fas fa-clock"></i> Jam Ramai${jr ? ` · puncak jam ${String(jr.jam).padStart(2, '0')}:00 (${jr.jumlah}x)` : ''}</div>`;
  html += `<div style="position:relative;width:100%;height:200px;"><canvas id="perf-chart4" role="img" aria-label="Distribusi transaksi per jam"></canvas></div>`;

  $('perf-content').innerHTML = html;
  renderJamChart();
}

function renderJamChart() {
  if (typeof Chart === 'undefined') return;
  const d = PERF.data;
  const labels = d.jam.map((j) => String(j.jam).padStart(2, '0'));
  const vals = d.jam.map((j) => j.jumlah);
  const maxV = Math.max(...vals);
  const colors = vals.map((v) => (v === maxV && maxV > 0 ? '#D85A30' : '#85B7EB'));

  if (PERF.chart4) { PERF.chart4.destroy(); PERF.chart4 = null; }
  const ctx = $('perf-chart4').getContext('2d');
  PERF.chart4 = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Transaksi', data: vals, backgroundColor: colors }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `Jam ${c[0].label}:00`, label: (c) => `${c.parsed.y} transaksi` } } },
      scales: {
        x: { ticks: { autoSkip: true, maxRotation: 0, font: { size: 9 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
      },
    },
  });
}
const KB = { bulan: null, ringkas: null, kategori: [], kategoriAkrual: [], bulanList: [], expanded: {} };

function loadKasBesar() {
  const body = $('kasbesar-body'); body.innerHTML = spinner();
  // set bulan berjalan agar request pertama konsisten (?bulan=YYYY-MM => sampai akhir bulan)
  if (!KB.bulan) {
    const now = new Date(Date.now() + 7 * 3600 * 1000); // WIB
    KB.bulan = now.toISOString().slice(0, 7);
  }
  kbReload();
}

function kbQS() {
  return KB.bulan ? `?bulan=${KB.bulan}` : '';
}

function namaBulan(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const nm = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${nm[m - 1]} ${y}`;
}

function kbSetBulan(v) { KB.bulan = v; kbReload(); }

async function kbReload() {
  const body = $('kasbesar-body'); body.innerHTML = spinner();
  try {
    const r = await api('/kas-besar' + kbQS());
    KB.ringkas = r.data;
    if (r.data.bulan_tersedia) KB.bulanList = r.data.bulan_tersedia;
    if (!KB.bulan && r.data.periode) KB.bulan = (r.data.periode.dari || '').slice(0, 7);
    KB.expanded = {}; // reset expand state
    renderKasBesar();
  } catch (e) {
    body.innerHTML = emptyState('Gagal memuat kas besar. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderKasBesar() {
  const d = KB.ringkas; const lr = d.laba_rugi || {};
  const bulanAktif = KB.bulan || (d.periode && d.periode.dari || '').slice(0, 7);

  // dropdown pilihan bulan
  let opsiBulan = (KB.bulanList || []);
  if (bulanAktif && !opsiBulan.includes(bulanAktif)) opsiBulan = [bulanAktif, ...opsiBulan];
  let html = `
    <div class="field" style="margin-bottom:12px;">
      <label>Periode (per bulan)</label>
      <select id="kb-bulan" onchange="kbSetBulan(this.value)" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
        ${opsiBulan.map((b) => `<option value="${b}" ${b === bulanAktif ? 'selected' : ''}>${namaBulan(b)}</option>`).join('')}
      </select>
    </div>`;

  html += `
    <div class="saldo-card" style="margin-bottom:12px;">
      <div class="sc-label">Saldo Bebas (idle)</div>
      <div class="sc-total">${rupiah(d.saldo_bebas != null ? d.saldo_bebas : d.saldo_kas_besar)}</div>
      <div class="sc-split" style="margin-top:8px;">
        <div class="sc-item"><div class="l">Saldo Total</div><div class="v">${rupiah(d.saldo_total != null ? d.saldo_total : d.saldo_kas_besar)}</div></div>
        <div class="sc-item"><div class="l">Teralokasi</div><div class="v">${rupiah(d.saldo_teralokasi || 0)}</div></div>
      </div>
    </div>`;

  // Perubahan #83: saldo Winpay (dana Kios-K yang belum ditarik ke kas besar)
  const sw = Number(d.saldo_winpay) || 0;
  html += `
    <div class="wp-card">
      <div class="wp-top">
        <div class="wp-ic"><i class="fas fa-tablet-screen-button"></i></div>
        <div><div class="wp-l">Saldo Winpay (Kios-K)</div><div class="wp-v">${rupiah(sw)}</div></div>
        <button class="wp-btn" onclick="openTarikWinpay()" ${sw > 0 ? '' : 'disabled'}><i class="fas fa-arrow-down"></i> Tarik ke Kas Besar</button>
      </div>
      <div class="wp-sub"><span>Belum ditarik · tidak termasuk saldo kas besar</span></div>
      <span class="wp-link" onclick="openRiwayatWinpay()">Riwayat Winpay</span>
    </div>`;

  // tombol input + export
  html += `<div style="display:flex;gap:8px;margin-bottom:14px;">
      <button class="btn-zl btn-primary-zl" style="flex:1;" onclick="openInputBeban()"><i class="fas fa-plus"></i> Input Beban</button>
      <button class="btn-zl btn-light-zl" style="flex:0 0 auto;width:auto;padding-left:16px;padding-right:16px;" onclick="exportKasBesar()"><i class="fas fa-file-excel"></i> Export</button>
    </div>`;

  // laba-rugi periode (baris expandable)
  const rinc = lr.rincian || {};
  // baris grup yg bisa diklik -> expand detail record (sisi)
  const grupRow = (label, val, tanda, sisi, color) => {
    const open = KB.expanded['grup:' + sisi];
    return `<div class="kb-row" onclick="kbToggle('grup:${sisi}', '${sisi}', null)" style="display:flex;justify-content:space-between;font-weight:700;margin-top:8px;cursor:pointer;${color ? 'color:' + color + ';' : ''}">
        <span><i class="fas fa-chevron-${open ? 'down' : 'right'}" style="font-size:9px;width:10px;"></i> ${label}</span><b>${tanda}${rupiah(val)}</b>
      </div>
      <div id="exp-grup:${sisi}">${open ? renderExpand('grup:' + sisi) : ''}</div>`;
  };
  // baris COA yg bisa diklik -> expand detail record (coa)
  const coaRows = (arr, sisi, tanda) => (arr && arr.length
    ? arr.map((c) => {
        const key = 'coa:' + c.coa_id;
        const open = KB.expanded[key];
        return `<div class="kb-row" onclick="kbToggle('${key}','${sisi}',${c.coa_id})" style="display:flex;justify-content:space-between;margin-top:3px;padding-left:18px;font-size:12px;cursor:pointer;">
            <span style="color:var(--text-muted);"><i class="fas fa-chevron-${open ? 'down' : 'right'}" style="font-size:8px;width:9px;"></i> ${esc(c.nama)}</span>
            <span>${tanda}${rupiah(c.nominal)}</span></div>
          <div id="exp-${key}">${open ? renderExpand(key) : ''}</div>`;
      }).join('')
    : `<div style="padding-left:18px;font-size:12px;color:var(--slate-light);margin-top:3px;">—</div>`);

  html += `
    <div class="section-label"><i class="fas fa-scale-balanced"></i> Laba Rugi · ${esc(namaBulan(bulanAktif))}</div>
    <div class="card-zl" style="font-size:13px;">
      ${grupRow('Pendapatan', lr.pendapatan, '', 'pendapatan', '')}
      ${coaRows(rinc.pendapatan, 'pendapatan', '')}

      ${grupRow('HPP', lr.hpp, '− ', 'hpp', '')}
      ${coaRows(rinc.cogs, 'beban', '− ')}

      <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px dashed var(--border);font-weight:600;"><span>Laba Kotor</span><b style="color:var(--primary);">${rupiah(lr.laba_kotor)}</b></div>

      ${grupRow('COS (Biaya Jasa)', lr.cos, '− ', 'cos', '')}
      ${coaRows(rinc.cos, 'beban', '− ')}

      ${grupRow('OPEX (Beban Operasional)', lr.opex, '− ', 'opex', '')}
      ${coaRows(rinc.opex, 'beban', '− ')}

      <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px dashed var(--border);font-weight:700;"><span>Laba Bersih</span><b style="color:${(lr.laba_bersih || 0) >= 0 ? 'var(--success)' : 'var(--danger)'};font-size:15px;">${rupiah(lr.laba_bersih)}</b></div>
    </div>`;

  // Distribusi Laba
  const dist = d.distribusi || { total: 0, rincian: [], sisa_laba: lr.laba_bersih };
  html += `
    <div class="section-label" style="display:flex;justify-content:space-between;align-items:center;">
      <span><i class="fas fa-hand-holding-dollar"></i> Distribusi Laba</span>
      <button class="btn-mesin" style="padding:5px 10px;font-size:11px;" onclick="openInputDistribusi()"><i class="fas fa-plus"></i> Input</button>
    </div>
    <div class="card-zl" style="font-size:13px;">`;
  if (!dist.rincian.length) {
    html += `<div style="font-size:12px;color:var(--slate-light);">Belum ada distribusi bulan ini</div>`;
  } else {
    dist.rincian.forEach((x) => {
      html += `<div style="display:flex;justify-content:space-between;margin-top:3px;"><span style="color:var(--text-muted);">${esc(x.nama)}</span><span>− ${rupiah(x.nominal)}</span></div>`;
    });
    html += `<div style="display:flex;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);font-weight:700;"><span>Total Distribusi</span><b style="color:var(--danger);">− ${rupiah(dist.total)}</b></div>`;
    html += `<div style="display:flex;justify-content:space-between;margin-top:4px;font-weight:700;"><span>Sisa Laba Ditahan</span><b style="color:${dist.sisa_laba >= 0 ? 'var(--success)' : 'var(--danger)'};">${rupiah(dist.sisa_laba)}</b></div>`;
  }
  html += `</div>`;

  $('kasbesar-body').innerHTML = html;
}

// render isi expand dari cache record
function renderExpand(key) {
  const recs = KB.expanded[key];
  if (recs === true || recs == null) return `<div style="padding:8px 18px;font-size:11px;color:var(--text-muted);">${spinner()}</div>`;
  if (!recs.length) return `<div style="padding:6px 18px;font-size:11px;color:var(--slate-light);">Tidak ada record</div>`;
  return `<div style="background:var(--bg-soft);border-radius:8px;padding:6px 10px;margin:4px 0 4px 18px;">`
    + recs.map((x) => `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text-muted);">${esc(String(x.tanggal).slice(0, 10))} · ${esc(x.coa_nama || '')}${x.sumber === 'akrual' ? ' <span style=\"color:var(--warning);\">[akrual]</span>' : ''}${x.keterangan ? ' · ' + esc(x.keterangan) : ''}</span>
        <span style="font-weight:600;white-space:nowrap;">${rupiah(x.nominal)}</span></div>`).join('')
    + `</div>`;
}

// toggle expand: fetch record kalau belum ada
async function kbToggle(key, sisi, coaId) {
  if (KB.expanded[key]) { delete KB.expanded[key]; renderKasBesar(); return; }
  KB.expanded[key] = true; // loading
  renderKasBesar();
  try {
    let qs = `?sisi=${sisi}` + (KB.bulan ? `&bulan=${KB.bulan}` : '') + (coaId ? `&coa_id=${coaId}` : '');
    const res = await api('/kas-besar/detail' + qs);
    KB.expanded[key] = res.data || [];
  } catch (e) { KB.expanded[key] = []; }
  renderKasBesar();
}

async function exportKasBesar() {
  toast('Menyiapkan file...', 'success');
  try {
    const res = await api('/kas-besar/export' + kbQS());
    buatExcelKasBesar(res.data);
  } catch (e) { toast(e.message || 'Gagal export', 'danger'); }
}

/* ---- Perubahan #83: tarik dana Winpay (Kios-K) ke kas besar ---- */
async function openTarikWinpay() {
  let w;
  try { w = (await api('/kas-besar/winpay?limit=5')).data; } catch (e) { toast(e.message, 'danger'); return; }
  const saldo = Number(w.saldo) || 0;
  openSheet(`
    <h3><i class="fas fa-arrow-down"></i> Tarik Dana Winpay</h3>
    <div class="card-zl" style="text-align:center;">
      <div style="font-size:12px;color:var(--text-muted);">Saldo Winpay (maks. tarik)</div>
      <div style="font-size:24px;font-weight:800;color:#6d28d9;">${rupiah(saldo)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Sudah dipotong ${w.potongan_persen != null ? String(w.potongan_persen).replace('.', ',') + '%' : 'MDR'} (biaya MDR)</div>
    </div>
    <div class="field"><label>Nominal tarik (Rp)</label>
      <input type="text" id="wp-nom" inputmode="numeric" placeholder="mis. 500.000" oninput="wpFmt(this)">
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-zl btn-light-zl" style="flex:1;padding:7px;font-size:12px;" onclick="wpIsi(${Math.floor(saldo)})">Semua (${rupiah(Math.floor(saldo))})</button>
      </div>
    </div>
    <div class="field"><label>Keterangan (opsional)</label><input type="text" id="wp-ket" placeholder="mis. Tarik Dana di dashboard Winpay 18/11"></div>
    <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px;">Samakan dengan nominal yang ditarik di dashboard Winpay (menu Tarik Dana). Tidak mengubah laba-rugi.</div>
    <button class="btn-zl btn-primary-zl" id="btn-wp" onclick="doTarikWinpay(${saldo})"><i class="fas fa-check"></i> Tarik ke Kas Besar</button>`);
}
function wpTgl(t) { const x = String(t || '').replace('T', ' '); return x.length >= 16 ? `${x.slice(8, 10)}/${x.slice(5, 7)} ${x.slice(11, 16)}` : x; }
function wpFmt(el) { const n = String(el.value).replace(/[^\d]/g, ''); el.value = n ? Number(n).toLocaleString('id-ID') : ''; }
function wpIsi(n) { const el = $('wp-nom'); if (el) el.value = Number(n).toLocaleString('id-ID'); }
async function doTarikWinpay(saldo) {
  const nominal = Number(String(($('wp-nom') || {}).value || '').replace(/[^\d]/g, ''));
  if (!nominal) { toast('Isi nominal tarik', 'warning'); return; }
  if (nominal > saldo) { toast('Nominal melebihi saldo Winpay (maks ' + rupiah(Math.floor(saldo)) + ')', 'warning'); return; }
  const btn = $('btn-wp'); btnLoad(btn, true);
  try {
    await api('/kas-besar/winpay/tarik', { method: 'POST', body: { nominal, keterangan: ($('wp-ket') || {}).value || '' } });
    closeSheet(); toast('Dana Winpay ' + rupiah(nominal) + ' masuk kas besar', 'success');
    kbReload();
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}
async function openRiwayatWinpay() {
  openSheet('<h3><i class="fas fa-clock-rotate-left"></i> Riwayat Winpay</h3>' + spinner());
  try {
    const w = (await api('/kas-besar/winpay?limit=60')).data;
    const ket = { masuk: 'Dana Kios-K masuk', tarik: 'Tarik ke kas besar', potongan: 'Potongan MDR' };
    const rows = (w.riwayat || []).map((r) => `<div class="wp-rw">
        <div><b>${ket[r.jenis] || r.jenis}</b><small>${esc(wpTgl(r.tanggal))} · ${esc(r.keterangan || '')}${r.oleh && r.jenis === 'tarik' ? ' · ' + esc(r.oleh) : ''}</small></div>
        <span class="n ${r.jenis === 'tarik' ? 'min' : r.jenis === 'potongan' ? 'pot' : 'plus'}">${r.jenis === 'masuk' ? '+' : '−'}${rupiah(r.nominal)}</span></div>`).join('');
    openSheet(`<h3><i class="fas fa-clock-rotate-left"></i> Riwayat Winpay</h3>
      <div class="card-zl" style="display:flex;justify-content:space-between;font-size:12px;"><span>Saldo sekarang</span><b style="color:#6d28d9;">${rupiah(w.saldo)}</b></div>
      ${rows || emptyState('Belum ada transaksi Kios-K', 'fa-tablet-screen-button')}`);
  } catch (e) { openSheet(emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation')); }
}

async function openInputBeban() {
  openSheet(`<h3><i class="fas fa-money-bill-trend-up"></i> Input Beban</h3>
    <div class="tabs-zl" id="beban-tipe" style="margin-bottom:12px;">
      <button class="active" onclick="bebanSetTipe('realisasi')">Realisasi</button>
      <button onclick="bebanSetTipe('akrual')">Akrual</button>
    </div>
    <div id="beban-form">${spinner()}</div>`);
  KB._bebanTipe = 'realisasi';
  try {
    if (!KB.kategori.length) { const res = await api('/kas-besar/kategori'); KB.kategori = res.data || []; }
    if (!KB.kategoriAkrual.length) { const res = await api('/kas-besar/kategori-akrual'); KB.kategoriAkrual = res.data || []; }
    renderBebanForm();
  } catch (e) {
    $('beban-form').innerHTML = emptyState('Gagal memuat kategori. ' + e.message, 'fa-triangle-exclamation');
  }
}

function bebanSetTipe(t) {
  KB._bebanTipe = t;
  document.querySelectorAll('#beban-tipe button').forEach((b, i) => b.classList.toggle('active', (i === 0) === (t === 'realisasi')));
  renderBebanForm();
}

function renderBebanForm() {
  const akrual = KB._bebanTipe === 'akrual';
  const kat = akrual ? KB.kategoriAkrual : KB.kategori;
  if (!kat.length) {
    $('beban-form').innerHTML = emptyState(akrual ? 'Belum ada kategori beban akrual' : 'Belum ada kategori beban (set belanja_manager=1 di COA)', 'fa-ban');
    return;
  }
  const sel = `<select id="beban-coa" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
      ${kat.map((k) => `<option value="${k.id}">${esc(k.nama)}</option>`).join('')}</select>`;

  let extra = '';
  if (akrual) {
    // akrual: pilih bulan (default bulan aktif)
    const opsi = (KB.bulanList && KB.bulanList.length ? KB.bulanList : [KB.bulan]).filter(Boolean);
    if (KB.bulan && !opsi.includes(KB.bulan)) opsi.unshift(KB.bulan);
    extra = `<div class="field"><label>Bulan beban</label>
      <select id="beban-bulan" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
        ${opsi.map((b) => `<option value="${b}" ${b === KB.bulan ? 'selected' : ''}>${namaBulan(b)}</option>`).join('')}
      </select></div>
      <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 10px;"><i class="fas fa-circle-info"></i> Akrual = beban dicicil per bulan, dana mengendap di saldo teralokasi sampai jatuh tempo dibayar.</div>`;
  } else if (S.allowBackdate) {
    extra = `<div class="field"><label>Tanggal (backdate aktif)</label><input type="datetime-local" id="beban-tanggal"></div>`;
  }

  $('beban-form').innerHTML = `
    <div class="field"><label>Kategori</label>${sel}</div>
    <div class="field"><label>Nominal</label><input type="number" id="beban-nominal" placeholder="0" inputmode="numeric"></div>
    <div class="field"><label>Keterangan (opsional)</label><input type="text" id="beban-ket" placeholder="${akrual ? 'mis. Akrual sewa Juni' : 'mis. Gaji Juni'}"></div>
    ${extra}
    <button class="btn-zl btn-primary-zl" id="btn-beban" onclick="doInputBeban()"><i class="fas fa-check"></i> Simpan ${akrual ? 'Akrual' : 'Beban'}</button>`;
}

async function doInputBeban() {
  const akrual = KB._bebanTipe === 'akrual';
  const coa_id = Number($('beban-coa').value);
  const nominal = Number($('beban-nominal').value);
  const keterangan = $('beban-ket').value.trim();
  if (!coa_id || !nominal || nominal <= 0) { toast('Kategori & nominal wajib diisi', 'warning'); return; }
  const btn = $('btn-beban'); btnLoad(btn, true);
  try {
    if (akrual) {
      const bulan = $('beban-bulan') ? $('beban-bulan').value : KB.bulan;
      await api('/kas-besar/akrual', { method: 'POST', body: { coa_id, nominal, keterangan, bulan } });
      toast('Beban akrual dicatat', 'success');
    } else {
      const tglEl = $('beban-tanggal');
      const tanggal = tglEl && tglEl.value ? tglEl.value.replace('T', ' ') : undefined;
      await api('/kas-besar/beban', { method: 'POST', body: { coa_id, nominal, keterangan, tanggal } });
      toast('Beban dicatat', 'success');
    }
    closeSheet(); kbReload();
  } catch (e) { toast(e.message || 'Gagal simpan', 'danger'); btnLoad(btn, false); }
}

// Export Excel (2 sheet: Laba Rugi + Record mentah) pakai SheetJS
async function buatExcelKasBesar(data) {
  if (typeof XLSX === 'undefined') { toast('Library Excel belum dimuat', 'danger'); return; }
  const lr = data.ringkas.laba_rugi || {};
  const per = data.ringkas.periode || {};
  const rinc = lr.rincian || {};

  // Sheet 1: Laba Rugi
  const s1 = [['LABA RUGI', `${per.dari} s/d ${per.sampai}`], []];
  s1.push(['Saldo Total', data.ringkas.saldo_total]);
  s1.push(['Teralokasi (akrual)', data.ringkas.saldo_teralokasi]);
  s1.push(['Saldo Bebas', data.ringkas.saldo_bebas]); s1.push([]);
  const seksi = (judul, total, arr, tanda) => {
    s1.push([judul, (tanda || '') + total]);
    (arr || []).forEach((c) => s1.push(['  ' + c.nama, (tanda || '') + c.nominal]));
  };
  seksi('PENDAPATAN', lr.pendapatan, rinc.pendapatan, '');
  seksi('HPP', lr.hpp, rinc.cogs, '-'); s1.push(['Laba Kotor', lr.laba_kotor]);
  seksi('COS', lr.cos, rinc.cos, '-');
  seksi('OPEX', lr.opex, rinc.opex, '-'); s1.push(['LABA BERSIH', lr.laba_bersih]);

  // Sheet 2: Record mentah
  const head = ['Tanggal', 'Sisi', 'COA Kode', 'COA Nama', 'Sumber', 'Nominal', 'Keterangan'];
  const s2 = [head];
  (data.pendapatan || []).forEach((x) => s2.push([String(x.tanggal).slice(0, 19).replace('T', ' '), 'pendapatan', x.coa_kode, x.coa_nama, x.sumber, Number(x.nominal), x.keterangan || '']));
  (data.beban || []).forEach((x) => s2.push([String(x.tanggal).slice(0, 19).replace('T', ' '), 'beban', x.coa_kode, x.coa_nama, x.sumber, Number(x.nominal), x.keterangan || '']));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Laba Rugi');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Record');
  XLSX.writeFile(wb, `KasBesar_${(per.dari || '').slice(0, 7)}.xlsx`);
  toast('File Excel diunduh', 'success');
}

async function openInputDistribusi() {
  openSheet(`<h3><i class="fas fa-hand-holding-dollar"></i> Input Distribusi Laba</h3><div id="dist-form">${spinner()}</div>`);
  try {
    if (!KB.kategoriDistribusi || !KB.kategoriDistribusi.length) {
      const res = await api('/kas-besar/kategori-distribusi'); KB.kategoriDistribusi = res.data || [];
    }
    if (!KB.kategoriDistribusi.length) {
      $('dist-form').innerHTML = emptyState('Belum ada akun distribusi (set belanja_manager=1 di COA kewajiban investasi)', 'fa-ban');
      return;
    }
    const opsi = (KB.bulanList && KB.bulanList.length ? KB.bulanList : [KB.bulan]).filter(Boolean);
    if (KB.bulan && !opsi.includes(KB.bulan)) opsi.unshift(KB.bulan);
    $('dist-form').innerHTML = `
      <div class="field"><label>Akun</label>
        <select id="dist-coa" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
          ${KB.kategoriDistribusi.map((k) => `<option value="${k.id}">${esc(k.nama)}</option>`).join('')}
        </select></div>
      <div class="field"><label>Nominal</label><input type="number" id="dist-nominal" placeholder="0" inputmode="numeric"></div>
      <div class="field"><label>Keterangan (opsional)</label><input type="text" id="dist-ket" placeholder="mis. Share profit Mei"></div>
      <div class="field"><label>Bulan</label>
        <select id="dist-bulan" style="width:100%;border:1px solid var(--border);border-radius:12px;padding:13px 14px;font-size:14px;font-family:'Poppins';background:#fff;color:var(--text);">
          ${opsi.map((b) => `<option value="${b}" ${b === KB.bulan ? 'selected' : ''}>${namaBulan(b)}</option>`).join('')}
        </select></div>
      <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 10px;"><i class="fas fa-circle-info"></i> Distribusi laba = kirim bagian laba ke investor/operator. Mengurangi saldo total, bukan beban.</div>
      <button class="btn-zl btn-primary-zl" id="btn-dist" onclick="doInputDistribusi()"><i class="fas fa-check"></i> Simpan Distribusi</button>`;
  } catch (e) {
    $('dist-form').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

async function doInputDistribusi() {
  const coa_id = Number($('dist-coa').value);
  const nominal = Number($('dist-nominal').value);
  const keterangan = $('dist-ket').value.trim();
  const bulan = $('dist-bulan') ? $('dist-bulan').value : KB.bulan;
  if (!coa_id || !nominal || nominal <= 0) { toast('Akun & nominal wajib diisi', 'warning'); return; }
  const btn = $('btn-dist'); btnLoad(btn, true);
  try {
    await api('/kas-besar/distribusi', { method: 'POST', body: { coa_id, nominal, keterangan, bulan } });
    closeSheet(); toast('Distribusi laba dicatat', 'success');
    kbReload();
  } catch (e) { toast(e.message || 'Gagal simpan', 'danger'); btnLoad(btn, false); }
}
/* ============================================================
   CUSTOMER (kelola data)
   ============================================================ */
const CUST = { q: '', filter: 'semua', durasi: 7, offset: 0, limit: 20, items: [], adaLagi: false, timer: null, count: { semua: 0, baru: 0, loyal: 0, lepas: 0 } };

function loadCustomer() {
  const body = $('customer-body');
  body.innerHTML = `
    <div id="cust-frekuensi-chart" style="margin-bottom:12px;"></div>
    <div id="cust-stat-kunjungan"></div>
    <div class="search-zl"><i class="fas fa-search"></i><input type="text" id="cust-search" placeholder="Cari nama / telepon..." oninput="custSearch(this.value)"></div>
    <div class="tabs-zl tabs-zl-6" id="cust-tabs" style="margin:12px 0;"></div>
    <div id="cust-list"></div>`;
  const inp = $('cust-search'); if (inp) inp.value = CUST.q;
  renderCustTabs();
  custReload();
  loadFrekuensiChart();
  loadStatKunjungan();
}

/* ---- Perubahan #60: statistik kunjungan per hari (rata), per jam, antre (mesin penuh) ---- */
let _skCharts = [];
const fmtSk = (n) => String(n).replace('.', ',');
async function loadStatKunjungan() {
  const el = $('cust-stat-kunjungan'); if (!el) return;
  el.innerHTML = `<div class="card-zl" style="padding:12px;margin-bottom:12px;"><div class="sk-t"><i class="fas fa-chart-column"></i> Statistik kunjungan · 30 hari</div>${spinner()}</div>`;
  try {
    const d = (await api('/pelanggan/statistik-kunjungan')).data;
    _skCharts.forEach((c) => c.destroy()); _skCharts = [];
    const rentang = `${tglPendekSk(d.dari)} – ${tglPendekSk(d.sampai)}`;
    const hr = d.hari; const maxH = hr.reduce((a, b) => (b.rata > a.rata ? b : a), hr[0]); const minH = hr.reduce((a, b) => (b.rata < a.rata ? b : a), hr[0]);
    const jamUrut = [...d.jam].sort((a, b) => b.total - a.total);
    const NAMA = { Sen: 'Senin', Sel: 'Selasa', Rab: 'Rabu', Kam: 'Kamis', Jum: 'Jumat', Sab: 'Sabtu', Min: 'Minggu' };
    const an = d.antre; const totA = an.map((x) => r1Sk(x.cuci_rata + x.kering_rata)); const iMaxA = totA.indexOf(Math.max(...totA));
    const pad = (h) => String(h).padStart(2, '0') + ':00';
    el.innerHTML = `
      <div class="card-zl sk-c"><div class="sk-t"><i class="fas fa-calendar-week"></i> Kunjungan pelanggan per hari</div>
        <div class="sk-s">Rata-rata pelanggan per hari (bukan transaksi) · ${rentang}</div>
        <div class="sk-cv"><canvas id="sk-hari"></canvas></div>
        <div class="sk-k"><div>Paling ramai<b>${NAMA[maxH.label]} · ${fmtSk(maxH.rata)}</b></div><div>Paling sepi<b>${NAMA[minH.label]} · ${fmtSk(minH.rata)}</b></div></div></div>
      <div class="card-zl sk-c"><div class="sk-t"><i class="fas fa-clock"></i> Kunjungan pelanggan per jam</div>
        <div class="sk-s">Total pelanggan (bukan transaksi) · ${rentang}</div>
        <div class="sk-cv"><canvas id="sk-jam"></canvas></div>
        <div class="sk-k"><div>Jam sibuk<b>${pad(jamUrut[0].jam)} · ${jamUrut[0].total}</b></div><div>Jam sibuk ke-2<b>${pad(jamUrut[1].jam)} · ${jamUrut[1].total}</b></div></div></div>
      <div class="card-zl sk-c"><div class="sk-t"><i class="fas fa-layer-group"></i> Pelanggan harus antre (mesin penuh)</div>
        <div class="sk-s">Rata-rata per hari · bawah = cuci (semua washer terpakai), atas = kering (semua dryer terpakai) · ${rentang}</div>
        <div class="sk-cv"><canvas id="sk-antre"></canvas></div>
        <table class="sk-tb"><thead><tr><th></th>${an.map((x) => `<th>${x.label}</th>`).join('')}</tr></thead><tbody>
          <tr><td>% antre</td>${an.map((x) => `<td class="${x.persen >= 10 ? 'm' : x.persen >= 5 ? 'k' : ''}">${x.persen ? fmtSk(x.persen) + '%' : '0'}</td>`).join('')}</tr>
          <tr><td>Tunggu</td>${an.map((x) => `<td>${x.tunggu != null ? x.tunggu + "'" : '–'}</td>`).join('')}</tr>
        </tbody></table>
        <div class="sk-s" style="margin:4px 0 0;">% antre = proses yang antre ÷ semua proses cuci & kering hari itu. Tunggu = rata-rata menit sampai mesin pertama kosong. Merah ≥ 10%, kuning ≥ 5%.</div>
        <div class="sk-k"><div>Total 30 hari<b>${d.antre_total} dari ${Number(d.proses_total).toLocaleString('id-ID')} (${fmtSk(d.persen_total || 0)}%)</b></div><div>Paling sering<b>${d.antre_total ? `${NAMA[an[iMaxA].label]} · ${fmtSk(totA[iMaxA])}/hari` : '–'}</b></div><div>Rata² tunggu<b>${d.tunggu_rata != null ? d.tunggu_rata + ' menit' : '–'}</b></div></div></div>`;
    if (typeof Chart === 'undefined') return;
    const opsi = (ekstra = {}) => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,.2)' } }, x: { ticks: { font: { size: 10 } }, grid: { display: false } } }, ...ekstra });
    _skCharts.push(new Chart($('sk-hari').getContext('2d'), { type: 'bar',
      data: { labels: hr.map((x) => x.label), datasets: [{ label: 'Rata-rata pelanggan', data: hr.map((x) => x.rata), backgroundColor: hr.map((x) => (x === maxH ? '#1d4ed8' : '#60a5fa')), borderRadius: 5 }] },
      options: opsi({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtSk(c.raw)} pelanggan/hari (total ${hr[c.dataIndex].total}, ${hr[c.dataIndex].n_hari} hari)` } } } }) }));
    _skCharts.push(new Chart($('sk-jam').getContext('2d'), { type: 'bar',
      data: { labels: d.jam.map((x) => String(x.jam).padStart(2, '0')), datasets: [{ label: 'Pelanggan', data: d.jam.map((x) => x.total), backgroundColor: '#8b5cf6', borderRadius: 3 }] },
      options: opsi({ scales: { y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,.2)' } }, x: { ticks: { font: { size: 9 }, autoSkip: true, maxRotation: 0 }, grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => pad(Number(c[0].label)), label: (c) => ` ${c.raw} pelanggan` } } } }) }));
    _skCharts.push(new Chart($('sk-antre').getContext('2d'), { type: 'bar',
      data: { labels: an.map((x) => x.label), datasets: [
        { label: 'Cuci', data: an.map((x) => x.cuci_rata), backgroundColor: '#3b82f6', stack: 'a' },
        { label: 'Kering', data: an.map((x) => x.kering_rata), backgroundColor: '#f97316', stack: 'a', borderRadius: { topLeft: 5, topRight: 5 } }] },
      options: opsi({ plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: (c) => { const x = an[c.dataIndex]; const kr = c.datasetIndex === 1;
          const tg = kr ? x.tunggu_kering : x.tunggu_cuci;
          return ` ${c.dataset.label}: ${fmtSk(c.raw)}/hari · ${kr ? x.kering : x.cuci} dari ${kr ? x.proses_kering : x.proses_cuci} (${fmtSk(kr ? x.persen_kering : x.persen_cuci)}%)${tg != null ? ` · tunggu ±${tg}'` : ''}`; } } } },
        scales: { x: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 } }, grid: { color: 'rgba(148,163,184,.2)' } } } }) }));
  } catch (e) {
    el.innerHTML = `<div class="card-zl" style="padding:12px;margin-bottom:12px;font-size:12px;color:var(--text-muted);">Statistik kunjungan gagal dimuat. ${esc(e.message)}</div>`;
  }
}
const r1Sk = (n) => Math.round(n * 10) / 10;
function tglPendekSk(ymd) { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }

let _frekChart = null;
async function loadFrekuensiChart() {
  const el = $('cust-frekuensi-chart');
  if (!el) return;
  try {
    const res = await api('/pelanggan/frekuensi');
    const data = res.data || [];
    if (!data.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div class="card-zl" style="padding:12px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:8px;color:var(--text-muted);">
          <i class="fas fa-chart-bar"></i> Distribusi Frekuensi Kunjungan <span style="font-weight:600;color:var(--success);">(Pelanggan Loyal)</span>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px;">
          Sumbu X: tiap berapa hari sekali customer datang · Sumbu Y: jumlah customer · hanya pelanggan kategori Loyal (aktif 30 hari terakhir & pernah balik lagi) · klik batang buat lihat daftar pelanggannya
        </div>
        <div style="position:relative;height:160px;">
          <canvas id="frekuensi-chart-canvas"></canvas>
        </div>
      </div>`;

    const ctx = document.getElementById('frekuensi-chart-canvas').getContext('2d');
    if (_frekChart) { _frekChart.destroy(); _frekChart = null; }

    const labels = data.map(d => d.hari === 1 ? '1 hr' : d.hari + ' hr');
    const values = data.map(d => d.jumlah);

    // Highlight bar dengan frekuensi tertinggi
    const maxVal = Math.max(...values);
    const colors = values.map(v => v === maxVal ? '#1d4ed8' : '#93c5fd');

    _frekChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Jumlah Customer',
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const hari = data[elements[0].index].hari;
          openDurasiPelanggan(hari);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `Tiap ${items[0].label} sekali`,
              label: (item) => `${item.raw} customer`,
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 9 } }, grid: { color: '#f1f5f9' } }
        }
      }
    });
  } catch (e) {
    if (el) el.innerHTML = '';
  }
}

function renderCustTabs() {
  const c = CUST.count || { semua: 0, baru: 0, loyal: 0, lepas: 0, point: 0 };
  const tab = (key, label, n) => `<button class="${CUST.filter === key ? 'active' : ''}" onclick="custSetFilter('${key}')">${label}${n !== undefined ? ' (' + n + ')' : ''}</button>`;
  const el = $('cust-tabs');
  if (!el) return;
  // Perubahan #17: grid 2x3 + tab Point
  el.innerHTML = tab('semua', 'Semua', c.semua) + tab('baru', 'Baru', c.baru) + tab('loyal', 'Loyal', c.loyal)
    + tab('lepas', 'Lepas', c.lepas) + tab('durasi', 'Durasi') + tab('point', 'Point', c.point);
}

function custSetFilter(f) {
  CUST.filter = f;
  renderCustTabs();
  custReload();
}

function custSearch(v) {
  CUST.q = v.trim();
  if (CUST.timer) clearTimeout(CUST.timer);
  CUST.timer = setTimeout(() => custReload(), 350);
}

async function custReload() {
  CUST.offset = 0; CUST.items = [];
  const list = $('cust-list'); if (list) list.innerHTML = spinner();
  if (CUST.filter === 'durasi') { renderDurasiCards(); return; }
  await loadCustList(false);
}

async function loadCustList(append) {
  try {
    const durasParam = CUST.filter === 'durasi' ? `&durasi=${CUST.durasi}` : '';
    const qs = `?q=${encodeURIComponent(CUST.q)}&filter=${CUST.filter}${durasParam}&limit=${CUST.limit}&offset=${CUST.offset}`;
    const res = await api('/pelanggan' + qs);
    const d = res.data;
    CUST.adaLagi = d.ada_lagi;
    if (d.count) { CUST.count = d.count; renderCustTabs(); }
    CUST.items = append ? CUST.items.concat(d.items) : d.items;
    renderCustList();
  } catch (e) {
    $('cust-list').innerHTML = emptyState('Gagal memuat pelanggan. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderCustList() {
  if (CUST.filter === 'durasi') { renderDurasiCards(); return; }
  if (!CUST.items.length) {
    $('cust-list').innerHTML = emptyState('Tidak ada pelanggan', 'fa-user-slash');
    return;
  }
  let html = '';
  // Perubahan #17: ringkasan poin beredar di atas daftar tab Point
  if (CUST.filter === 'point' && CUST.count) {
    const c = CUST.count;
    html += `<div class="card-zl" style="display:flex;align-items:center;gap:12px;margin-bottom:10px;background:linear-gradient(135deg,#fef3c7,#fde68a);">
        <div style="width:42px;height:42px;border-radius:12px;background:#fff7;display:flex;align-items:center;justify-content:center;font-size:18px;color:#b45309;flex-shrink:0;"><i class="fas fa-star"></i></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;color:#92400e;font-weight:600;">Poin pelanggan belum ditukar</div>
          <div style="font-size:18px;font-weight:800;color:#78350f;">${Number(c.total_point || 0).toLocaleString('id-ID')} poin <span style="font-size:13px;font-weight:700;">≈ ${rupiah(c.nilai_point || 0)}</span></div>
          <div style="font-size:10px;color:#92400e;">${c.point || 0} pelanggan · 1 poin = ${rupiah(c.nilai_per_poin || 10)} · potensi diskon yang bisa ditukar</div>
        </div>
      </div>`;
  }
  html += CUST.items.map(custCard).join('');
  if (CUST.adaLagi) html += `<button class="btn-zl btn-light-zl" onclick="custMore()" style="margin-top:8px;">Muat lebih banyak</button>`;
  $('cust-list').innerHTML = html;
}

// ── DURASI CARDS ──────────────────────────────────────────────
let _durasiData = null;

async function renderDurasiCards() {
  const el = $('cust-list');
  if (!el) return;
  el.innerHTML = spinner();
  try {
    const res = await api('/pelanggan/frekuensi');
    _durasiData = res.data || [];
    if (!_durasiData.length) {
      el.innerHTML = emptyState('Belum ada data frekuensi kunjungan', 'fa-chart-bar');
      return;
    }
    el.innerHTML = _durasiData.map(d => {
      const label = d.hari === 1 ? 'Tiap hari' : `Tiap ${d.hari} hari sekali`;
      const totalPerHari = d.total_per_hari
        ? `Rp${d.total_per_hari.toLocaleString('id-ID')}/hari`
        : '';
      const avgPerHari = d.avg_omzet_per_pelanggan_per_hari
        ? `Rp${d.avg_omzet_per_pelanggan_per_hari.toLocaleString('id-ID')}/pelanggan/hari`
        : '';
      return `
        <div class="card-zl" style="display:flex;align-items:center;gap:12px;cursor:pointer;margin-bottom:8px;"
          onclick="openDurasiPelanggan(${d.hari})">
          <div style="width:48px;height:48px;border-radius:12px;background:var(--primary-light);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
            <div style="font-size:16px;font-weight:800;color:var(--primary);">${d.hari}</div>
            <div style="font-size:8px;color:var(--primary);line-height:1;">hari</div>
          </div>
          <div style="flex:1;">
            <div style="font-size:14px;font-weight:700;">${label}</div>
            <div style="font-size:11px;color:var(--text-muted);">${d.jumlah} pelanggan${totalPerHari ? ' · total ' + totalPerHari : ''}</div>
            <div style="font-size:10px;color:var(--text-muted);">${avgPerHari ? 'rata-rata ' + avgPerHari : ''}</div>
          </div>
          <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
        </div>`;
    }).join('');

    // Tambah forecast section setelah list cards
    await renderForecastSection();

  } catch (e) {
    el.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

async function renderForecastSection() {
  const el = $('cust-forecast');
  if (!el) return;
  el.innerHTML = spinner();
  try {
    const res = await api('/pelanggan/forecast');
    const d = res.data;
    const ri = d.bulan_ini;
    const rd = d.bulan_depan;
    const a = d.asumsi;

    el.innerHTML = `
      <div class="card-zl" style="margin-top:12px;background:linear-gradient(135deg,#1d4ed808,#0f6e5608);">
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:10px;">
          <i class="fas fa-chart-line"></i> Forecast Omzet (Repeat + Pelanggan Baru)
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
          <div style="padding:8px;background:var(--bg-soft);border-radius:10px;">
            <div style="font-size:10px;color:var(--text-muted);">Bulan Ini (${ri.hari_berjalan}/${ri.total_hari} hari)</div>
            <div style="font-size:15px;font-weight:800;color:var(--primary);">Rp${ri.forecast.toLocaleString('id-ID')}</div>
            <div style="font-size:10px;color:var(--text-muted);">realisasi Rp${ri.realisasi.toLocaleString('id-ID')}</div>
          </div>
          <div style="padding:8px;background:var(--bg-soft);border-radius:10px;">
            <div style="font-size:10px;color:var(--text-muted);">Bulan Depan (${rd.total_hari} hari)</div>
            <div style="font-size:15px;font-weight:800;color:var(--success);">Rp${rd.forecast.toLocaleString('id-ID')}</div>
            <div style="font-size:10px;color:var(--text-muted);">estimasi penuh</div>
          </div>
        </div>

        <div style="font-size:10px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px;line-height:1.8;">
          <b>Estimasi harian:</b> Rp${d.per_hari.total.toLocaleString('id-ID')}
          (repeat Rp${d.per_hari.repeat.toLocaleString('id-ID')} + baru Rp${d.per_hari.baru.toLocaleString('id-ID')})<br>
          <b>Aktual harian 30hr:</b> Rp${(d.per_hari.aktual_historis||0).toLocaleString('id-ID')} ← referensi<br>
          <b>Pelanggan baru 30 hr:</b> ${a.pelanggan_baru_30hr} orang
          (${a.baru_per_hari}/hari · avg 1st trx Rp${a.avg_first_omzet.toLocaleString('id-ID')})
        </div>
      </div>`;
  } catch (_) {}
}

async function openDurasiPelanggan(hari) {
  const label = hari === 1 ? 'Tiap hari' : `Tiap ${hari} hari sekali`;
  openSheet(`<h3><i class="fas fa-clock"></i> ${label}</h3><div id="durasi-plg-list">${spinner()}</div>`);
  try {
    const res = await api(`/pelanggan?filter=durasi&durasi=${hari}&limit=50&offset=0`);
    const items = res.data.items || [];
    if (!items.length) {
      $('durasi-plg-list').innerHTML = emptyState('Tidak ada pelanggan', 'fa-user-slash');
      return;
    }
    $('durasi-plg-list').innerHTML = items.map(p => `
      <div class="card-zl" style="display:flex;align-items:center;gap:12px;cursor:pointer;margin-bottom:8px;"
        onclick="openDurasiCustRiwayat(${p.id},'${esc(p.nama)}')">
        <div style="width:38px;height:38px;border-radius:50%;background:var(--bg-soft);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:var(--text-muted);flex-shrink:0;">
          ${(p.nama||'?').trim().slice(0,1).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;">${esc(p.nama)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${esc(p.telepon)} · ${p.kunjungan}x kunjungan · rata-rata tiap ${p.avg_selang||hari} hari</div>
        </div>
        <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
      </div>`).join('');
  } catch (e) {
    $('durasi-plg-list').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

async function openDurasiCustRiwayat(id, nama) {
  openSheet(`<h3>${esc(nama)}</h3><div id="durasi-cust-detail">${spinner()}</div>`);
  try {
    const res = await api(`/pelanggan/${id}/riwayat`);
    const d = res.data;
    const p = d.pelanggan;
    const trxList = d.transaksi || [];
    // Group by tanggal
    const byDate = {};
    trxList.forEach(t => {
      const tgl = (t.tanggal || '').slice(0, 10);
      if (!byDate[tgl]) byDate[tgl] = [];
      byDate[tgl].push(t);
    });
    const dates = Object.keys(byDate).sort((a,b) => b.localeCompare(a));
    let html = `
      <div class="card-zl" style="margin-bottom:10px;display:flex;gap:16px;font-size:12px;">
        <span><b>${p.kunjungan}</b> kunjungan</span>
        <span><b>${p.point}</b> poin</span>
        <span>${esc(p.telepon)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;font-weight:600;">Riwayat Kunjungan</div>`;
    if (!dates.length) {
      html += emptyState('Belum ada transaksi', 'fa-receipt');
    } else {
      html += dates.map(tgl => {
        const txs = byDate[tgl];
        const fmt = new Date(tgl).toLocaleDateString('id-ID', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
        const items = txs.map(t =>
          `<div onclick="openTransaksiDetailSheet(${t.id})" style="font-size:11px;color:var(--text-muted);padding:4px 0;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
            <span>${esc(t.no_invoice)} · Rp${(t.total||0).toLocaleString('id-ID')}</span>
            <i class="fas fa-chevron-right" style="color:var(--slate-light);font-size:9px;"></i>
          </div>`
        ).join('');
        return `
          <div style="margin-bottom:10px;">
            <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:4px;">📅 ${fmt}</div>
            ${items}
          </div>`;
      }).join('');
    }
    $('durasi-cust-detail').innerHTML = html;
  } catch (e) {
    $('durasi-cust-detail').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

function custCard(p) {
  const inisial = (p.nama || '?').trim().slice(0, 1).toUpperCase();
  const kategori = p.kategori || ((p.kedatangan || 0) > 1 ? 'loyal' : 'baru');
  const badgeMap = {
    baru:  { bg: 'var(--primary-light)', fg: 'var(--primary)', label: 'Baru' },
    loyal: { bg: 'var(--success-light)', fg: 'var(--success)', label: 'Loyal' },
    lepas: { bg: 'var(--danger-light)', fg: 'var(--danger)', label: 'Lepas' },
  };
  const bd = badgeMap[kategori] || badgeMap.baru;
  const badge = `<span style="font-size:10px;padding:2px 7px;border-radius:5px;background:${bd.bg};color:${bd.fg};">${bd.label}</span>`;

  // Format last_transaksi
  let lastTrx = '';
  if (p.last_transaksi) {
    const d = new Date(p.last_transaksi);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) lastTrx = 'hari ini';
    else if (diffDays === 1) lastTrx = 'kemarin';
    else if (diffDays < 7) lastTrx = diffDays + ' hari lalu';
    else if (diffDays < 30) lastTrx = Math.floor(diffDays/7) + ' minggu lalu';
    else lastTrx = Math.floor(diffDays/30) + ' bulan lalu';
  }

  let sub2;
  if (CUST.filter === 'point') {
    const nilai = Number(p.point || 0) * Number((CUST.count && CUST.count.nilai_per_poin) || 10);
    sub2 = `<b style="color:#b45309;">${Number(p.point).toLocaleString('id-ID')} poin ≈ ${rupiah(nilai)}</b> · ${p.kunjungan}x kunjungan${lastTrx ? ' · ' + lastTrx : ''}`;
  } else if (CUST.filter === 'durasi' && p.avg_selang) {
    const s = p.avg_selang;
    const selangLabel = s === 1 ? 'tiap hari' : `tiap ${s} hari sekali`;
    sub2 = `${p.kunjungan}x kunjungan · ${selangLabel} · ${p.point} poin${lastTrx ? ' · ' + lastTrx : ''}`;
  } else if (kategori === 'loyal') {
    sub2 = `${p.kunjungan}x kunjungan · ${p.point} poin${lastTrx ? ' · ' + lastTrx : ''}`;
  } else {
    sub2 = `${p.jml_transaksi}x transaksi · ${p.point} poin${lastTrx ? ' · ' + lastTrx : ''}`;
  }

  return `
    <div class="card-zl" style="display:flex;align-items:center;gap:12px;cursor:pointer;" onclick="openCustDetail(${p.id})">
      <div style="width:42px;height:42px;border-radius:50%;background:var(--bg-soft);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;">${esc(inisial)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;">${esc(p.nama)} ${badge}</div>
        <div style="font-size:11px;color:var(--text-muted);">${esc(p.telepon)} · ${sub2}</div>
      </div>
      <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
    </div>`;
}

function custById(id) { return CUST.items.find((p) => p.id === id); }

async function custMore() {
  CUST.offset += CUST.limit;
  await loadCustList(true);
}

async function openCustDetail(id) {
  const p = custById(id);
  openSheet(`<h3>${esc(p ? p.nama : 'Pelanggan')}</h3><div id="cust-detail">${spinner()}</div>`);
  try {
    const res = await api(`/pelanggan/${id}/riwayat`);
    renderCustDetail(res.data);
  } catch (e) {
    $('cust-detail').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

function renderCustDetail(d) {
  const p = d.pelanggan;
  let html = `
    <div class="card-zl" style="margin-bottom:10px;">
      <div style="font-size:12px;color:var(--text-muted);">${esc(p.telepon)}</div>
      <div style="display:flex;gap:14px;margin-top:6px;font-size:12px;">
        <span><b>${p.kunjungan}</b> kunjungan</span>
        <span><b>${p.point}</b> poin</span>
      </div>
      ${p.alamat ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;"><i class="fas fa-location-dot"></i> ${esc(p.alamat)}</div>` : ''}
      <button class="btn-zl btn-light-zl" style="margin-top:10px;" onclick="openEditCust(${p.id})"><i class="fas fa-pen"></i> Edit data</button>
    </div>`;
  html += `<div class="section-label"><i class="fas fa-clock-rotate-left"></i> Riwayat transaksi</div>`;
  if (!d.transaksi.length) {
    html += emptyState('Belum ada transaksi', 'fa-inbox');
  } else {
    html += `<div class="card-zl">` + d.transaksi.map((t) => `
      <div class="proc-row" style="cursor:pointer;" onclick="openTransaksiDetailSheet(${t.id})">
        <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${esc(t.no_invoice)}</div>
          <div style="font-size:10px;color:var(--text-muted);">${esc(String(t.tanggal).slice(0, 16).replace('T', ' '))} · ${esc(t.status_nama || t.status_kode || '-')}</div></div>
        <div style="font-weight:700;">${rupiah(t.total)}</div>
        <i class="fas fa-chevron-right" style="color:var(--slate-light);margin-left:8px;"></i>
      </div>`).join('') + `</div>`;
  }
  $('cust-detail').innerHTML = html;
}

/* ---------- DETAIL TRANSAKSI (dari riwayat customer / durasi) ---------- */
async function openTransaksiDetailSheet(trxId) {
  openSheet(`<h3><i class="fas fa-receipt"></i> Detail Pesanan</h3><div id="trx-detail-body">${spinner()}</div>`);
  try {
    const res = await api('/transaksi/' + trxId);
    TRXD.data = res.data;
    renderTransaksiDetailSheet(res.data);
  } catch (e) {
    $('trx-detail-body').innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation');
  }
}

const TRXD = { data: null };

function renderTransaksiDetailSheet(d) {
  const p = d.pelanggan || {};
  const items = d.items || [];
  const tgl = d.tanggal ? String(d.tanggal).slice(0, 16).replace('T', ' ') : '-';

  let html = `
    <div class="card-zl" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-size:14px;font-weight:700;">${esc(d.no_invoice || '-')}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(tgl)}</div>
        </div>
        <span class="badge-zl ${d.status_bayar === 'lunas' ? 'bz-done' : 'bz-wait'}" style="font-size:10px;">
          ${d.status_bayar === 'lunas' ? 'Lunas' : 'Belum Bayar'}
        </span>
      </div>
    </div>

    <div class="section-label"><i class="fas fa-user"></i> Pelanggan</div>
    <div class="card-zl">
      <div style="font-size:13px;font-weight:700;">${esc(p.nama || '-')}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(p.telepon || '-')}</div>
    </div>

    <div class="section-label"><i class="fas fa-list"></i> Item</div>
    <div class="card-zl">`;

  items.forEach((it) => {
    const q = Number(it.qty) || 1;
    html += `<div class="proc-row">
        <div style="flex:1;"><div style="font-size:12px;">${esc(it.nama_item)}${q > 1 ? ' ×' + q : ''}</div></div>
        <div style="font-weight:700;font-size:12px;">${rupiah(it.subtotal)}</div>
      </div>`;
  });

  html += `</div>
    <div class="card-zl">
      ${d.diskon > 0 ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--success);"><span>Diskon poin</span><span>− ${rupiah(d.diskon)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);">
        <span style="font-weight:700;">TOTAL</span>
        <span style="font-weight:800;font-size:16px;color:var(--primary);">${rupiah(d.total)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Metode: ${esc(labelMetode(d.metode_bayar).toUpperCase())}</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn-zl btn-light-zl" onclick="cetakStrukManager(false)" style="flex:1;font-size:12px;"><i class="fas fa-receipt"></i> Nota</button>
      <button class="btn-zl btn-light-zl" onclick="cetakStrukManager(true)" style="flex:1;font-size:12px;"><i class="fas fa-timeline"></i> + Timeline</button>
    </div>`;

  $('trx-detail-body').innerHTML = html;
}

/** Cetak nota — reuse logic sama dengan kasir, tapi pakai TRXD.data sebagai sumber. */
function cetakStrukManager(withTimeline) {
  const d = TRXD.data;
  if (!d) { toast('Data belum siap', 'warning'); return; }
  const p = d.pelanggan || {};
  const items = d.items || [];
  const cab = d.cabang || {};
  const outlet = cab.nama || 'Bilas Moro Laundry';
  const alamatCab = [cab.alamat, cab.kota].filter(Boolean).join(', ');
  const telpCab = cab.no_hp || '';
  const tgl = d.tanggal ? String(d.tanggal).slice(0, 16).replace('T', ' ') : '-';
  const krj = d.kode_keranjang || d.kode_antrian || '';
  const belumBayar = d.status_bayar !== 'lunas';
  const judulStruk = belumBayar ? 'NOTA TAGIHAN' : 'TANDA TERIMA';

  const barisItem = items.map((it) => {
    const q = Number(it.qty) || 1;
    let suffix = '';
    if (it.item_tipe === 'barang') {
      const sat = it.barang_satuan || 'pcs';
      suffix = ` ${q} ${sat}`;
    } else {
      const map = { per_load: 'Load', per_kg: 'Kg', per_km: 'Km', per_sachet: 'Sachet', per_pcs: 'pcs' };
      const sat = map[it.satuan_hitung];
      suffix = sat ? ` ${q} ${sat}` : (q > 1 ? ` ×${q}` : '');
    }
    return `<tr><td>${esc(it.nama_item)}${suffix}</td><td style="text-align:right;">${rupiah(it.subtotal)}</td></tr>`;
  }).join('');

  const riw = d.riwayat || [];
  let riwayatHtml = '';
  if (withTimeline && riw.length) {
    riwayatHtml = `<hr class="hr"><div class="c b">PROSES PENGERJAAN</div><table>`;
    riw.forEach((r) => {
      const mesin = r.kode_mesin ? ` (${esc(r.kode_mesin)})` : '';
      riwayatHtml += `<tr><td>${esc(r.nama || r.kode)}${mesin}</td><td style="text-align:right;white-space:nowrap;">${esc(strukWaktuMgr(r.waktu))}</td></tr>`;
    });
    riwayatHtml += `</table>`;
  }

  const sosLines = [];
  if (cab.link_gmap_review) sosLines.push(`Review Google: ${esc(cab.link_gmap_review)}`);
  if (cab.link_ig) sosLines.push(`Instagram: ${esc(cab.link_ig)}`);
  if (cab.link_fb) sosLines.push(`Facebook: ${esc(cab.link_fb)}`);
  if (cab.link_tiktok) sosLines.push(`TikTok: ${esc(cab.link_tiktok)}`);
  const sosmedHtml = sosLines.length
    ? `<hr class="hr"><div class="b c">Dukung kami & ikuti update:</div><div style="font-size:9px;word-break:break-all;text-align:left;">${sosLines.map((x) => '- ' + x).join('<br>')}</div>`
    : '';

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
    <div class="row" style="color:#16a34a;"><span>⭐ Tukar ${Math.round(d.diskon / 10)} poin</span><span class="r">- ${rupiah(d.diskon)}</span></div>` : ''}
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
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-9999px;top:0;';
  const style = document.createElement('style'); style.textContent = css;
  const el = document.createElement('div'); el.className = 'struk'; el.innerHTML = isi;
  wrap.appendChild(style); wrap.appendChild(el); document.body.appendChild(wrap);

  toast('Membuat nota...', 'success');
  html2canvas(el, { scale: 2, backgroundColor: '#ffffff' }).then((canvas) => {
    const jpg = canvas.toDataURL('image/jpeg', 0.92);
    document.body.removeChild(wrap);

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
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }).catch((e) => {
    document.body.removeChild(wrap);
    toast('Gagal membuat nota: ' + e.message, 'danger');
  });
}

function strukWaktuMgr(w) {
  if (!w) return '-';
  const s = String(w);
  return s.slice(11, 16);
}

function openEditCust(id) {
  const p = custById(id);
  openSheet(`
    <h3><i class="fas fa-pen"></i> Edit Pelanggan</h3>
    <div class="field"><label>Nama</label><input type="text" id="cust-nama" value="${esc(p ? p.nama : '')}"></div>
    <div class="field"><label>Telepon</label><input type="text" id="cust-telepon" value="${esc(p ? p.telepon : '')}" inputmode="numeric"></div>
    <div class="field"><label>Alamat</label><input type="text" id="cust-alamat" value="${esc(p && p.alamat ? p.alamat : '')}" placeholder="opsional"></div>
    <button class="btn-zl btn-primary-zl" id="btn-cust-simpan" onclick="doEditCust(${id})"><i class="fas fa-check"></i> Simpan</button>`);
}

async function doEditCust(id) {
  const nama = $('cust-nama').value.trim();
  const telepon = $('cust-telepon').value.trim();
  const alamat = $('cust-alamat').value.trim();
  if (!nama || !telepon) { toast('Nama & telepon wajib diisi', 'warning'); return; }
  const btn = $('btn-cust-simpan'); btnLoad(btn, true);
  try {
    await api(`/pelanggan/${id}`, { method: 'PATCH', body: { nama, telepon, alamat } });
    closeSheet(); toast('Data pelanggan diperbarui', 'success');
    custReload();
  } catch (e) { toast(e.message || 'Gagal simpan', 'danger'); btnLoad(btn, false); }
}

/* ---------- BOOT ---------- */
/* Perubahan #75: pembaruan dashboard di latar tiap 1 menit (tanpa kedip) */
let _autoRefreshMgr = null;
function startAutoRefreshMgr() {
  if (_autoRefreshMgr) clearInterval(_autoRefreshMgr);
  _autoRefreshMgr = setInterval(() => {
    if (S.token && S.currentPage === 'dashboard' && document.visibilityState === 'visible' && !document.querySelector('.sheet.show, .sheet-overlay.show')) loadDashboard({ diam: true });
  }, 60000);
}
function boot() {
  loadSession();
  startAutoRefreshMgr();
  if (S.token && S.user && CFG.ALLOWED_ROLES.includes(S.user.role)) enterApp();
  else showScreen('login');
}
document.addEventListener('DOMContentLoaded', boot);


/* ============================================================
   Perubahan #40 -- BARANG (stok, harga, foto)
   ============================================================ */
// Perubahan #58: tab Layanan (on/off oleh OWNER) + searchbox per tab
const BRG = { data: null, coa: [], tab: 'layanan', q: '', qs: { layanan: '', laundry: '', cafe: '' }, filter: 'semua', layanan: null };
const brgCari = (id) => (BRG.data || []).find((b) => b.id === Number(id));
function brgVisual(b, besar = false) {
  const IK = window.IK3D;
  const foto = IK && b.foto_v ? IK.fotoUrl(API, b) : null;
  if (foto) return `<img src="${foto}" alt="" ${besar ? `onclick="brgZoom(${b.id})"` : ''}>`;
  const ik = IK ? IK.ikonBarang(b) : { g: 'g-sabun', ico: 'fa-box' };
  return `<div class="ik-ico ${ik.g}"><i class="fas ${ik.ico}"></i></div>`;
}
async function loadBarang() {
  const body = $('barang-body'); if (!body) return;
  if (!BRG.data) body.innerHTML = spinner();
  try {
    const [rb, rl] = await Promise.all([api('/master/kelola-barang'), api('/master/kelola-layanan').catch(() => null)]);
    const r = rb.data;
    BRG.data = r.barang; BRG.coa = r.coa || [];
    BRG.layanan = rl ? rl.data || [] : [];
    renderBarang();
  } catch (e) { body.innerHTML = emptyState('Gagal memuat barang. ' + e.message, 'fa-triangle-exclamation'); }
}
function renderBarang() {
  const all = BRG.data || [];
  const n = (k) => all.filter((b) => b.kategori === k).length;
  const tabs = `<div class="brg-tabs"><button class="${BRG.tab === 'layanan' ? 'on' : ''}" onclick="brgTab('layanan')">Layanan (${(BRG.layanan || []).length})</button><button class="${BRG.tab === 'laundry' ? 'on' : ''}" onclick="brgTab('laundry')">Laundry (${n('laundry')})</button><button class="${BRG.tab === 'cafe' ? 'on' : ''}" onclick="brgTab('cafe')">Cafe (${n('cafe')})</button></div>`;
  const cari = (ph) => `<div class="brg-sr"><i class="fas fa-magnifying-glass"></i><input id="brg-cari" placeholder="${ph}" value="${esc(BRG.q)}" oninput="brgCariKetik(this.value)"></div>`;
  if (BRG.tab === 'layanan') {
    const L = BRG.layanan || [];
    const on = L.filter((l) => l.status === 'aktif').length;
    $('barang-body').innerHTML = `${tabs}${cari('Cari layanan')}
      <div class="brg-chips">
        <button class="${BRG.filter === 'semua' ? 'on' : ''}" onclick="brgFilter('semua')">Semua</button>
        <button class="${BRG.filter === 'aktif' ? 'on' : ''}" onclick="brgFilter('aktif')"><i class="fas fa-circle-check" style="color:#16a34a"></i> Aktif (${on})</button>
        <button class="${BRG.filter === 'nonaktif' ? 'on' : ''}" onclick="brgFilter('nonaktif')">Nonaktif (${L.length - on})</button>
      </div>
      ${S.user && S.user.role === 'owner' ? '' : '<div class="lyk-info"><i class="fas fa-lock"></i> On/off layanan dikendalikan owner. Manager hanya melihat.</div>'}
      <div id="brg-list"></div><div style="height:${S.user && S.user.role === 'owner' ? 70 : 20}px"></div>
      ${S.user && S.user.role === 'owner' ? '<button class="brg-fab" onclick="lykForm()"><i class="fas fa-plus"></i> Layanan baru</button>' : ''}`;
    renderLayananList();
    return;
  }
  const tab = all.filter((b) => b.kategori === BRG.tab);
  const low = tab.filter((b) => b.menipis).length;
  const off = tab.filter((b) => b.status === 'nonaktif').length;
  const ada = tab.filter((b) => b.status === 'aktif' && b.stok_terkini > 0).length;
  $('barang-body').innerHTML = `${tabs}${cari('Cari barang')}
    <div class="brg-chips">
      <button class="${BRG.filter === 'semua' ? 'on' : ''}" onclick="brgFilter('semua')">Semua</button>
      <button class="${BRG.filter === 'tersedia' ? 'on' : ''}" onclick="brgFilter('tersedia')"><i class="fas fa-circle-check" style="color:#16a34a"></i> Tersedia (${ada})</button>
      <button class="r ${BRG.filter === 'menipis' ? 'on' : ''}" onclick="brgFilter('menipis')"><i class="fas fa-triangle-exclamation"></i> Stok menipis (${low})</button>
      <button class="${BRG.filter === 'nonaktif' ? 'on' : ''}" onclick="brgFilter('nonaktif')">Nonaktif (${off})</button>
    </div>
    <div id="brg-list"></div><div style="height:70px"></div>
    <button class="brg-fab" onclick="brgTambah()"><i class="fas fa-plus"></i> Barang baru</button>`;
  renderBarangList();
}
function brgTab(t) { BRG.qs[BRG.tab] = BRG.q; BRG.tab = t; BRG.q = BRG.qs[t] || ''; BRG.filter = 'semua'; renderBarang(); }
function brgFilter(f) { BRG.filter = f; renderBarang(); }
function brgCariKetik(v) {
  BRG.q = v; BRG.qs[BRG.tab] = v;
  if (BRG.tab === 'layanan') renderLayananList(); else renderBarangList();
}

/* ---- Perubahan #58: daftar layanan + on/off (owner) ---- */
const LYK_GRUP = [
  { k: ['cuci'], lbl: 'Cuci', ico: 'fa-soap' },
  { k: ['kering'], lbl: 'Kering', ico: 'fa-wind' },
  { k: ['lipat', 'setrika_lipat', 'drop_off', 'antar', 'antar_jemput', 'jemput'], lbl: 'Lipat · Setrika · Drop-off · Antar · Jemput', ico: 'fa-shirt' },
];
const LYK_SATUAN = { per_load: 'load', per_kg: 'kg', per_km: 'km' };
const LYK_PROMO = { gratis_cuci_pelanggan_baru: 'Gratis cuci pelanggan baru', gratis_cuci_jumat_berkah: 'Gratis cuci Jumat Berkah' };
/* Perubahan #59: tambah / edit layanan (OWNER). Durasi Cuci & Kering dikunci saat edit. */
const LYK_KAT = [['cuci', 'Cuci'], ['kering', 'Kering'], ['drop_off', 'Drop-off'], ['lipat', 'Lipat'], ['setrika_lipat', 'Setrika lipat'], ['antar', 'Antar'], ['antar_jemput', 'Antar jemput'], ['jemput', 'Jemput']];
const LYK_SAT_KAT = { cuci: 'per_load', kering: 'per_load', drop_off: 'per_load', lipat: 'per_kg', setrika_lipat: 'per_kg', antar: 'per_km', antar_jemput: 'per_km', jemput: 'per_km' };
function lykForm(id) {
  const l = id ? (BRG.layanan || []).find((x) => Number(x.id) === Number(id)) : null;
  if (id && !l) return;
  const kat = l ? l.kategori : 'cuci';
  const promo = l && Number(l.is_promo);
  const f = (fid, label, val, extra = '') => `<div class="field"><label>${label}</label><input type="text" id="${fid}" value="${esc(val == null ? '' : val)}" ${extra}></div>`;
  const durKunci = l && (kat === 'cuci' || kat === 'kering');
  openSheet(`<h3><i class="fas ${l ? 'fa-pen' : 'fa-plus'}"></i> ${l ? 'Edit layanan · ' + esc(l.nama_paket) : 'Layanan baru'}</h3>
    ${f('lk-nama', 'Nama layanan', l ? l.nama_paket : '', promo ? 'disabled' : 'maxlength="100"')}
    <div class="lyk-g2">
      ${l ? f('', 'Kategori <i class="fas fa-lock"></i>', (LYK_KAT.find((k) => k[0] === kat) || [0, kat])[1], 'disabled')
        : `<div class="field"><label>Kategori</label><select id="lk-kat" onchange="lykKat()">${LYK_KAT.map((k) => `<option value="${k[0]}">${k[1]}</option>`).join('')}</select></div>`}
      ${f('lk-sat', 'Satuan <i class="fas fa-lock"></i>', 'per ' + (LYK_SATUAN[l ? l.satuan_hitung : LYK_SAT_KAT[kat]] || '-'), 'disabled')}
      ${f('lk-harga', 'Harga (Rp)', l ? Math.round(Number(l.harga)).toLocaleString('id-ID') : '', 'inputmode="numeric"')}
      <div id="lk-dur-w">${f('lk-dur', `Durasi (menit)${durKunci ? ' <i class="fas fa-lock"></i>' : ''}`, l ? (l.durasi_menit ?? '') : '', durKunci || promo ? 'disabled' : 'inputmode="numeric"')}</div>
      <div id="lk-berat-w">${f('lk-berat', 'Berat maks (kg)', l && l.berat_maks != null ? Number(l.berat_maks) : '', promo ? 'disabled' : 'inputmode="decimal" placeholder="kosong = tanpa batas"')}</div>
      ${l ? '' : '<div class="field"><label>Status</label><select id="lk-status"><option value="aktif">Aktif</option><option value="nonaktif">Nonaktif</option></select></div>'}
    </div>
    <div class="field"><label>Deskripsi</label><textarea id="lk-desk" rows="2" maxlength="255" placeholder="Catatan (tidak tampil di kartu customer/kasir)">${esc(l && l.deskripsi ? l.deskripsi : '')}</textarea></div>
    <div class="lyk-note">${durKunci ? 'Durasi Cuci / Kering dikunci karena dipakai timer mesin. Buat layanan baru kalau perlu durasi lain. ' : ''}${promo ? 'Layanan promo: hanya harga & deskripsi yang bisa diubah. ' : ''}Harga baru berlaku untuk pesanan baru; pesanan lama tetap harga lama.</div>
    <div class="ow-b2" style="display:flex;gap:8px;"><button class="btn-zl btn-light-zl" style="flex:1" onclick="closeSheet()">Batal</button><button class="btn-zl btn-primary-zl" style="flex:1" id="btn-lk" onclick="lykSimpan(${l ? l.id : 0})"><i class="fas fa-check"></i> Simpan</button></div>`);
  lykKat(kat);
}
function lykKat(k) {
  const kat = k || ($('lk-kat') && $('lk-kat').value) || 'cuci';
  if ($('lk-sat') && $('lk-kat')) $('lk-sat').value = 'per ' + (LYK_SATUAN[LYK_SAT_KAT[kat]] || '-');
  if ($('lk-dur-w')) $('lk-dur-w').style.display = ['cuci', 'kering', 'antar', 'antar_jemput', 'jemput'].includes(kat) ? '' : 'none';
  if ($('lk-berat-w')) $('lk-berat-w').style.display = kat === 'cuci' ? '' : 'none';
}
async function lykSimpan(id) {
  const v = (x) => ($(x) && !$(x).disabled ? $(x).value.trim() : undefined);
  const body = { nama_paket: v('lk-nama'), harga: v('lk-harga'), deskripsi: $('lk-desk') ? $('lk-desk').value.trim() : undefined };
  const kat = id ? ((BRG.layanan || []).find((x) => Number(x.id) === Number(id)) || {}).kategori : v('lk-kat');
  if (['cuci', 'kering', 'antar', 'antar_jemput', 'jemput'].includes(kat)) body.durasi_menit = v('lk-dur');
  if (kat === 'cuci') body.berat_maks = v('lk-berat');
  if (!id) { body.kategori = kat; body.status = v('lk-status'); }
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const btn = $('btn-lk'); btnLoad(btn, true);
  try {
    const r = await api(id ? `/master/kelola-layanan/${id}` : '/master/kelola-layanan', { method: id ? 'PUT' : 'POST', body });
    const d = r.data;
    if (id) BRG.layanan = BRG.layanan.map((x) => (Number(x.id) === Number(id) ? d : x)); else BRG.layanan.push(d);
    closeSheet(); toast(id ? 'Layanan disimpan' : 'Layanan ditambahkan', 'success');
    const rl = await api('/master/kelola-layanan').catch(() => null); if (rl) BRG.layanan = rl.data || BRG.layanan;
    renderBarang();
  } catch (e) { toast(e.message || 'Gagal menyimpan', 'danger'); btnLoad(btn, false); }
}

function renderLayananList() {
  const el = $('brg-list'); if (!el) return;
  const q = BRG.q.trim().toLowerCase();
  const owner = S.user && S.user.role === 'owner';
  let list = BRG.layanan || [];
  if (BRG.filter === 'aktif') list = list.filter((l) => l.status === 'aktif');
  if (BRG.filter === 'nonaktif') list = list.filter((l) => l.status !== 'aktif');
  if (q) list = list.filter((l) => (l.nama_paket || '').toLowerCase().includes(q) || (l.kategori || '').replace('_', ' ').includes(q));
  const IK = window.IK3D;
  let h = '';
  LYK_GRUP.forEach((g) => {
    const isi = list.filter((l) => g.k.includes(l.kategori));
    if (!isi.length) return;
    h += `<div class="lyk-g"><i class="fas ${g.ico}"></i> ${g.lbl}</div>`;
    h += isi.map((l) => {
      const ik = IK ? IK.ikonLayanan(l.kategori) : { g: 'g-cuci', ico: 'fa-soap' };
      const promo = Number(l.is_promo);
      const ket = promo ? (LYK_PROMO[l.jenis_promo] || 'Promo')
        : `${rupiah(l.harga)} / ${LYK_SATUAN[l.satuan_hitung] || '-'}${l.durasi_menit ? ` · ${l.durasi_menit} mnt` : ''}`;
      const aktif = l.status === 'aktif';
      return `<div class="lyk-it ${aktif ? '' : 'off'}">
        <div class="ik-ico ${ik.g}"><i class="fas ${ik.ico}"></i></div>
        <div class="tx"><b>${esc(l.nama_paket)}</b><small>${promo ? '<span class="lyk-tag">PROMO</span>' : ''}${ket}</small>${l.deskripsi ? `<span class="lyk-ds">${esc(l.deskripsi)}</span>` : ''}</div>
        ${owner ? `<button class="lyk-ed" onclick="lykForm(${l.id})" aria-label="Edit ${esc(l.nama_paket)}"><i class="fas fa-pen"></i></button>` : ''}
        <button class="lyk-tg ${aktif ? 'on' : ''}" ${owner ? `onclick="lykToggle(${l.id})"` : 'disabled'} aria-label="${aktif ? 'Matikan' : 'Aktifkan'} ${esc(l.nama_paket)}"></button>
      </div>`;
    }).join('');
  });
  el.innerHTML = h || emptyState('Tidak ada layanan', 'fa-magnifying-glass');
}
async function lykToggle(id) {
  const l = (BRG.layanan || []).find((x) => Number(x.id) === Number(id)); if (!l) return;
  const baru = l.status === 'aktif' ? 'nonaktif' : 'aktif';
  const lama = l.status;
  l.status = baru; renderLayananList(); // optimis
  try {
    await api(`/master/kelola-layanan/${id}/status`, { method: 'PATCH', body: { status: baru } });
    toast(`${l.nama_paket} ${baru === 'aktif' ? 'diaktifkan' : 'dimatikan'}`, 'success');
    renderBarang();
  } catch (e) {
    l.status = lama; renderLayananList();
    toast(e.message || 'Gagal menyimpan', 'danger');
  }
}
function renderBarangList() {
  const q = BRG.q.trim().toLowerCase();
  let list = (BRG.data || []).filter((b) => b.kategori === BRG.tab);
  if (BRG.filter === 'menipis') list = list.filter((b) => b.menipis);
  if (BRG.filter === 'tersedia') list = list.filter((b) => b.status === 'aktif' && b.stok_terkini > 0); // Perubahan #41: yang tampil di kasir & customer
  if (BRG.filter === 'nonaktif') list = list.filter((b) => b.status === 'nonaktif');
  if (q) list = list.filter((b) => b.nama.toLowerCase().includes(q));
  // menipis dulu, lalu aktif sesuai urutan, nonaktif terakhir
  list.sort((a, b) => (a.status === 'nonaktif') - (b.status === 'nonaktif') || (b.menipis - a.menipis) || a.urutan - b.urutan || a.nama.localeCompare(b.nama));
  $('brg-list').innerHTML = list.length ? list.map((b) => `
    <div class="brg-it ${b.menipis ? 'low' : ''} ${b.status === 'nonaktif' ? 'off' : ''}" onclick="brgBuka(${b.id})">
      <div class="f">${brgVisual(b)}</div>
      <div style="min-width:0;"><b>${esc(b.nama)}</b><small>${b.status === 'nonaktif' ? 'Nonaktif · ' : ''}Jual ${rupiah(b.harga_jual)} · Beli ${rupiah(b.harga_beli)}</small></div>
      <div class="st"><b>${b.stok_terkini}</b><br>min ${b.stok_minimum}</div>
      <button class="lyk-tg ${b.status === 'aktif' ? 'on' : ''}" onclick="event.stopPropagation();brgToggle(${b.id})" aria-label="${b.status === 'aktif' ? 'Matikan' : 'Aktifkan'} ${esc(b.nama)}"></button>
    </div>`).join('') : emptyState('Tidak ada barang', 'fa-box-open');
}
/* Perubahan #59: on/off barang langsung dari daftar (manager & owner) */
async function brgToggle(id) {
  const b = brgCari(id); if (!b) return;
  const lama = b.status; const baru = lama === 'aktif' ? 'nonaktif' : 'aktif';
  b.status = baru; renderBarangList();
  try {
    const r = await api(`/master/kelola-barang/${id}`, { method: 'PUT', body: { status: baru } });
    if (r.data) Object.assign(b, r.data);
    toast(`${b.nama} ${baru === 'aktif' ? 'diaktifkan' : 'dimatikan'}`, 'success');
    renderBarang();
  } catch (e) { b.status = lama; renderBarangList(); toast(e.message || 'Gagal menyimpan', 'danger'); }
}
function brgField(id, label, val, type = 'text', extra = '') {
  return `<div class="field"><label>${label}</label><input type="${type}" id="${id}" value="${esc(val == null ? '' : val)}" ${extra}></div>`;
}
function brgBuka(id) {
  const b = brgCari(id); if (!b) return;
  openSheet(`
    <h3>${esc(b.nama)}</h3>
    <div class="brg-big">${brgVisual(b, true)}</div>
    <input type="file" id="brg-kamera" accept="image/*" capture="environment" style="display:none" onchange="brgFoto(${id}, this)">
    <input type="file" id="brg-file" accept="image/*" style="display:none" onchange="brgFoto(${id}, this)">
    <div class="brg-ftb">
      <button onclick="$('brg-kamera').click()"><i class="fas fa-camera"></i> Kamera</button>
      <button onclick="$('brg-file').click()"><i class="fas fa-image"></i> Pilih gambar</button>
      ${b.foto_v ? `<button style="color:#b91c1c" title="Hapus foto" onclick="brgHapusFoto(${id})"><i class="fas fa-trash"></i></button>` : ''}
    </div>
    ${brgField('brg-nama', 'Nama barang', b.nama)}
    <div class="brg-g2">
      ${brgField('brg-jual', 'Harga jual', b.harga_jual, 'text', 'inputmode="numeric"')}
      ${brgField('brg-beli', 'Harga beli', b.harga_beli, 'text', 'inputmode="numeric"')}
      ${brgField('brg-min', 'Stok minimum', b.stok_minimum, 'text', 'inputmode="numeric"')}
      ${brgField('brg-urut', 'Urutan tampil', b.urutan, 'text', 'inputmode="numeric"')}
      ${brgField('brg-satuan', 'Satuan', b.satuan)}
      <div class="field"><label>Kategori</label><select id="brg-kat"><option value="laundry" ${b.kategori === 'laundry' ? 'selected' : ''}>Laundry</option><option value="cafe" ${b.kategori === 'cafe' ? 'selected' : ''}>Cafe</option></select></div>
    </div>
    <label class="brg-tg"><span>Aktif (tampil di kasir &amp; customer)</span><input type="checkbox" id="brg-aktif" ${b.status === 'aktif' ? 'checked' : ''}></label>
    <div class="brg-stk ${b.menipis ? 'low' : ''}"><small>Stok sekarang</small><div class="n">${b.stok_terkini} <small>${esc(b.satuan)}${b.menipis ? ' · di bawah minimum' : ''}</small></div></div>
    <div class="brg-b2">
      <button class="btn-zl btn-primary-zl" onclick="brgStokMasuk(${id})"><i class="fas fa-plus"></i> Stok masuk</button>
      <button class="btn-zl btn-light-zl" onclick="brgOpname(${id})"><i class="fas fa-clipboard-check"></i> Stok opname</button>
    </div>
    <div style="font-size:12px;font-weight:800;margin:4px 0;">Riwayat stok</div>
    <div id="brg-mutasi">${spinner()}</div>
    <div class="brg-b2" style="margin-top:12px;"><button class="btn-zl btn-light-zl" onclick="closeSheet()">Tutup</button><button class="btn-zl btn-primary-zl" id="btn-brg-simpan" onclick="brgSimpan(${id})"><i class="fas fa-check"></i> Simpan</button></div>`);
  brgMuatMutasi(id);
}
async function brgMuatMutasi(id) {
  try {
    const rows = (await api(`/master/kelola-barang/${id}/mutasi?limit=30`)).data;
    if (!$('brg-mutasi')) return;
    $('brg-mutasi').innerHTML = rows.length ? rows.map((m) => `<div class="brg-rw"><span>${esc(String(m.waktu).slice(8, 10) + '/' + String(m.waktu).slice(5, 7) + ' ' + String(m.waktu).slice(11, 16))} · ${esc(m.keterangan || m.ref_tipe)}<small>${esc(m.karyawan || '')} · ${m.sebelum} → ${m.sesudah}</small></span><span class="${m.jenis === 'masuk' ? 'p' : 'm'}">${m.jenis === 'masuk' ? '+' : '−'}${m.qty}</span></div>`).join('')
      : '<div style="font-size:12px;color:var(--text-muted);">Belum ada riwayat stok.</div>';
  } catch (e) { if ($('brg-mutasi')) $('brg-mutasi').innerHTML = `<div style="font-size:12px;color:var(--danger);">${esc(e.message)}</div>`; }
}
const brgAngka = (id) => ($(id) ? $(id).value.replace(/[^\d]/g, '') : '');
async function brgSimpan(id) {
  const btn = $('btn-brg-simpan'); btnLoad(btn, true);
  try {
    const r = await api(`/master/kelola-barang/${id}`, { method: 'PUT', body: {
      nama: $('brg-nama').value.trim(), harga_jual: brgAngka('brg-jual'), harga_beli: brgAngka('brg-beli') || 0,
      stok_minimum: brgAngka('brg-min') || 0, urutan: brgAngka('brg-urut') || 0, satuan: $('brg-satuan').value.trim(),
      kategori: $('brg-kat').value, status: $('brg-aktif').checked ? 'aktif' : 'nonaktif',
    } });
    brgGanti(r.data); closeSheet(); toast('Barang disimpan', 'success');
  } catch (e) { toast(e.message || 'Gagal menyimpan', 'danger'); btnLoad(btn, false); }
}
function brgGanti(baru) {
  const i = (BRG.data || []).findIndex((b) => b.id === baru.id);
  if (i >= 0) BRG.data[i] = { ...BRG.data[i], ...baru }; else (BRG.data = BRG.data || []).push(baru);
  if (S.currentPage === 'barang') renderBarang();
}
async function brgFoto(id, input) {
  const file = input.files && input.files[0]; if (!file) return;
  try {
    const data = await window.IK3D.kecilkanFoto(file);
    const r = await api(`/master/barang/${id}/foto`, { method: 'PUT', body: { data } });
    brgGanti({ id, foto_v: r.data.foto_v }); toast('Foto disimpan', 'success'); brgBuka(id);
  } catch (e) { toast(e.message || 'Gagal menyimpan foto', 'danger'); }
}
async function brgHapusFoto(id) {
  if (!confirm('Hapus foto barang ini? Kartu kembali memakai ikon.')) return;
  try { await api(`/master/barang/${id}/foto`, { method: 'DELETE' }); brgGanti({ id, foto_v: null }); toast('Foto dihapus', 'success'); brgBuka(id); }
  catch (e) { toast(e.message, 'danger'); }
}
function brgZoom(id) {
  const b = brgCari(id); if (!b || !b.foto_v) return;
  window.open(window.IK3D.fotoUrl(API, b), '_blank');
}
function brgStokMasuk(id) {
  const b = brgCari(id); if (!b) return;
  openSheet(`<h3><i class="fas fa-plus" style="color:var(--primary)"></i> Stok masuk · ${esc(b.nama)}</h3>
    <div class="brg-g2">
      ${brgField('brg-qty', 'Jumlah masuk', '', 'text', `inputmode="numeric" placeholder="0" oninput="$('brg-jadi').value=${b.stok_terkini}+(Number(this.value.replace(/[^0-9]/g,''))||0)"`)}
      ${brgField('brg-jadi', 'Stok jadi', b.stok_terkini, 'text', 'disabled')}
    </div>
    ${brgField('brg-ket', 'Catatan (opsional)', '', 'text', 'placeholder="mis. belanja Indogrosir"')}
    <div style="font-size:11px;color:var(--text-muted);margin:-2px 0 10px;">Hanya menambah stok, tidak dicatat di Kas Besar.</div>
    <div class="brg-b2"><button class="btn-zl btn-light-zl" onclick="brgBuka(${id})">Batal</button><button class="btn-zl btn-primary-zl" id="btn-brg-masuk" onclick="brgSimpanMasuk(${id})"><i class="fas fa-check"></i> Simpan</button></div>`);
}
async function brgSimpanMasuk(id) {
  const qty = brgAngka('brg-qty');
  if (!(Number(qty) > 0)) { toast('Isi jumlah masuk', 'warning'); return; }
  const btn = $('btn-brg-masuk'); btnLoad(btn, true);
  try {
    const r = await api(`/master/kelola-barang/${id}/stok-masuk`, { method: 'POST', body: { qty, keterangan: $('brg-ket').value.trim() } });
    brgGanti(r.data); toast(`Stok masuk +${qty}`, 'success'); brgBuka(id);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}
function brgOpname(id) {
  const b = brgCari(id); if (!b) return;
  openSheet(`<h3><i class="fas fa-clipboard-check" style="color:var(--primary)"></i> Stok opname · ${esc(b.nama)}</h3>
    <div class="brg-g2">
      ${brgField('brg-sis', 'Di sistem', b.stok_terkini, 'text', 'disabled')}
      ${brgField('brg-fisik', 'Hitungan fisik', '', 'text', `inputmode="numeric" placeholder="0" oninput="brgSelisih(${b.stok_terkini})"`)}
    </div>
    <div class="brg-sel" id="brg-selisih"></div>
    ${brgField('brg-alasan', 'Alasan (wajib)', '', 'text', 'placeholder="mis. 1 sachet bocor"')}
    <div class="brg-b2"><button class="btn-zl btn-light-zl" onclick="brgBuka(${id})">Batal</button><button class="btn-zl btn-primary-zl" id="btn-brg-opname" onclick="brgSimpanOpname(${id})"><i class="fas fa-check"></i> Simpan</button></div>`);
}
function brgSelisih(sis) {
  const v = brgAngka('brg-fisik'); const el = $('brg-selisih'); if (!el) return;
  if (v === '') { el.textContent = ''; return; }
  const d = Number(v) - sis;
  el.textContent = d === 0 ? 'Tidak ada selisih' : `Selisih ${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  el.style.color = d === 0 ? 'var(--text-muted)' : (d > 0 ? '#047857' : '#b91c1c');
}
async function brgSimpanOpname(id) {
  const fisik = brgAngka('brg-fisik'); const alasan = $('brg-alasan').value.trim();
  if (fisik === '') { toast('Isi hitungan fisik', 'warning'); return; }
  if (!alasan) { toast('Alasan wajib diisi', 'warning'); return; }
  const btn = $('btn-brg-opname'); btnLoad(btn, true);
  try {
    const r = await api(`/master/kelola-barang/${id}/opname`, { method: 'POST', body: { stok_fisik: fisik, alasan } });
    brgGanti(r.data); toast(r.data.selisih ? `Stok disesuaikan (${r.data.selisih > 0 ? '+' : ''}${r.data.selisih})` : 'Stok sudah sesuai', 'success'); brgBuka(id);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}
function brgTambah() {
  const coa = BRG.coa || [];
  openSheet(`<h3><i class="fas fa-plus"></i> Barang baru</h3>
    ${brgField('brg-nama', 'Nama barang', '', 'text', 'placeholder="mis. Rinso Cair Sachet"')}
    <div class="brg-g2">
      <div class="field"><label>Kategori</label><select id="brg-kat" onchange="brgCoaDefault()"><option value="laundry" ${BRG.tab === 'laundry' ? 'selected' : ''}>Laundry</option><option value="cafe" ${BRG.tab === 'cafe' ? 'selected' : ''}>Cafe</option></select></div>
      ${brgField('brg-satuan', 'Satuan', 'pcs')}
      ${brgField('brg-jual', 'Harga jual', '', 'text', 'inputmode="numeric" placeholder="0"')}
      ${brgField('brg-beli', 'Harga beli', '', 'text', 'inputmode="numeric" placeholder="0"')}
      ${brgField('brg-awal', 'Stok awal', '0', 'text', 'inputmode="numeric"')}
      ${brgField('brg-min', 'Stok minimum', '0', 'text', 'inputmode="numeric"')}
      ${brgField('brg-urut', 'Urutan tampil', '100', 'text', 'inputmode="numeric"')}
    </div>
    ${coa.length ? `<div class="field"><label>Akun penjualan</label><select id="brg-coa">${coa.map((c) => `<option value="${c.id}">${esc(c.kode)} · ${esc(c.nama)}</option>`).join('')}</select></div>` : ''}
    <div style="font-size:11px;color:var(--text-muted);margin:-2px 0 10px;">Foto bisa ditambahkan setelah barang disimpan.</div>
    <div class="brg-b2"><button class="btn-zl btn-light-zl" onclick="closeSheet()">Batal</button><button class="btn-zl btn-primary-zl" id="btn-brg-tambah" onclick="brgSimpanBaru()"><i class="fas fa-check"></i> Simpan</button></div>`);
  brgCoaDefault();
}
function brgCoaDefault() {
  const sel = $('brg-coa'); if (!sel) return;
  const kat = $('brg-kat').value;
  // default: akun yang paling sering dipakai barang sekategori
  const hitung = {};
  (BRG.data || []).filter((b) => b.kategori === kat).forEach((b) => { hitung[b.coa_id] = (hitung[b.coa_id] || 0) + 1; });
  const top = Object.entries(hitung).sort((a, b) => b[1] - a[1])[0];
  const kode = kat === 'cafe' ? '4-205' : '4-201';
  const pilih = top ? top[0] : ((BRG.coa || []).find((c) => c.kode === kode) || {}).id;
  if (pilih) sel.value = String(pilih);
}
async function brgSimpanBaru() {
  const nama = $('brg-nama').value.trim(); const jual = brgAngka('brg-jual');
  if (!nama) { toast('Nama barang wajib diisi', 'warning'); return; }
  if (jual === '') { toast('Isi harga jual', 'warning'); return; }
  const btn = $('btn-brg-tambah'); btnLoad(btn, true);
  try {
    const r = await api('/master/kelola-barang', { method: 'POST', body: {
      nama, kategori: $('brg-kat').value, satuan: $('brg-satuan').value.trim() || 'pcs', harga_jual: jual, harga_beli: brgAngka('brg-beli') || 0,
      stok_awal: brgAngka('brg-awal') || 0, stok_minimum: brgAngka('brg-min') || 0, urutan: brgAngka('brg-urut') || 100,
      coa_id: $('brg-coa') ? $('brg-coa').value : undefined,
    } });
    BRG.tab = r.data.kategori; brgGanti(r.data); toast('Barang ditambahkan', 'success'); brgBuka(r.data.id);
  } catch (e) { toast(e.message || 'Gagal menambah', 'danger'); btnLoad(btn, false); }
}
