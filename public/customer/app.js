/* ============================================================
   ZLaundry Customer App v2 — app.js
   Identitas = nomor HP (tanpa login formal). Cabang via GPS.
   ============================================================ */
const CFG = window.APP_CONFIG;
const API = CFG.API_BASE;
const MAX_BERAT = CFG.MAX_BERAT_KG;
const RADIUS_KM = CFG.RADIUS_LAYANAN_KM;

const $ = (id) => document.getElementById(id);

/* ---------- STATE ---------- */
const S = {
  cabang: null,        // cabang terpilih { id, kode, nama, latitude, longitude, ... }
  cabangList: [],
  myLoc: null,         // { lat, lng } posisi customer (kalau GPS allow)
  hp: null,            // nomor HP customer (login implicit)
  pelanggan: null,     // { id, nama, telepon, alamat, point } kalau sudah dikenal
  katalog: null,       // { layanan, barang }
  order: blankOrder(),
  currentPage: 'pesan',
  detailFrom: 'aktif',
  map: null, marker: null,
  // Section mana di form Pesan yang lagi "dibuka" (accordion) -- UI doang,
  // bukan bagian order, makanya dipisah dari S.order & gak ke-reset tiap
  // renderPesanForm(). Default TERTUTUP (lihat toggleSectionExpand()).
  expandSection: { tambahan: false, laundry: false, cafe: false },
};

function blankOrder() {
  return { berat_kg: '', cuci: false, kering: null, kering_manual: false, lipat: null,
           antar: null, antar_km: '', dropoffQty: 0, produk: {}, alamat_antar: '',
           nama: '', hp: '', metode: 'cash', pakaiPoin: false, poin_dipakai: 0,
           promo_pilihan: null, promo_label: null, cafeSearch: '', kering_pernah: false };
}

/* ---------- localStorage (ingat HP & cabang di device) ---------- */
function rememberHp(hp) { try { localStorage.setItem(CFG.LS_HP_KEY, hp); } catch (e) {} }
function forgetHp() { try { localStorage.removeItem(CFG.LS_HP_KEY); } catch (e) {} }
function loadHp() { try { return localStorage.getItem(CFG.LS_HP_KEY); } catch (e) { return null; } }
function rememberCabang(id) { try { localStorage.setItem(CFG.LS_CABANG_KEY, String(id)); } catch (e) {} }
function loadCabangId() { try { return Number(localStorage.getItem(CFG.LS_CABANG_KEY)) || null; } catch (e) { return null; } }

/* ---------- API helper ---------- */
async function api(path, { method = 'GET', body = null } = {}) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(API + path, opt);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (!res.ok) {
    const msg = (json && json.message) || `Error ${res.status}`;
    const err = new Error(msg);
    err.code = json && json.code;
    err.details = json && json.details;
    throw err;
  }
  return json;
}

/* ---------- UI util ---------- */
function showScreen(name) {
  ['loading', 'cabang', 'telp', 'app'].forEach((s) => {
    const el = $('screen-' + s);
    if (el) el.classList.toggle('active', s === name);
  });
}
function toast(msg, type = '', ms = 3000) {
  const w = $('toast-wrap');
  const t = document.createElement('div');
  t.className = 'toast-zl' + (type ? ' t-' + type : '');
  t.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'times-circle' : type === 'warning' ? 'exclamation-circle' : 'info-circle'}"></i><span>${esc(msg)}</span>`;
  w.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rupiah(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtDate(s, withTime = true) {
  if (!s) return '-';
  const d = (s instanceof Date) ? s : new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return s;
  const opt = withTime ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' };
  return d.toLocaleString('id-ID', opt);
}
// Cuma jam:menit -- buat baris "Mulai 19.08" di kartu ticket biar gak
// ngulang tanggal yang udah ada di baris lain.
function fmtJam(s) {
  if (!s) return '-';
  const d = (s instanceof Date) ? s : new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return '-';
  return d.toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function spinner() { return '<div class="spinner-zl"></div>'; }
function emptyState(text, icon = 'fa-inbox') { return `<div class="empty-zl"><i class="fas ${icon}"></i><p>${esc(text)}</p></div>`; }
function btnLoad(btn, on) {
  if (!btn) return;
  if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Memproses...'; }
  else { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
}
function openSheet(html) { $('sheet-content').innerHTML = html; $('sheet-bg').classList.add('active'); }
function closeSheet() { $('sheet-bg').classList.remove('active'); }
function closeSheetBackdrop(e) { if (e.target.id === 'sheet-bg') closeSheet(); }

/* ---------- Geolocation ---------- */
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no-geo'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- BOOT ---------- */
async function boot() {
  showScreen('loading');
  $('loading-msg').textContent = 'Memuat cabang...';
  try {
    const res = await api('/customer/cabang');
    S.cabangList = (res.data || []).filter((c) => c.status ? c.status === 'aktif' : true);
  } catch (e) {
    renderCabangPanel('error', 'Gagal terhubung ke server. Coba lagi.');
    showScreen('cabang');
    return;
  }
  if (S.cabangList.length === 0) {
    renderCabangPanel('error', 'Belum ada cabang tersedia.');
    showScreen('cabang');
    return;
  }

  // Udah pernah pilih cabang sebelumnya (localStorage) -> LANGSUNG pakai itu,
  // gak perlu deteksi GPS lagi tiap buka app. GPS cuma buat kunjungan PERTAMA
  // (belum pernah pilih cabang sama sekali).
  const savedCabangId = loadCabangId();
  if (savedCabangId) {
    const saved = S.cabangList.find((c) => c.id === savedCabangId);
    if (saved) {
      S.cabang = saved;
      showScreen('cabang');
      gateTelp();
      return;
    }
    // cabang tersimpan udah gak ada/nonaktif -> lanjut alur normal (GPS/manual) di bawah
  }

  // coba GPS
  showScreen('cabang');
  renderCabangPanel('detecting');
  try {
    const loc = await getLocation();
    S.myLoc = loc;
    pilihCabangByGps(loc);
  } catch (e) {
    // izin ditolak / gagal -> pilih manual
    renderCabangPanel('manual');
  }
}

function pilihCabangByGps(loc) {
  // hitung cabang terdekat
  let nearest = null, best = Infinity;
  for (const c of S.cabangList) {
    if (c.latitude == null || c.longitude == null) continue;
    const d = haversineKm(loc.lat, loc.lng, Number(c.latitude), Number(c.longitude));
    if (d < best) { best = d; nearest = c; }
  }
  if (!nearest) { renderCabangPanel('manual'); return; }

  if (best > RADIUS_KM) {
    renderCabangPanel('outofrange', `Cabang terdekat (${nearest.nama}) berjarak ${best.toFixed(1)} km — di luar jangkauan layanan ${RADIUS_KM} km.`);
    return;
  }
  // dalam jangkauan -> kunci cabang, masuk gate telp
  S.cabang = nearest;
  S.cabang._jarak = best;
  rememberCabang(nearest.id);
  gateTelp();
}

function pilihCabangManual(id) {
  const c = S.cabangList.find((x) => x.id === Number(id));
  if (!c) return;
  S.cabang = c;
  rememberCabang(c.id);
  gateTelp();
}

/* Gate nomor telp: kalau sudah ada HP tersimpan -> langsung masuk; kalau belum -> minta input. */
async function gateTelp() {
  const savedHp = loadHp();
  if (savedHp) { S.hp = savedHp; await enterApp(); return; }
  // tampilkan layar input telp
  const info = $('telp-cabang-info');
  if (info) info.innerHTML = `<i class="fas fa-store"></i> ${esc(S.cabang.nama)}${S.cabang._jarak != null ? ` · ${S.cabang._jarak.toFixed(1)} km` : ''}`;
  showScreen('telp');
  setTimeout(() => { const i = $('telp-input'); if (i) i.focus(); }, 100);
}

async function submitTelp() {
  const inp = $('telp-input');
  const hp = (inp ? inp.value : '').trim();
  if (!hp || hp.replace(/\D/g, '').length < 8) { toast('Nomor HP tidak valid', 'warning'); return; }
  const btn = $('btn-telp'); btnLoad(btn, true);
  S.hp = hp; rememberHp(hp);
  await enterApp();
  btnLoad(btn, false);
}

/* render isi panel cabang sesuai kondisi */
function renderCabangPanel(mode, msg) {
  const p = $('cabang-panel');
  if (mode === 'detecting') {
    p.innerHTML = `
      <div class="gate-icon-sm gi-loc"><i class="fas fa-location-crosshairs"></i></div>
      <h2>Mendeteksi lokasi…</h2>
      <p class="sub">Kami cari outlet terdekat dari posisimu. Izinkan akses lokasi ya.</p>
      <div class="spinner-zl" style="margin:10px auto 0;"></div>`;
    return;
  }
  if (mode === 'manual') {
    const opts = S.cabangList.map((c) => `<option value="${c.id}">${esc(c.nama)}${c.kota ? ' - ' + esc(c.kota) : ''}</option>`).join('');
    p.innerHTML = `
      <div class="gate-icon-sm gi-warn"><i class="fas fa-map-location-dot"></i></div>
      <h2>Pilih Outlet</h2>
      <p class="sub">Lokasi tidak terdeteksi. Pilih outlet terdekat dari kamu.</p>
      <div class="field"><select id="cabang-select">${opts}</select></div>
      <button class="btn-zl btn-primary-zl" onclick="pilihCabangManual($('cabang-select').value)">Lanjut</button>
      <button class="btn-zl btn-light-zl" style="margin-top:10px;" onclick="boot()"><i class="fas fa-location-crosshairs"></i> Coba deteksi lokasi lagi</button>`;
    return;
  }
  if (mode === 'outofrange') {
    p.innerHTML = `
      <div class="gate-icon-sm gi-deny"><i class="fas fa-face-frown"></i></div>
      <h2>Belum Terjangkau</h2>
      <p class="sub">${esc(msg)}</p>
      <button class="btn-zl btn-light-zl" onclick="renderCabangPanel('manual')">Pilih outlet manual</button>
      <button class="btn-zl btn-primary-zl" style="margin-top:10px;" onclick="boot()">Coba lagi</button>`;
    return;
  }
  if (mode === 'error') {
    p.innerHTML = `
      <div class="gate-icon-sm gi-deny"><i class="fas fa-triangle-exclamation"></i></div>
      <h2>Ada Masalah</h2>
      <p class="sub">${esc(msg || 'Terjadi kesalahan.')}</p>
      <button class="btn-zl btn-primary-zl" onclick="boot()">Coba lagi</button>`;
    return;
  }
  p.innerHTML = spinner();
}

/* ---------- MASUK APP ---------- */
async function enterApp() {
  showScreen('app');
  if (S.hp) {
    try {
      const loc = S.myLoc || {};
      const latlng = loc.lat != null ? `&lat=${loc.lat}&lng=${loc.lng}` : '';
      const res = await api(`/customer/lookup?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}${latlng}`);
      if (res.data && res.data.found) S.pelanggan = res.data.pelanggan;
      else S.pelanggan = null;
    } catch (e) { /* abaikan */ }
  }
  refreshNavLock();
  // Perubahan #34: ada pesanan aktif di cabang ini -> tab Aktif; kosong -> Pesan
  let adaAktif = false;
  if (S.hp) {
    try {
      const r = await api(`/customer/riwayat?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}&tab=aktif`);
      adaAktif = (r.data || []).length > 0;
    } catch (e) { /* abaikan -> ke Pesan */ }
  }
  navTo(adaAktif ? 'aktif' : 'pesan');
}

/* ---------- Perubahan #34: ganti outlet cepat (tanpa masuk ulang) ---------- */
function isiChipOutlet() {
  const nama = S.cabang ? S.cabang.nama : '-';
  document.querySelectorAll('.ph-outlet-nama').forEach((el) => { el.textContent = nama; });
}
function bukaGantiOutlet() {
  const list = (S.cabangList || []).map((c) => {
    let jarak = null;
    if (S.myLoc && c.latitude != null && c.longitude != null) jarak = haversineKm(S.myLoc.lat, S.myLoc.lng, Number(c.latitude), Number(c.longitude));
    return { ...c, _j: jarak };
  }).sort((a, b) => (a._j == null ? 1e9 : a._j) - (b._j == null ? 1e9 : b._j));
  const cur = S.cabang ? S.cabang.id : null;
  openSheet(`<h3><i class="fas fa-right-left"></i> Ganti Outlet</h3>
    <div style="font-size:12px;color:var(--text-muted);margin:-4px 0 12px;">Pilih outlet, langsung pindah tanpa masuk ulang.</div>
    ${list.map((c) => `<div class="ik-cab ${c.id === cur ? 'sel' : ''}" onclick="pilihOutletCepat(${c.id})">
        <i class="fas fa-store" style="color:${c.id === cur ? 'var(--primary)' : '#64748b'};"></i>
        <div class="nm">${esc(c.nama)}<small>${esc(c.kode || '')}${c.kota ? ' · ' + esc(c.kota) : ''}${c._j != null ? ' · ' + c._j.toFixed(1) + ' km' : ''}</small></div>
        ${c.id === cur ? '<span class="ik-ok" style="position:static;"><i class="fas fa-check"></i></span>' : '<i class="fas fa-chevron-right" style="color:#94a3b8;"></i>'}
      </div>`).join('')}`);
}
async function pilihOutletCepat(id) {
  const c = (S.cabangList || []).find((x) => x.id === Number(id));
  if (!c) return;
  closeSheet();
  if (S.cabang && S.cabang.id === c.id) return;
  S.cabang = { ...c };
  if (S.myLoc && c.latitude != null) S.cabang._jarak = haversineKm(S.myLoc.lat, S.myLoc.lng, Number(c.latitude), Number(c.longitude));
  rememberCabang(c.id);
  S.katalog = null; S.pelanggan = null; S.order = blankOrder();
  toast('Pindah ke ' + c.nama, 'success');
  if (S.hp) await enterApp(); else gateTelp();
}

/* kunci menu selain Pesan kalau belum dikenal (belum ada HP tersimpan) */
function refreshNavLock() {
  const dikenal = !!S.hp; // sudah masukin nomor telp = boleh akses semua menu
  ['aktif', 'selesai', 'profil'].forEach((nav) => {
    const a = document.querySelector(`#footer-nav a[data-nav="${nav}"]`);
    if (a) a.classList.toggle('locked', !dikenal);
  });
}

/* ---------- NAV ---------- */
function navTo(page) {
  // guard: menu terkunci kalau belum masukin nomor telp
  if (['aktif', 'selesai', 'profil'].includes(page) && !S.hp) {
    toast('Masukkan nomor HP dulu', 'warning');
    return;
  }
  S.currentPage = page;
  if (page !== 'pesan') { const tb = document.getElementById('total-bar'); if (tb) tb.remove(); }
  isiChipOutlet();
  document.querySelectorAll('.app-page').forEach((p) => p.classList.remove('active'));
  const pg = $('page-' + page);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('#footer-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  window.scrollTo(0, 0);

  if (page === 'pesan') loadPesan();
  else if (page === 'aktif') loadAktif();
  else if (page === 'selesai') loadSelesai();
  else if (page === 'profil') loadProfil();
}

document.addEventListener('DOMContentLoaded', boot);

/* ============================================================
   PAGE: PESAN
   ============================================================ */
async function loadPesan() {
  // header
  $('pesan-nama').textContent = (S.pelanggan && S.pelanggan.nama) ? S.pelanggan.nama : 'Pelanggan';
  $('pesan-outlet').textContent = S.cabang ? (S.cabang.nama + (S.cabang._jarak != null ? ` · ${S.cabang._jarak.toFixed(1)} km` : '')) : '-';

  const body = $('pesan-body');
  if (!S.katalog) {
    body.innerHTML = spinner();
    try {
      const res = await api(`/customer/katalog?cabang_id=${S.cabang.id}`);
      S.katalog = res.data || { layanan: [], barang: [] };
    } catch (e) {
      body.innerHTML = emptyState('Gagal memuat layanan. ' + e.message, 'fa-triangle-exclamation');
      return;
    }
  }
  renderPesanForm();
}

/* ambil layanan per kategori dari katalog */
function layananByKat(kat) { return (S.katalog.layanan || []).filter((l) => l.kategori === kat); }

/** Render daftar barang (qty stepper) untuk 1 grup kategori. onQtyFn = nama function global utk +/-. */
function renderBarangQtyList(list, produkState, onQtyFn) {
  return list.map((b) => {
    const qty = produkState[b.id] || 0;
    return `
      <div class="qty-row">
        <div class="qr-info"><div class="qr-name">${esc(b.nama)}</div><div class="qr-price">${rupiah(b.harga_jual)}</div></div>
        <div class="qty-stepper">
          <button onclick="${onQtyFn}(${b.id}, -1)" ${qty <= 0 ? 'disabled' : ''}>−</button>
          <span class="qv">${qty}</span>
          <button onclick="${onQtyFn}(${b.id}, 1)">+</button>
        </div>
      </div>`;
  }).join('');
}
function layananPertama(kat) { const a = layananByKat(kat); return a.length ? a[0] : null; }

/**
 * Pilih baris "Cuci" yang sesuai berat (kg). Kalau cabang cuma punya 1 baris
 * Cuci (kasus normal/lama), langsung balikin itu -- flat price, berat tidak
 * relevan. Kalau ada >1 (tier harga per berat), cari yang berat_maks-nya
 * cukup (urut dari kapasitas terkecil), fallback ke yang paling besar/tanpa
 * batas kalau beratnya melebihi semua tier.
 * CATATAN: ini cuma buat PREVIEW harga di layar -- keputusan FINAL & yang
 * sebenarnya dipakai tetap dari server (lihat transaksi.service.js), jadi
 * aman walau perhitungan di sini meleset dikit.
 */
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

function renderPesanForm() {
  const o = S.order;
  const cuciL = pilihCuci(window.IK3D.beratHitung(o.berat_kg));
  const keringList = layananByKat('kering');
  // grup LIPAT (eksklusif): 'lipat' + 'setrika_lipat'
  const lipatGrup = [...layananByKat('lipat'), ...layananByKat('setrika_lipat')];
  // grup ANTAR (eksklusif): 'antar' + 'antar_jemput'
  const antarGrup = [...layananByKat('antar'), ...layananByKat('antar_jemput'), ...layananByKat('jemput')]; // #73
  const dropL = layananPertama('drop_off');
  const barang = S.katalog.barang || [];

  let html = '';

  // sapaan / data pemesan di ATAS
  if (S.pelanggan) {
    html += `<div class="welcome-strip"><i class="fas fa-hand-sparkles"></i> Selamat datang lagi, <b>${esc(S.pelanggan.nama)}</b>! Poin kamu: ${S.pelanggan.point || 0}</div>`;
  } else {
    // pelanggan baru: minta HP + nama di paling atas
    html += `<div class="section-label"><i class="fas fa-id-card"></i> Data Pemesan</div>`;
    html += `
      <div class="card-zl">
        <div class="field">
          <label>Nomor HP (WhatsApp aktif)</label>
          <input type="tel" id="ord-hp" placeholder="08xxxxxxxxxx" inputmode="numeric" value="${esc(o.hp || S.hp || '')}" oninput="onHpInput()">
          <div class="hint">Untuk notifikasi status cucian via WhatsApp.</div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Nama</label>
          <input type="text" id="ord-nama" placeholder="Nama kamu" value="${esc(o.nama || '')}" oninput="onNamaInput()">
        </div>
      </div>`;
  }

  // ===== Perubahan #35: kartu ikon 3D =====
  const IK = window.IK3D;
  const bH = IK.beratHitung(o.berat_kg);
  const bAsli = Number(o.berat_kg) || 0;

  // BERAT (desimal, koma/titik; harga memakai berat dibulatkan)
  html += `
    <div class="section-label"><i class="fas fa-weight-hanging"></i> Berat Cucian</div>
    <div class="ik-berat"><div class="ik-ico g-berat"><i class="fas fa-weight-hanging"></i></div>
      <div class="ik-bin"><label for="ord-berat">Berat cucian</label>
        <div class="ik-brow">
          <button type="button" onclick="geserBerat(-0.1)">−</button>
          <div class="v"><input class="vin" id="ord-berat" inputmode="decimal" autocomplete="off" placeholder="0" value="${IK.fmtBerat(o.berat_kg)}" style="width:${IK.lebarBerat(IK.fmtBerat(o.berat_kg))}" oninput="onOrderChange()" onblur="onBeratBlur()"> <small>kg</small></div>
          <button type="button" onclick="geserBerat(0.1)">+</button>
        </div>
        <div class="ik-bh" id="ord-berat-info">${beratInfoTeks(bAsli, bH)}</div>
      </div>
    </div>`;

  // LAYANAN UTAMA: Cuci + tiap durasi Kering (kartu sama besar, 2 kolom)
  html += `<div class="section-label"><i class="fas fa-star"></i> Layanan Utama <span style="font-weight:400;font-size:11px;">(wajib pilih min. 1)</span></div><div class="ik-grid2">`;
  if (cuciL) {
    // Perubahan #87: tombol promo cuma tampil kalau ada promo buat pelanggan ini (atau lagi dipakai)
    muatPromo(o.hp || S.hp || '');
    const promo = o.cuci ? `<div class="ik-promo" id="ord-promo" style="${o.promo_pilihan || adaPromo() ? '' : 'display:none;'}" onclick="event.stopPropagation();openPromoSheet()"><i class="fas fa-gift"></i> ${o.promo_pilihan ? esc(o.promo_label || 'Promo dipakai') : 'Gunakan Promo'}</div>` : '';
    html += IK.tile({ sel: o.cuci, ...IK.ikonLayanan('cuci'), nama: 'Cuci', desc: cuciL.berat_maks ? `s/d ${Number(cuciL.berat_maks)} kg · per load` : 'per load',
      harga: rupiah(cuciL.harga), onclick: 'toggleCuci()', extra: promo });
  }
  // Perubahan #52: satu kartu Kering, berputar tiap diklik
  if (keringList.length) html += IK.tileKering(o, keringList, pilihLayananKeringOtomatis(IK.beratHitung(o.berat_kg)), rupiah, 'putarKeringKartu()');
  html += `</div>`;

  const adaUtama = o.cuci || !!o.kering;
  const antarKat = o.antar ? (S.katalog.layanan.find((l) => l.id === o.antar) || {}).kategori : null;
  const isAntarJemput = antarKat === 'antar_jemput';

  // LAYANAN TAMBAHAN (tertutup default, terbuka kalau diklik / sudah ada pilihan)
  const dq0 = o.dropoffQty || 0;
  const tambahanAdaPilihan = !!o.lipat || !!o.antar || dq0 > 0;
  const tambahanExpanded = S.expandSection.tambahan || tambahanAdaPilihan;
  const tambahanRingkasan = [
    o.lipat ? (lipatGrup.find((h) => h.id === o.lipat) || {}).nama_paket : null,
    o.antar ? (antarGrup.find((h) => h.id === o.antar) || {}).nama_paket : null,
    dq0 > 0 ? `${dropL ? dropL.nama_paket : 'Drop-off'} ×${dq0}` : null,
  ].filter(Boolean).join(', ');
  html += IK.sec('fa-plus', 'Layanan Tambahan', tambahanExpanded, tambahanRingkasan, "toggleSectionExpand('tambahan')");
  if (tambahanExpanded) {
    if (!adaUtama) html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Pilih layanan utama dulu untuk mengaktifkan lipat & antar.</div>`;
    html += `<div class="ik-grid2">`;
    lipatGrup.forEach((h) => {
      html += IK.tile({ sel: o.lipat === h.id, ...IK.ikonLayanan(h.kategori), nama: h.nama_paket, desc: h.kategori === 'setrika_lipat' ? 'setrika + lipat' : 'lipat saja',
        harga: `${rupiah(h.harga)}/kg`, onclick: `pickLipat(${h.id})`, dis: !adaUtama });
    });
    if (dropL) {
      html += IK.tile({ sel: dq0 > 0, ...IK.ikonLayanan('drop_off'), nama: dropL.nama_paket, desc: 'dikerjakan petugas', harga: `${rupiah(dropL.harga)}/mesin`,
        onclick: dq0 > 0 ? '' : 'changeDropoff(1)', extra: IK.qty(dq0, 'changeDropoff(-1)', 'changeDropoff(1)', dq0 >= 2) });
    }
    antarGrup.forEach((h) => {
      const perKm = h.satuan_hitung === 'per_km';
      html += IK.tile({ sel: o.antar === h.id, ...IK.ikonLayanan(h.kategori), nama: h.nama_paket, desc: h.kategori === 'antar_jemput' ? 'dijemput & diantar' : h.kategori === 'jemput' ? 'dijemput, ambil di toko' : 'diantar ke alamat',
        harga: perKm ? `${rupiah(h.harga)}/km` : rupiah(h.harga), onclick: `pickAntar(${h.id})`, dis: !adaUtama });
    });
    html += `</div>`;
    if (dropL) html += `<div class="ik-cap">Drop-off 1× = petugas memindahkan ke pengering · 2× = semua dikerjakan petugas</div>`;

    // alamat + jarak (untuk antar maupun antar-jemput)
    if (o.antar) {
      const la = S.katalog.layanan.find((l) => l.id === o.antar) || {};
      const perKm = la.satuan_hitung === 'per_km';
      const jarak = Number(o.antar_km) || 0;
      const subtotalAntar = perKm ? Number(la.harga) * jarak : Number(la.harga);
      html += `
        <div class="card-zl">
          ${perKm ? `
          <div class="field">
            <label>Perkiraan jarak (km)</label>
            <input type="number" id="ord-jarak" min="0" step="0.1" placeholder="cth: 3.5" value="${o.antar_km}" oninput="onJarakInput(this.value)">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              Tarif ${rupiah(la.harga)}/km${jarak > 0 ? ` × ${jarak} km = <b style="color:var(--primary);">${rupiah(subtotalAntar)}</b>` : ''}<br>
              <i class="fas fa-circle-info"></i> Jarak final dikonfirmasi kasir saat verifikasi.
            </div>
          </div>` : ''}
          <div class="field" style="margin-bottom:0;">
            <label>Alamat ${isAntarJemput ? 'Jemput & Antar' : antarKat === 'jemput' ? 'Jemput' : 'Antar'} + Patokan</label>
            <textarea id="ord-alamat" rows="2" placeholder="Alamat lengkap + patokan" oninput="onAlamatInput()">${esc(o.alamat_antar)}</textarea>
          </div>
        </div>`;
    }
  }

  // KEBUTUHAN LAUNDRY (tertutup default)
  const barangLaundry = barang.filter((b) => (b.kategori || 'laundry') === 'laundry');
  if (barangLaundry.length) {
    const ada = barangLaundry.some((b) => (o.produk[b.id] || 0) > 0);
    const buka = S.expandSection.laundry || ada;
    const ring = barangLaundry.filter((b) => (o.produk[b.id] || 0) > 0).map((b) => `${b.nama} ×${o.produk[b.id]}`).join(', ');
    html += IK.sec('fa-box', 'Kebutuhan Laundry', buka, ring, "toggleSectionExpand('laundry')");
    if (buka) html += `<div class="ik-grid2">${barangLaundry.map((b) => kartuBarang(b)).join('')}</div>`;
  }
  // CAFE & MINUMAN (tertutup default; hanya aktif & stok > 0 -- difilter server)
  const barangCafe = barang.filter((b) => b.kategori === 'cafe');
  if (barangCafe.length) {
    const ada = barangCafe.some((b) => (o.produk[b.id] || 0) > 0);
    const buka = S.expandSection.cafe || ada;
    const ring = barangCafe.filter((b) => (o.produk[b.id] || 0) > 0).map((b) => `${b.nama} ×${o.produk[b.id]}`).join(', ');
    html += IK.sec('fa-mug-hot', 'Cafe &amp; Minuman', buka, ring, "toggleSectionExpand('cafe')");
    if (buka) {
      html += `<input type="text" id="cafe-search" class="ik-search" placeholder="Cari produk cafe... (kopi, air mineral, dll)" value="${esc(o.cafeSearch || '')}" oninput="onCafeSearchInput()">`;
      html += `<div id="cafe-list" class="ik-grid2">${renderCafeList()}</div>`;
    }
  }

  // ruang untuk panel bawah (metode + ringkasan + total)
  html += `<div style="height:150px;"></div>`; // Perubahan #51: panel bawah lebih pendek

  $('pesan-body').innerHTML = html;
  renderTotalBar();
}

/* ===== Perubahan #35: helper kartu barang, berat, panel bawah ===== */
function beratInfoTeks(asli, hitung) {
  let t = 'Ketik 9,4 atau 9.4 · tombol −/+ per 0,1 kg';
  if (asli > 0 && hitung !== asli) t += ` · harga dihitung ${hitung} kg (dibulatkan)`;
  return t;
}
function kartuBarang(b) {
  const IK = window.IK3D;
  const q = S.order.produk[b.id] || 0;
  const stok = b.stok_terkini != null ? Number(b.stok_terkini) : null;
  const ik = IK.ikonBarang(b);
  return IK.tile({ sel: q > 0, g: ik.g, ico: ik.ico, foto: IK.fotoUrl(API, b), nama: b.nama, harga: rupiah(b.harga_jual),
    onclick: q > 0 ? '' : `changeProduk(${b.id}, 1)`, zoom: `zoomBarang(${b.id})`,
    extra: (stok != null ? `<div class="ik-stok">stok ${stok}</div>` : '') + IK.qty(q, `changeProduk(${b.id}, -1)`, `changeProduk(${b.id}, 1)`, stok != null && q >= stok) });
}
/** Perubahan #40: klik foto barang -> diperbesar + tombol Tambah */
function zoomBarang(id) {
  const IK = window.IK3D;
  const b = ((S.katalog && S.katalog.barang) || []).find((x) => Number(x.id) === Number(id));
  if (!b) return;
  const q = S.order.produk[b.id] || 0;
  const stok = b.stok_terkini != null ? Number(b.stok_terkini) : null;
  IK.zoomFoto({
    foto: IK.fotoUrl(API, b), nama: b.nama,
    info: `${rupiah(b.harga_jual)}${stok != null ? ` · stok ${stok}` : ''}${q ? ` · di keranjang ${q}` : ''}`,
    tombol: '<i class="fas fa-plus"></i> Tambah', nonaktif: stok != null && q >= stok,
    aksi: () => changeProduk(b.id, 1),
  });
}
function geserBerat(d) {
  const IK = window.IK3D;
  let b = IK.parseBerat($('ord-berat') ? $('ord-berat').value : S.order.berat_kg);
  if (isNaN(b)) b = 0;
  b = Math.max(0, IK.rapikanBerat(b + d));
  S.order.berat_kg = b ? String(b) : '';
  onBeratBlur(true);
}
function putarKeringKartu() {
  window.IK3D.putarKering(S.order, layananByKat('kering'), pilihLayananKeringOtomatis(window.IK3D.beratHitung(S.order.berat_kg)));
  renderPesanForm();
}
function pilihKeringKartu(id) {
  const o = S.order;
  const rekom = pilihLayananKeringOtomatis(window.IK3D.beratHitung(o.berat_kg));
  // Perubahan #42: klik pertama (belum ada kering) -> selalu yang disarankan; klik berikutnya bebas
  if (!o.kering) { o.kering = rekom || id; o.kering_manual = false; }
  else if (o.kering === id) { o.kering = null; o.kering_manual = false; }
  else { o.kering = id; o.kering_manual = id !== rekom; }
  renderPesanForm();
}

/* ---------- interaksi form pesan ---------- */
function onOrderChange() {
  // Perubahan #35: berat desimal, koma atau titik (9,4 / 9.4)
  const IK = window.IK3D;
  IK.pasLebar($('ord-berat'));
  const v = IK.parseBerat($('ord-berat').value);
  S.order.berat_kg = isNaN(v) || v <= 0 ? '' : String(v);
  const info = $('ord-berat-info'); if (info) info.textContent = beratInfoTeks(Number(S.order.berat_kg) || 0, IK.beratHitung(S.order.berat_kg));
  renderTotalBar();
}

/**
 * Rekomendasi durasi Kering berdasar berat cucian (kg):
 *   0-3kg -> 15 menit, 3-7kg -> 30 menit, >7kg -> 45 menit.
 * Ini CUMA default/saran -- pelanggan/kasir tetap bebas pilih durasi lain
 * secara manual (lihat kering_manual di pickKering()), gak dikunci.
 */
function rekomendasiDurasiKering(beratKg) {
  const b = Number(beratKg) || 0;
  // Perubahan #42: s/d 6 kg -> 30 menit, 7 kg ke atas -> 45 menit (berat dibulatkan).
  // Kering 15 menit = layanan tambahan (kalau 30/45 belum kering), tidak pernah disarankan.
  if (b <= 6) return 30;
  return 45;
}
/** Cari id layanan Kering yang durasinya paling cocok sama rekomendasi berat. */
function pilihLayananKeringOtomatis(beratKg) {
  const list = layananByKat('kering');
  if (!list.length) return null;
  const target = rekomendasiDurasiKering(beratKg);
  const exact = list.find((h) => Number(h.durasi_menit) === target);
  if (exact) return exact.id;
  // fallback (jaga-jaga kalau paket 15/30/45 gak lengkap di cabang ini) -> ambil durasi terdekat
  let best = list[0];
  let bestDiff = Math.abs((Number(best.durasi_menit) || 0) - target);
  list.forEach((h) => {
    const diff = Math.abs((Number(h.durasi_menit) || 0) - target);
    if (diff < bestDiff) { best = h; bestDiff = diff; }
  });
  return best.id;
}
/** Kapasitas mesin cuci (washer) TERBESAR yang ada di tabel mesin cabang ini -- acuan
 * nyata buat batas berat, BUKAN dari layanan/tier harga. Mesin nonaktif (dibuang/
 * permanen mati) tidak dihitung; maintenance/jalan tetap dihitung karena fisiknya ada. */
function maxKapasitasWasher() {
  const mesin = (S.katalog && S.katalog.mesin) || [];
  const washer = mesin.filter((m) => m.tipe === 'washer' && m.status !== 'nonaktif' && m.kapasitas_kg != null);
  if (!washer.length) return null; // data mesin belum ada -- jangan blokir, biar tidak salah reset
  return Math.max(...washer.map((m) => Number(m.kapasitas_kg)));
}
/** Berat cucian dibulatkan ke kg terdekat (10.4 -> 10, 10.55 -> 11) begitu customer selesai input.
 * Kalau lebih besar dari kapasitas mesin cuci terbesar yang ada di cabang ini -> langsung
 * di-nol-kan (bukan sekadar warning), sesuai kapasitas mesin sebenarnya di tabel mesin. */
function onBeratBlur(dariTombol) {
  // Perubahan #35: berat boleh desimal (1 angka di belakang koma); harga/tier/
  // rekomendasi kering memakai berat dibulatkan (lihat IK3D.beratHitung).
  const IK = window.IK3D;
  let b;
  if (dariTombol) b = Number(S.order.berat_kg) || 0;
  else {
    const inp = $('ord-berat'); if (!inp) return;
    if (inp.value === '' || inp.value == null) { S.order.berat_kg = ''; renderPesanForm(); return; }
    b = IK.parseBerat(inp.value);
    if (isNaN(b)) { toast('Berat tidak valid. Contoh: 6,5 atau 6.5', 'warning'); b = 0; }
  }
  b = IK.rapikanBerat(b);
  const maxMesin = maxKapasitasWasher();
  if (maxMesin != null && b > maxMesin) {
    toast(`Berat ${IK.fmtBerat(b)} kg melebihi kapasitas mesin cuci terbesar di cabang ini (maks ${maxMesin} kg). Isian berat direset.`, 'warning');
    b = 0;
  }
  S.order.berat_kg = b > 0 ? String(b) : '';
  // Kering: kalau masih rekomendasi otomatis, sesuaikan dengan berat baru
  if (S.order.kering && !S.order.kering_manual) {
    const rekom = pilihLayananKeringOtomatis(IK.beratHitung(S.order.berat_kg));
    if (rekom) S.order.kering = rekom;
  }
  renderPesanForm();
}
function onAlamatInput() { S.order.alamat_antar = $('ord-alamat').value; }
function toggleCuci() { S.order.cuci = !S.order.cuci; if (!S.order.cuci) { S.order.promo_pilihan = null; S.order.promo_label = null; } renderPesanForm(); }
function toggleKering() {
  if (S.order.kering) {
    S.order.kering = null;
    S.order.kering_manual = false;
  } else {
    S.order.kering = pilihLayananKeringOtomatis(window.IK3D.beratHitung(S.order.berat_kg)) || (layananByKat('kering')[0] || {}).id || null;
    S.order.kering_manual = false; // masih rekomendasi otomatis, belum di-override
  }
  renderPesanForm();
}
function pickKering(id) { S.order.kering = id; S.order.kering_manual = true; renderPesanForm(); }
function pickLipat(id) { S.order.lipat = S.order.lipat === id ? null : id; renderPesanForm(); }
function pickAntar(id) {
  if (S.order.antar === id) { S.order.antar = null; S.order.antar_km = ''; }
  else { S.order.antar = id; }
  renderPesanForm();
}
function onJarakInput(v) { S.order.antar_km = v; renderPesanForm(); }
function changeDropoff(delta) {
  const cur = S.order.dropoffQty || 0;
  S.order.dropoffQty = Math.max(0, Math.min(2, cur + delta));
  renderPesanForm();
}

/* ---------- Perubahan #87: cek promo tersedia di awal ---------- */
const PROMO_CACHE = { key: null, list: null };
function adaPromo() { return !!(PROMO_CACHE.list && PROMO_CACHE.list.length); }
async function muatPromo(hp) {
  hp = String(hp || '').trim();
  if (!S.cabang || hp.length < 9) { PROMO_CACHE.key = null; PROMO_CACHE.list = null; tampilPromo(); return; }
  const k = S.cabang.id + '|' + hp;
  if (PROMO_CACHE.key === k) return; // sudah / sedang dimuat
  PROMO_CACHE.key = k; PROMO_CACHE.list = null;
  let list = [];
  try { list = (await api(`/customer/promo-tersedia?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(hp)}`)).data || []; } catch (e) { list = []; }
  if (PROMO_CACHE.key !== k) return; // HP sudah berganti
  PROMO_CACHE.list = list;
  tampilPromo();
}
function tampilPromo() {
  const el = document.getElementById('ord-promo');
  if (el) el.style.display = (S.order.promo_pilihan || adaPromo()) ? '' : 'none';
}

/* ---------- GUNAKAN PROMO ---------- */
async function openPromoSheet() {
  const hp = ($('ord-hp') ? $('ord-hp').value.trim() : '') || S.order.hp || S.hp || '';
  if (!hp || hp.length < 9) { toast('Isi nomor HP dulu buat cek promo', 'warning'); return; }
  S.order.hp = hp;

  openSheet(`<h3><i class="fas fa-gift"></i> Gunakan Promo</h3><div id="promo-sheet-body">${spinner()}</div>`);
  try {
    const res = await api(`/customer/promo-tersedia?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(hp)}`);
    renderPromoSheet(res.data || []);
  } catch (e) {
    $('promo-sheet-body').innerHTML = `<div style="font-size:12px;color:var(--danger);">Gagal memuat: ${esc(e.message || '')}</div>`;
  }
}

function renderPromoSheet(list) {
  const box = $('promo-sheet-body');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `${emptyState('Belum ada promo yang bisa dipakai saat ini', 'fa-gift')}
      <button class="btn-zl btn-light-zl" style="margin-top:10px;" onclick="closeSheet()">Tutup</button>`;
    return;
  }
  let html = list.map((p) => `
    <div class="card-zl" style="margin-bottom:8px;cursor:pointer;" onclick="pilihPromo('${p.jenis_promo}','${esc(p.label)}')">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;font-size:13px;"><i class="fas fa-gift" style="color:var(--success);"></i> ${esc(p.label)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${rupiah(p.harga_normal)} &rarr; ${rupiah(p.harga_promo)}</div>
        </div>
        <i class="fas fa-chevron-right" style="color:var(--slate-light);"></i>
      </div>
    </div>`).join('');
  if (S.order.promo_pilihan) {
    html += `<button class="btn-zl btn-light-zl" style="margin-top:6px;width:100%;" onclick="pilihPromo(null,null)">Jangan pakai promo</button>`;
  }
  box.innerHTML = html;
}

function pilihPromo(jenis, label) {
  S.order.promo_pilihan = jenis;
  S.order.promo_label = label;
  closeSheet();
  renderPesanForm();
  if (jenis) toast('Promo dipilih: ' + label, 'success');
}
function pickMetode(m) { S.order.metode = (['qris', 'kiosk'].includes(m) ? m : 'cash'); renderPesanForm(); }

/* Perubahan #83: 4 cara bayar (Cash / QRIS / Kios-K + Poin) sesuai saklar cabang */
const LABEL_METODE = { cash: 'Cash', qris: 'QRIS', kiosk: 'Kios-K' };
function labelMetode(m) { return LABEL_METODE[m] || (m ? String(m).toUpperCase() : '-'); }
function metodeAktif() {
  const m = (S.katalog && S.katalog.metode_bayar) || { cash: true, qris: true, kiosk: false, poin: true };
  return m;
}
/** Pastikan metode terpilih masih aktif; kalau tidak, pindah ke metode aktif pertama. */
function rapikanMetode() {
  const m = metodeAktif();
  if (!m[S.order.metode]) S.order.metode = ['cash', 'qris', 'kiosk'].find((k) => m[k]) || 'cash';
  if (!m.poin && S.order.pakaiPoin) { S.order.pakaiPoin = false; S.order.poin_dipakai = 0; }
}

/* Toggle accordion section "Layanan Tambahan" / "Kebutuhan Laundry" -- item2
   di dalamnya sengaja disembunyikan default (biar form Pesan gak kepanjangan
   & penuh pilihan yang jarang dipakai), baru keluar begitu section-nya
   diklik. Lihat renderPesanForm() bagian "LAYANAN TAMBAHAN" & "PRODUK". */
function toggleSectionExpand(key) {
  S.expandSection[key] = !S.expandSection[key];
  renderPesanForm();
}

// Tombol "buka app" buat QRIS -- cuma buka aplikasinya (kayak klik nomor
// telepon buka WhatsApp), BUKAN payment gateway. Customer tetap harus scan
// QRIS statis toko sendiri di dalam app yang kebuka. Kalau app-nya gak
// ke-install, fallback ke halaman Play Store.
const PAYMENT_APPS = [
  { id: 'gopay', label: 'Gopay', icon: 'fa-wallet', scheme: 'gojek://gopay/', store: 'https://play.google.com/store/apps/details?id=com.gojek.app' },
  { id: 'ovo', label: 'OVO', icon: 'fa-wallet', scheme: 'ovo://', store: 'https://play.google.com/store/apps/details?id=ovo.id' },
  { id: 'dana', label: 'DANA', icon: 'fa-wallet', scheme: 'dana://', store: 'https://play.google.com/store/apps/details?id=id.dana' },
  { id: 'shopeepay', label: 'ShopeePay', icon: 'fa-wallet', scheme: 'shopeeid://', store: 'https://play.google.com/store/apps/details?id=com.shopee.id' },
];
function bukaAppBayar(id) {
  const app = PAYMENT_APPS.find((a) => a.id === id);
  if (!app) return;
  // Coba buka scheme app-nya; kalau dalam ~1.5 detik browser masih di sini
  // (artinya app gak ke-install / gagal kebuka), lempar ke Play Store.
  const timer = setTimeout(() => { window.location.href = app.store; }, 1500);
  const cancel = () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('blur', onHide); };
  const onHide = () => cancel();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('blur', onHide);
  window.location.href = app.scheme;
}

/* ============================================================
   BAYAR TAGIHAN VIA QRIS DINAMIS (Winpay) + TABLET KIOSK
   Tombol "Bayar Semua" di tab Pesanan Aktif -> gabung SEMUA transaksi belum
   lunas jadi 1 sesi, generate QR dinamis + kode bayar 4 digit SEKALIGUS.
   HP CUMA nampilin kode 4 digit + status (polling tiap 4 detik) -- QR-nya
   discan dari tablet kiosk yang nempel di toko (public/kiosk/), bukan dari
   HP. Kalau Winpay gagal/nonaktif utk cabang ini, fallback ke QRIS statis
   lama (buka app e-wallet + bayar dikonfirmasi kasir manual).
   ============================================================ */
let _aktifTagihanTotal = 0; // dihitung ulang tiap loadAktif(), dipakai tombol "Bayar Semua"
let _aktifTagihanQrisTotal = 0;
let _aktifRincian = {}; // #83 rincian tagihan per metode
// (_aktifTagihanQrisTotal) subset metode='qris' doang -- dipakai fallback sheet kalau Winpay gagal
let _aktifCashList = []; // subset metode='cash' -- dipakai fallback sheet (server gak sempat balikin split kalau request-nya sendiri gagal total)
let _qrisPollInterval = null;
let _qrisPollTicks = 0;
const QRIS_POLL_MAX_TICKS = 300; // 4 detik x 300 = 20 menit, jaga2 kalau lupa ditutup

/**
 * Tombol "Bayar Semua" (Pesanan Aktif) -- gabung tagihan METODE QRIS belum
 * lunas jadi 1 sesi, generate QR dinamis Winpay + kode bayar 4 digit
 * SEKALIGUS. Tagihan metode CASH sengaja TIDAK ikut digabung (lihat
 * cash_transaksi dari server) -- tetap harus dibayar langsung ke kasir,
 * makanya ditampilin terpisah sebagai daftar info, bukan bagian dari kode
 * bayar QRIS. QR-nya SENGAJA TIDAK ditampilin di HP -- yang di-scan itu QR
 * di tablet kiosk toko, HP cuma nampilin kode 4 digitnya + status (polling).
 */
async function bayarSemua() {
  openSheet(`<div style="text-align:center;padding:24px 0;"><i class="fas fa-spinner fa-spin" style="font-size:22px;"></i><div style="margin-top:8px;font-size:13px;color:var(--text-muted);">Menyiapkan pembayaran...</div></div>`);
  try {
    const res = await api('/customer/bayar-semua', {
      method: 'POST',
      body: { cabang_id: S.cabang.id, telepon: S.hp },
    });
    const d = res.data || {};
    // Perubahan #83: rincian per metode (Cash / QRIS / Kios-K). Kode bayar
    // cuma dibuat untuk bagian Kios-K; Cash & QRIS dibayar di kasir.
    if (d.tanpaKiosk || d.kioskGagal || !d.kode_bayar) {
      renderRincianBayarSheet(d.rincian || {}, d.kioskGagal ? (d.pesan_kiosk || 'Kios-K sedang tidak tersedia') : null);
      return;
    }
    renderKodeBayarSheet(d);
    startPollQris(d.id);
  } catch (e) {
    renderRincianBayarSheet(_aktifRincian || {}, e.message || 'Gagal menyiapkan pembayaran');
  }
}

/* Perubahan #83: rincian tagihan per metode bayar */
const INFO_METODE = {
  cash: { ico: 'fa-money-bill-wave', ket: 'Bayar tunai di kasir' },
  qris: { ico: 'fa-qrcode', ket: 'Scan QRIS toko di kasir' },
  kiosk: { ico: 'fa-tablet-screen-button', ket: 'Ketik kode bayar di tablet Kios-K' },
};
function rincianBayarHtml(rincian, { kecuali = null, kioskGagal = null } = {}) {
  const baris = ['cash', 'qris', 'kiosk'].filter((k) => rincian && rincian[k] && k !== kecuali).map((k) => {
    const r = rincian[k]; const I = INFO_METODE[k];
    const ket = k === 'kiosk' && kioskGagal ? 'Kios-K lagi tidak tersedia — bayar di kasir (Cash / QRIS)' : I.ket;
    return `<div class="rb-row">
      <span class="rb-ic rb-${k}"><i class="fas ${I.ico}"></i></span>
      <span class="rb-tx"><b>${labelMetode(k)}</b><small>${r.jumlah} pesanan · ${esc(ket)}</small></span>
      <b class="rb-nom">Rp${(r.total || 0).toLocaleString('id-ID')}</b></div>`;
  });
  return baris.length ? `<div class="rb-box">${baris.join('')}</div>` : '';
}
function renderRincianBayarSheet(rincian, pesanKiosk) {
  const total = ['cash', 'qris', 'kiosk'].reduce((s2, k) => s2 + ((rincian[k] && rincian[k].total) || 0), 0);
  openSheet(`
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:700;margin-bottom:2px;">Tagihan Kamu</div>
      <div style="font-size:20px;font-weight:800;color:var(--primary);margin-bottom:10px;">Rp${total.toLocaleString('id-ID')}</div>
      ${rincianBayarHtml(rincian, { kioskGagal: pesanKiosk })}
      ${pesanKiosk && rincian.kiosk ? `<div style="font-size:11px;color:var(--danger);margin-top:8px;">${esc(pesanKiosk)}</div>` : ''}
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:14px;" onclick="closeSheet();">Tutup</button>
    </div>`);
}

/** Baris info tagihan cash (dibayar langsung ke kasir, BUKAN via QRIS) -- dipakai di beberapa sheet "Bayar Semua". */
function cashInfoBlock(cashList) {
  if (!cashList || !cashList.length) return '';
  const totalCash = cashList.reduce((s, t) => s + (t.total || 0), 0);
  return `
    <div style="text-align:left;background:var(--bg-soft);border-radius:12px;padding:10px 12px;margin-top:10px;">
      <div style="font-size:12px;font-weight:700;margin-bottom:6px;"><i class="fas fa-money-bill-wave"></i> Bayar Cash di Kasir (${cashList.length} pesanan · Rp${totalCash.toLocaleString('id-ID')})</div>
      ${cashList.map((t) => `<div style="font-size:12px;color:var(--text-muted);display:flex;justify-content:space-between;"><span>${esc(t.no_invoice || '-')}</span><span>Rp${(t.total || 0).toLocaleString('id-ID')}</span></div>`).join('')}
    </div>`;
}

/** Semua tagihan pelanggan ini metode cash -- gak ada kode bayar QRIS yang dibikin. */
function renderCashOnlySheet(cashList) {
  const html = `
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;"><i class="fas fa-money-bill-wave"></i> Bayar Cash</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px;">Semua tagihan kamu metode cash -- silakan bayar langsung ke kasir di outlet.</div>
      ${cashInfoBlock(cashList)}
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:14px;" onclick="closeSheet();">Kembali</button>
    </div>`;
  openSheet(html);
}

/** Fallback saat QR dinamis Winpay gagal/nonaktif -> tampilan QRIS statis lama. `cashList` (kalau ada) ditampilkan terpisah sebagai info "bayar cash di kasir". */
function renderFallbackQrisSheet(total, cashList) {
  const html = `
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">Bayar QRIS</div>
      <div style="font-size:20px;font-weight:800;color:var(--primary);margin-bottom:10px;">Rp${(total || 0).toLocaleString('id-ID')}</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">QR otomatis lagi tidak tersedia -- buka aplikasi kamu, lalu scan QRIS toko di kasir/tempat yang disediain:</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">
        ${PAYMENT_APPS.map((a) => `
        <button type="button" class="btn-zl btn-light-zl" style="padding:8px 6px;font-size:12px;" onclick="bukaAppBayar('${a.id}')">
          <i class="fas ${a.icon}"></i> Buka ${esc(a.label)}
        </button>`).join('')}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:10px;">Pembayaran akan dikonfirmasi kasir setelah kamu bayar.</div>
      ${cashInfoBlock(cashList)}
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:10px;" onclick="closeSheet();">Kembali</button>
    </div>`;
  openSheet(html);
}

/** Sheet HP: cuma kode bayar 4 digit + status -- BUKAN QR (QR-nya di tablet kiosk toko). `sesi.cash_transaksi` (kalau ada, dari tombol "Bayar Semua" pas ada tagihan metode cash yang gak ikut kegabung) ditampilkan terpisah sebagai info. */
function renderKodeBayarSheet(sesi, statusText) {
  const html = `
    <div style="text-align:center;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;"><i class="fas fa-tablet-screen-button"></i> Kode Bayar Kios-K</div>
      <div style="font-size:19px;font-weight:800;color:var(--primary);margin-bottom:8px;">Rp${(sesi.amount || 0).toLocaleString('id-ID')}</div>
      <div style="font-size:40px;font-weight:800;letter-spacing:10px;padding:16px 0;margin:6px 0 12px;border:2px dashed var(--primary);border-radius:14px;">${esc(sesi.kode_bayar || '----')}</div>
      <div style="font-size:13px;color:var(--text-muted);">${esc(statusText || 'Ketik kode ini di tablet Kios-K di toko, lalu scan QR yang muncul di layarnya. Halaman ini otomatis update begitu pembayaran diterima.')}</div>
      ${sesi.rincian && (sesi.rincian.cash || sesi.rincian.qris) ? `<div style="font-size:12px;font-weight:700;text-align:left;margin-top:12px;">Dibayar di kasir:</div>${rincianBayarHtml(sesi.rincian, { kecuali: 'kiosk' })}` : cashInfoBlock(sesi.cash_transaksi)}
      <button class="btn-zl btn-light-zl" style="width:100%;margin-top:16px;" onclick="batalPollQrisSheet()">Tutup</button>
    </div>`;
  openSheet(html);
}

function batalPollQrisSheet() {
  if (_qrisPollInterval) { clearInterval(_qrisPollInterval); _qrisPollInterval = null; }
  closeSheet();
}

function startPollQris(pembayaranId) {
  if (_qrisPollInterval) clearInterval(_qrisPollInterval);
  _qrisPollTicks = 0;
  _qrisPollInterval = setInterval(async () => {
    _qrisPollTicks++;
    if (_qrisPollTicks > QRIS_POLL_MAX_TICKS) { clearInterval(_qrisPollInterval); _qrisPollInterval = null; return; }
    let sesi;
    try {
      const res = await api(`/customer/pembayaran-qris/${pembayaranId}?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}`);
      sesi = res.data;
    } catch (e) { return; } // gagal fetch sekali, coba lagi tick berikutnya

    if (sesi.status === 'pending') return; // masih nunggu, lanjut polling

    clearInterval(_qrisPollInterval); _qrisPollInterval = null;
    const sheetMasihAktif = $('sheet-bg') && $('sheet-bg').classList.contains('active');

    if (sesi.status === 'paid') {
      toast('Pembayaran QRIS berhasil, terima kasih!', 'success');
      if (sheetMasihAktif) {
        openSheet(`
          <div style="text-align:center;padding:10px 0;">
            <i class="fas fa-circle-check" style="font-size:40px;color:var(--success);"></i>
            <div style="margin-top:10px;font-size:16px;font-weight:700;">Pembayaran Berhasil!</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">Rp${(sesi.amount || 0).toLocaleString('id-ID')} sudah lunas.</div>
            <button class="btn-zl btn-primary-zl" style="width:100%;margin-top:16px;" onclick="closeSheet(); navTo('selesai');">Lihat Riwayat</button>
          </div>`);
      }
    } else if (['expired', 'canceled', 'failed'].includes(sesi.status)) {
      // Kode bayar 4 digit ikut "mati" bareng sesi ini (lihat findByKode() di
      // server) -- satu-satunya jalan keluar ya generate kode baru.
      const label = sesi.status === 'expired' ? 'Kode bayar sudah kadaluarsa' : sesi.status === 'canceled' ? 'Pembayaran dibatalkan' : 'Pembayaran gagal';
      if (sheetMasihAktif) {
        openSheet(`
          <div style="text-align:center;padding:10px 0;">
            <i class="fas fa-circle-xmark" style="font-size:40px;color:var(--danger);"></i>
            <div style="margin-top:10px;font-size:16px;font-weight:700;">${esc(label)}</div>
            <button class="btn-zl btn-primary-zl" style="width:100%;margin-top:16px;" onclick="bayarSemua()">Buat Kode Bayar Baru</button>
          </div>`);
      }
    }
  }, 4000);
}

function changeProduk(id, delta) {
  const cur = S.order.produk[id] || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) delete S.order.produk[id]; else S.order.produk[id] = next;
  // item cafe: partial-render (cuma #cafe-list) biar fokus search box & teks
  // yang lagi diketik nggak ke-reset oleh render ulang seluruh form.
  const b = (S.katalog.barang || []).find((x) => x.id === id);
  if (b && b.kategori === 'cafe' && $('cafe-list')) {
    $('cafe-list').innerHTML = renderCafeList();
    renderTotalBar();
  } else {
    renderPesanForm();
  }
}

/** Cari 1 kata di 'nama' barang, dipakai search box cafe. */
function onCafeSearchInput() {
  S.order.cafeSearch = $('cafe-search') ? $('cafe-search').value : '';
  const el = $('cafe-list');
  if (el) el.innerHTML = renderCafeList();
}

/**
 * Daftar produk cafe yang ditampilkan: kalau search KOSONG, cuma tampilkan
 * yang SUDAH dipilih (qty > 0) -- biar nggak perlu scroll panjang lihat
 * puluhan produk. Kalau search DIISI, tampilkan yang namanya cocok (apapun
 * qty-nya sekarang), buat nambah pilihan baru.
 */
function renderCafeList() {
  // Perubahan #35: kartu ikon/foto 2 kolom; tanpa kata kunci = semua produk
  // cafe aktif & stok > 0 (difilter server), dengan kata kunci = yang cocok.
  const barangCafe = (S.katalog.barang || []).filter((b) => b.kategori === 'cafe');
  const q = (S.order.cafeSearch || '').trim().toLowerCase();
  const list = q ? barangCafe.filter((b) => b.nama.toLowerCase().includes(q)) : barangCafe;
  if (!list.length) return `<div style="grid-column:1/-1;font-size:12px;color:var(--text-muted);padding:6px 2px;">Tidak ada produk cocok "${esc(q)}"</div>`;
  return list.map((b) => kartuBarang(b)).join('');
}

/* lookup HP diam-diam saat customer ketik (autofill nama/alamat) */
let hpTimer = null;
function onHpInput() {
  S.order.hp = $('ord-hp').value.trim();
  clearTimeout(hpTimer);
  const hp = S.order.hp;
  if (hp.length < 9) { muatPromo(''); return; }
  hpTimer = setTimeout(() => { lookupHpDiam(hp); muatPromo(hp); }, 600);
}
function onNamaInput() {
  S.order.nama = $('ord-nama').value;
}
async function lookupHpDiam(hp) {
  try {
    const res = await api(`/customer/lookup?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(hp)}`);
    if (res.data && res.data.found) {
      const c = res.data.pelanggan;
      const namaInput = $('ord-nama');
      if (namaInput && !namaInput.value.trim()) namaInput.value = c.nama || '';
      if (!S.order.nama) S.order.nama = c.nama || '';
      toast('Selamat datang lagi, ' + (c.nama || 'pelanggan') + '!', 'success');
    }
  } catch (e) { /* diam */ }
}

/* hitung total lokal (estimasi) */
function estimateTotal() {
  const o = S.order;
  const berat = window.IK3D.beratHitung(o.berat_kg); // Perubahan #35: harga pakai berat dibulatkan
  let total = 0;
  const findL = (id) => (S.katalog.layanan || []).find((l) => l.id === id);

  if (o.cuci) { const l = pilihCuci(berat); if (l) total += Number(l.harga); }
  if (o.kering) { const l = findL(o.kering); if (l) total += Number(l.harga); }
  if (o.lipat) { const l = findL(o.lipat); if (l) total += Number(l.harga) * berat; }   // per kg (berat dibulatkan)
  if (o.antar) { const l = findL(o.antar); if (l) { const km = Number(o.antar_km) || 0; total += l.satuan_hitung === 'per_km' ? Number(l.harga) * km : Number(l.harga); } }
  // drop-off: pilihan bebas 0-2, tarif per mesin, tidak terikat layanan lain
  if (o.dropoffQty > 0) { const l = layananPertama('drop_off'); if (l) total += Number(l.harga) * o.dropoffQty; }
  for (const id in o.produk) {
    const b = (S.katalog.barang || []).find((x) => x.id === Number(id));
    if (b) total += Number(b.harga_jual) * o.produk[id];
  }
  return total;
}

function renderTotalBar() {
  // Perubahan #35: panel bawah menempel = metode pembayaran + ringkasan ikon + total
  const old = document.getElementById('total-bar'); if (old) old.remove();
  if (S.currentPage !== 'pesan' || !S.katalog) return;
  const IK = window.IK3D;
  const o = S.order;
  const total = estimateTotal();
  const _pel = S.pelanggan;
  const _poin = _pel ? (Number(_pel.point) || 0) : 0;
  const _NILAI = Number(S.cabang && S.cabang.nilai_per_poin) || 10, _KEL = 100, _MIN_POIN = 500;
  const _poinMaks = _poin >= _MIN_POIN ? Math.floor(Math.min(_poin, Math.floor(total / _NILAI)) / _KEL) * _KEL : 0;
  const _potongan = _poinMaks * _NILAI;
  const _pakaiPoin = o.pakaiPoin && _poinMaks >= _KEL;
  o.poin_dipakai = _pakaiPoin ? _poinMaks : 0;
  const _totalAkhir = _pakaiPoin ? Math.max(0, total - _potongan) : total;
  const _bisaTukar = _poin >= _MIN_POIN;
  rapikanMetode();
  const _M = metodeAktif();
  // Perubahan #86: tombol besar 1 baris penuh (ikon + nama)
  const _chips = [
    _M.cash ? `<div class="${o.metode === 'cash' ? 'sel' : ''}" onclick="pickMetode('cash')"><i class="fas fa-money-bill-wave"></i>Cash</div>` : '',
    _M.qris ? `<div class="${o.metode === 'qris' ? 'sel' : ''}" onclick="pickMetode('qris')"><i class="fas fa-qrcode"></i>QRIS</div>` : '',
    _M.kiosk ? `<div class="${o.metode === 'kiosk' ? 'sel' : ''}" onclick="pickMetode('kiosk')"><i class="fas fa-tablet-screen-button"></i>Kios-K</div>` : '',
    _M.poin ? `<div class="${_pakaiPoin ? 'sel' : ''} ${_bisaTukar ? '' : 'dis'}" title="${_bisaTukar ? _poin + ' poin' : 'min. ' + _MIN_POIN + ' poin'}" onclick="${_bisaTukar ? 'togglePakaiPoin()' : ''}"><i class="fas fa-star" style="color:#f59e0b;"></i>Poin<small>${_bisaTukar ? _poin : 'min. ' + _MIN_POIN}</small></div>` : '',
  ].filter(Boolean);

  const findL = (id) => (S.katalog.layanan || []).find((l) => l.id === id);
  // Perubahan #86: ringkasan item = ikon 3D + angka saja (sama dengan Pesankan kasir)
  const res = [];
  if (Number(o.berat_kg) > 0) res.push({ g: 'g-berat', ico: 'fa-weight-hanging', badge: `${IK.fmtBerat(o.berat_kg)}kg`, title: 'Berat' });
  if (o.cuci) res.push({ ...IK.ikonLayanan('cuci'), title: 'Cuci' });
  if (o.kering) { const l = findL(o.kering) || {}; res.push({ ...IK.ikonLayanan('kering'), badge: l.durasi_menit ? `${l.durasi_menit}'` : '', title: l.nama_paket || 'Kering' }); }
  if (o.lipat) { const l = findL(o.lipat) || {}; res.push({ ...IK.ikonLayanan(l.kategori || 'lipat'), title: l.nama_paket || 'Lipat' }); }
  if (o.antar) { const l = findL(o.antar) || {}; res.push({ ...IK.ikonLayanan(l.kategori || 'antar'), title: l.nama_paket || 'Antar' }); }
  if (o.dropoffQty > 0) res.push({ ...IK.ikonLayanan('drop_off'), badge: `×${o.dropoffQty}`, title: 'Drop-off' });
  for (const id in o.produk) {
    const b = (S.katalog.barang || []).find((x) => x.id === Number(id)); if (!b) continue;
    const ik = IK.ikonBarang(b);
    res.push({ g: ik.g, ico: ik.ico, foto: IK.fotoUrl(API, b), badge: `×${o.produk[id]}`, title: b.nama });
  }
  const bar = document.createElement('div');
  bar.className = 'total-bar ik-panel'; bar.id = 'total-bar';
  bar.innerHTML = `
    <div class="ik-res">${IK.resumeHtml(res)}</div>
    <div class="ik-met besar" style="grid-template-columns:repeat(${_chips.length || 1},1fr);">${_chips.join('')}</div>
    <div class="ik-tot">
      <div class="t"><small>Estimasi</small><b style="color:${_pakaiPoin ? 'var(--success)' : ''};">${rupiah(_totalAkhir)}</b>
        ${_pakaiPoin ? `<div class="ik-hemat">hemat ${rupiah(_potongan)}</div>` : ''}</div>
      <button id="btn-submit-order" onclick="submitOrder()">Pesan</button>
    </div>`;
  document.body.appendChild(bar);
  // panel bawah lebih tinggi -> beri ruang supaya isi halaman tidak ketutup
  const pg = document.getElementById('page-pesan'); if (pg) pg.style.paddingBottom = (bar.offsetHeight + 16) + 'px';
}

/* ---------- SUBMIT ORDER ---------- */
function buildPayload() {
  const o = S.order;
  const findL = (id) => (S.katalog.layanan || []).find((l) => l.id === id);

  const layanan = [];
  if (o.cuci) { const l = pilihCuci(window.IK3D.beratHitung(o.berat_kg)); if (l) layanan.push({ layanan_id: l.id }); }
  if (o.kering) layanan.push({ layanan_id: o.kering });
  if (o.lipat) layanan.push({ layanan_id: o.lipat });                 // per kg (backend pakai berat)
  if (o.antar) { const l = findL(o.antar); const km = Number(o.antar_km) || 0; layanan.push({ layanan_id: o.antar, qty: (l && l.satuan_hitung === 'per_km') ? km : 1 }); }
  const dropoffQty = Math.max(0, Math.min(2, Number(o.dropoffQty) || 0));
  if (dropoffQty > 0) { const l = layananPertama('drop_off'); if (l) layanan.push({ layanan_id: l.id, qty: dropoffQty }); }
  const barang = Object.entries(o.produk).map(([id, qty]) => ({ barang_id: Number(id), qty }));
  return {
    cabang_id: S.cabang.id,
    cabang_kode: S.cabang.kode,
    pelanggan: { telepon: o.hp || S.hp || (S.pelanggan && S.pelanggan.telepon) || '', nama: o.nama || ($('ord-nama') ? $('ord-nama').value.trim() : '') || (S.pelanggan && S.pelanggan.nama) || '', alamat: o.alamat_antar || null },
    berat_kg: Number(o.berat_kg) || null,
    alamat_antar: o.antar ? (o.alamat_antar || '') : null,
    metode_bayar: o.metode || 'cash',
    promo_pilihan: o.cuci ? (o.promo_pilihan || undefined) : undefined,
    layanan, barang,
  };
}

function togglePakaiPoin() {
  S.order.pakaiPoin = !S.order.pakaiPoin;
  S.order.poin_dipakai = 0;
  renderPesanForm();
  renderTotalBar();
}

async function submitOrder() {
  const o = S.order;
  // sinkron nilai field terakhir; kalau pelanggan dikenal (field tidak tampil), ambil dari S
  o.hp = ($('ord-hp') ? $('ord-hp').value.trim() : (o.hp || S.hp || (S.pelanggan && S.pelanggan.telepon) || ''));
  o.nama = ($('ord-nama') ? $('ord-nama').value.trim() : (o.nama || (S.pelanggan && S.pelanggan.nama) || ''));
  o.berat_kg = ($('ord-berat') ? $('ord-berat').value : o.berat_kg);
  if (o.berat_kg !== '' && o.berat_kg != null) { const _b = window.IK3D.parseBerat(o.berat_kg); o.berat_kg = isNaN(_b) || _b <= 0 ? '' : String(window.IK3D.rapikanBerat(_b)); } // Perubahan #35: desimal 1 angka
  o.alamat_antar = ($('ord-alamat') ? $('ord-alamat').value : o.alamat_antar);

  const adaUtama = o.cuci || !!o.kering;
  if (!adaUtama && Object.keys(o.produk).length === 0) { toast('Pilih layanan dulu', 'warning'); return; }
  if (adaUtama && (!o.berat_kg || Number(o.berat_kg) <= 0)) { toast('Isi berat cucian', 'warning'); return; }
  const maxMesinSubmit = maxKapasitasWasher();
  if (adaUtama && maxMesinSubmit != null && Number(o.berat_kg) > maxMesinSubmit) {
    toast(`Berat melebihi kapasitas mesin cuci terbesar di cabang ini (maks ${maxMesinSubmit} kg). Silakan buat pesanan terpisah.`, 'warning');
    if ($('ord-berat')) $('ord-berat').value = '';
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
  if (!o.hp || o.hp.length < 9) { toast('Nomor HP wajib & valid', 'warning'); return; }
  if (!o.nama || o.nama.length < 2) { toast('Nama wajib diisi', 'warning'); return; }
  if (o.antar && (!o.alamat_antar || o.alamat_antar.trim().length < 5)) { toast('Alamat antar wajib diisi', 'warning'); return; }
  if (o.antar) { const la = findL(o.antar) || {}; if (la.satuan_hitung === 'per_km' && !(Number(o.antar_km) > 0)) { toast('Isi perkiraan jarak (km)', 'warning'); return; } }

  const btn = $('btn-submit-order');
  btnLoad(btn, true);
  try {
    const res = await api('/customer/transaksi', { method: 'POST', body: buildPayload() });
    const trx = res.data;
    // reserve poin: hanya update diskon/total, point belum dikurangi (dikurangi saat kasir bayar)
    if (S.order.poin_dipakai >= 40) {
      try {
        await api('/customer/transaksi/' + trx.id + '/reserve-poin', { method: 'POST', body: { poin_dipakai: S.order.poin_dipakai } });
      } catch (pe) { toast('Poin gagal direservasi: ' + pe.message, 'warning'); }
    }
    // login implicit: ingat HP + set pelanggan
    S.hp = o.hp; rememberHp(o.hp);
    S.pelanggan = S.pelanggan || { nama: o.nama, telepon: o.hp, point: 0 };
    S.pelanggan.nama = o.nama;
    refreshNavLock();
    S.order = blankOrder();
    const bar = document.getElementById('total-bar'); if (bar) bar.remove();
    sheetOrderSukses(trx);
  } catch (e) {
    toast(e.message || 'Gagal membuat pesanan', 'danger');
  } finally {
    btnLoad(btn, false);
  }
}

const PROMO_LABEL = {
  gratis_cuci_pelanggan_baru: 'Cuci Gratis — Pelanggan Baru 🎉',
  gratis_cuci_jumat_berkah: 'Cuci Gratis — Jumat Berkah 🎉',
};

function sheetOrderSukses(trx) {
  openSheet(`
    <div style="text-align:center;">
      <div class="gate-icon-sm gi-loc" style="background:var(--success-light);color:var(--success);margin:0 auto 14px;"><i class="fas fa-check"></i></div>
      <h3 style="text-align:center;">Pesanan Dibuat!</h3>
      ${trx.jenis_promo && PROMO_LABEL[trx.jenis_promo] ? `
        <div style="display:inline-flex;align-items:center;gap:6px;background:var(--success-light);color:var(--success);padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:10px;">
          <i class="fas fa-gift"></i> ${esc(PROMO_LABEL[trx.jenis_promo])}
        </div><br>` : ''}
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:6px;">No. Invoice</p>
      <div style="font-size:18px;font-weight:700;color:var(--primary);margin-bottom:4px;">${esc(trx.no_invoice || '-')}</div>
      ${trx.kode_antrian ? `<p style="font-size:12px;color:var(--text-muted);">Keranjang: ${esc(trx.kode_antrian)}</p>` : ''}
      <p style="font-size:13px;color:var(--text-muted);margin:14px 0 4px;">Total</p>
      <div style="font-size:22px;font-weight:700;margin-bottom:18px;">${rupiah(trx.total)}</div>
      <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:18px;">Bayar di kasir saat antar/ambil cucian. Status akan dikabarkan via WhatsApp.</p>
      <button class="btn-zl btn-primary-zl" onclick="closeSheet(); navTo('aktif');">Lihat Pesanan Aktif</button>
      <button class="btn-zl btn-light-zl" style="margin-top:10px;" onclick="closeSheet(); navTo('pesan');">Pesan Lagi</button>
    </div>`);
}

/* ============================================================
   PAGE: AKTIF & SELESAI
   ============================================================ */
function statusBadge(kode) {
  const k = kode || '';
  let cls = 'bz-default', label = k.replace(/_/g, ' ');
  if (k === 'menunggu_bayar') { cls = 'bz-wait'; label = 'Menunggu Bayar'; }
  else if (/^(sudah_bayar|alokasi|mulai|proses)/.test(k)) { cls = 'bz-proc'; label = 'Diproses'; }
  else if (/^(selesai_cuci|selesai_kering|selesai_setrika|selesai_lipat|siap_diambil)/.test(k)) { cls = 'bz-ready'; label = k === 'siap_diambil' ? 'Siap Diambil' : 'Hampir Selesai'; }
  else if (/^(sudah_diambil|selesai_antar)/.test(k)) { cls = 'bz-done'; label = 'Selesai'; }
  return `<span class="badge-zl ${cls}">${esc(label)}</span>`;
}

async function loadAktif() {
  const body = $('aktif-body'); body.innerHTML = spinner();
  try {
    const [resRiwayat, resTagihan] = await Promise.all([
      api(`/customer/riwayat?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}&tab=aktif`),
      api(`/customer/tagihan-qris?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}`).catch(() => ({ data: [] })),
    ]);
    const items = resRiwayat.data || [];
    const tagihan = resTagihan.data || [];
    _aktifTagihanTotal = tagihan.reduce((s, t) => s + (t.total || 0), 0);
    _aktifTagihanQrisTotal = tagihan.filter((t) => t.metode_bayar !== 'cash').reduce((s, t) => s + (t.total || 0), 0);
    _aktifCashList = tagihan.filter((t) => t.metode_bayar === 'cash').map((t) => ({ no_invoice: t.no_invoice, total: t.total || 0 }));
    // Perubahan #83: rincian per metode yang dipilih saat pesan
    _aktifRincian = {};
    // pakai daftar pesanan aktif (termasuk yang kode Kios-K-nya lagi menunggu dibayar)
    const belum = items.filter((t) => t.status_bayar !== 'lunas');
    _aktifTagihanTotal = belum.reduce((s2, t) => s2 + (Number(t.total) || 0), 0);
    belum.forEach((t) => {
      const k = ['qris', 'kiosk'].includes(t.metode_bayar) ? t.metode_bayar : 'cash';
      _aktifRincian[k] = _aktifRincian[k] || { jumlah: 0, total: 0 };
      _aktifRincian[k].jumlah++; _aktifRincian[k].total += (Number(t.total) || 0);
    });
    const _chipRinci = ['cash', 'qris', 'kiosk'].filter((k) => _aktifRincian[k])
      .map((k) => `<span class="rb-chip rb-${k}"><i class="fas ${INFO_METODE[k].ico}"></i> ${labelMetode(k)} Rp${_aktifRincian[k].total.toLocaleString('id-ID')}</span>`).join('');
    const tombolBayar = belum.length ? `
      <div class="card-zl" style="margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="flex:1;">
            <div style="font-size:12px;color:var(--text-muted);">${belum.length} pesanan belum lunas</div>
            <div style="font-size:17px;font-weight:800;">Rp${_aktifTagihanTotal.toLocaleString('id-ID')}</div>
          </div>
          <button class="btn-zl btn-primary-zl" style="width:auto;padding:10px 16px;" onclick="bayarSemua()"><i class="fas fa-wallet"></i> Bayar Semua</button>
        </div>
        <div class="rb-chips">${_chipRinci}</div>
      </div>` : '';
    body.innerHTML = tombolBayar + (items.length ? '<div class="tk-list">' + items.map((t) => orderCard(t, 'aktif')).join('') + '</div>' : emptyState('Belum ada pesanan aktif', 'fa-spinner'));
  } catch (e) { body.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation'); }
}

async function loadSelesai() {
  const body = $('selesai-body'); body.innerHTML = spinner();
  try {
    const res = await api(`/customer/riwayat?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}&tab=selesai`);
    const items = res.data || [];
    body.innerHTML = items.length ? '<div class="tk-list">' + items.map((t) => orderCard(t, 'selesai')).join('') + '</div>' : emptyState('Belum ada riwayat selesai', 'fa-clipboard-check');
  } catch (e) { body.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation'); }
}

/* ============================================================
   KARTU TICKET "Pesanan Aktif" / "Pesanan Selesai" -- data 100% real
   dari /customer/riwayat (lihat findByPelanggan() di transaksi.model.js
   & riwayat() di customer.service.js buat kategori_list/mesin_*_kode).
   Timeline 5-tahap DISARING sesuai layanan yang BENERAN dipesan (mis.
   cuci-only cuma nampilin Sudah Bayar -> Proses Cuci -> Siap Diambil).
   ============================================================ */

// Sama persis kelompoknya dengan buildStages()/status.js di server: tiap
// tahap status asli dipetakan ke salah satu dari 5 kelompok tampilan.
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
  const groups = [
    { idx: 0, label: bayarSaatAmbil ? 'Diterima' : 'Sudah Bayar' },
  ];
  if (set.has('cuci')) groups.push({ idx: 1, label: 'Proses Cuci' });
  if (set.has('kering')) groups.push({ idx: 2, label: 'Proses Kering' });
  if (set.has('setrika_lipat') || set.has('lipat')) groups.push({ idx: 3, label: 'Lipat' });
  groups.push({ idx: 4, label: delivery ? 'Diantar' : 'Siap Diambil' });
  return groups;
}

function tkPendekkanKode(kode) {
  if (!kode) return '';
  const parts = String(kode).split('-');
  const tail = parts.length > 1 ? parts.slice(1).join('-') : parts[0];
  const m = tail.match(/^([A-Za-z]+)0*(\d+)$/);
  return m ? m[1] + m[2] : tail;
}

// Warna badge kode mesin di card pesanan, ngikutin status proses mesin itu
// (BUKAN jenisnya -- icon yang beda-in jenis cuci/kering, ini cuma warna):
// kuning = teralokasi (ke-assign tapi belum jalan), merah = lagi jalan,
// hijau = selesai. `sub` = hasil tk3MesinSub() ('Selesai' / 'Mulai <jam>' / '').
function mesinBadgeColor(kode, sub) {
  if (!kode) return null;
  if (sub === 'Selesai') return '#16a34a'; // hijau -- selesai
  if (sub && sub.indexOf('Mulai') === 0) return '#dc2626'; // merah -- lagi jalan
  return '#d97706'; // kuning -- teralokasi, belum mulai
}

// Pill status kanan-atas: nama status SPESIFIK (bukan bucket "Diproses"
// generik), biar customer langsung tau lagi di tahap apa persis.
function tk3StatusPill(t) {
  const namaUp = esc((t.status_nama || '-').toUpperCase());
  let cls = 'tk3-pill';
  if (t.status_kode === 'menunggu_bayar') cls += ' tk3-pill-new';
  else if (/^(selesai_cuci|selesai_kering|selesai_setrika|selesai_lipat|selesai_antar|sudah_diambil|siap_diambil)$/.test(t.status_kode || '')) cls += ' tk3-pill-ready';
  else cls += ' tk3-pill-proses';
  return `<span class="${cls}">${namaUp}</span>`;
}

// Chip kecil di bawah pill status: timer/countdown atau info aksi
// selanjutnya, tergantung sidebar.kind dari tkSidebarInfo() (data real dari
// t.mesin_pakai/t.next_action, cuma ada di tab aktif).
function tk3TimerChip(sidebar) {
  if (sidebar.kind === 'jalan' && sidebar.sisaMenit != null) {
    // Gak perlu label "(cuci)"/"(kering)" lagi -- udah jelas dari pill status
    // ("PROSES CUCI"/"PROSES KERING") persis di atas chip ini.
    return `<span class="tk3-timer"><i class="fas fa-hourglass-half"></i> <b class="tk3-timer-num">${sidebar.sisaMenit}</b> menit lagi</span>`;
  }
  if (sidebar.kind === 'antri') {
    return `<span class="tk3-timer tk3-timer-muted"><i class="fas fa-clock"></i> ${esc(sidebar.label || 'Antre mesin')}</span>`;
  }
  if (sidebar.kind === 'alokasi' && sidebar.selanjutnya) {
    return `<span class="tk3-timer tk3-timer-muted"><i class="fas fa-arrow-right"></i> ${esc(sidebar.selanjutnya)}</span>`;
  }
  if (sidebar.kind === 'selanjutnya') {
    return `<span class="tk3-timer tk3-timer-muted"><i class="fas fa-arrow-right"></i> ${esc(sidebar.label)}</span>`;
  }
  return '';
}

// Baris "Mulai <jam>" / "Selesai" di bawah kode mesin cuci/kering di kolom
// tengah -- dari t.mesin_pakai (enrichment getDetail(), cuma ada di tab
// aktif) memakai waktu_mulai real dari mesin_usage.
function tk3MesinSub(t, tipe) {
  const m = (t.mesin_pakai || []).find((x) => x.tipe === tipe);
  if (!m) return '';
  if (m.selesai) return 'Selesai';
  if (m.waktu_mulai) return `Mulai ${fmtJam(m.waktu_mulai)}`;
  return '';
}

// Sisi kanan (stub): tergantung tahap sekarang -- lagi jalan (timer), lagi
// antre mesin, ada aksi berikutnya (mis. "Mulai Cuci di W1"), atau selesai.
// Sepenuhnya dari data real: t.mesin_pakai/t.next_action (cuma ada di tab
// aktif, hasil enrichment getDetail() di server -- lihat customer.service.js).
function tkSidebarInfo(t, from) {
  if (from !== 'aktif') return { kind: 'selesai' };
  const na = t.next_action || {};
  const jalan = (t.mesin_pakai || []).find((m) => !m.selesai);
  if (jalan && (t.status_kode === 'mulai_cuci' || t.status_kode === 'mulai_kering')) {
    const sisa = jalan.durasi_target != null ? Math.max(0, jalan.durasi_target - (jalan.durasi_menit || 0)) : null;
    return { kind: 'jalan', kodeMesin: jalan.kode_mesin, tipe: jalan.tipe, sisaMenit: sisa };
  }
  if (na.tipe === 'menunggu_antrian') return { kind: 'antri', label: na.label, estimasi: na.estimasi_menit };
  if (t.status_kode === 'alokasi_mesin_cuci' || t.status_kode === 'alokasi_mesin_kering') {
    const kodeMesin = t.status_kode === 'alokasi_mesin_cuci' ? t.mesin_cuci_kode : t.mesin_kering_kode;
    return { kind: 'alokasi', kodeMesin, selanjutnya: nextActionLabelCustomer(t) };
  }
  const selanjutnya = nextActionLabelCustomer(t);
  if (selanjutnya) return { kind: 'selanjutnya', label: selanjutnya };
  return { kind: 'none' };
}

// Kartu 3D/neumorphic satu blok. Susunan konten ngikutin acuan referensi
// user (header outlet+status, baris layanan, 3 kolom invoice/mesin/keranjang,
// footer bayar+total) -- gaya visualnya timbul/3D, bukan outline flat kayak
// acuannya. Semua data tetap 100% dari database (lihat findByPelanggan() di
// transaksi.model.js & getDetail() di transaksi.service.js).
function orderCard(t, from) {
  const sidebar = tkSidebarInfo(t, from);
  const groups = tkActiveStages(t.kategori_list, t.status_bayar !== 'lunas' && !!Number(t.bayar_saat_ambil));
  const curRaw = tkStageIndex(t.status_kode);
  // Tab selesai = transaksi sudah tuntas -> semua tahap "done" (bukan "now" di
  // tahap terakhir), biar keliatan beres semua, bukan seolah masih berjalan.
  const curPos = from === 'selesai' ? groups.length : Math.max(0, groups.findIndex((g) => g.idx === curRaw));
  const stepsHtml = groups.map((g, i) => `<li class="${i < curPos ? 'done' : i === curPos ? 'now' : ''}">${esc(g.label)}</li>`).join('');
  // no_invoice formatnya "ZL01-YYYYMMDD-seq" (lihat generateNoInvoice() di
  // src/helpers/invoice.js). Kode cabang di depan dibuang dari tampilan
  // (customer buka app cabang sendiri, gak perlu liat kodenya) -- sisanya
  // (tanggal-seq) yang ditampilkan utuh.
  const invoiceStr = String(t.no_invoice || '-');
  const dashIdx = invoiceStr.indexOf('-');
  const invNomor = dashIdx === -1 ? invoiceStr : invoiceStr.slice(dashIdx + 1);
  // Header kartu di role CUSTOMER nampilin identitas OUTLET (nama + WA cabang),
  // bukan data diri pelanggan sendiri -- percuma nampilin nama/HP sendiri ke
  // diri sendiri, yang berguna justru kontak outlet buat ditanya/dihubungi.
  // Kebalikannya di role KASIR: orderCard() di public/kasir/app.js sudah
  // nampilin nama+telepon PELANGGAN (t.pelanggan), karena kasir yang perlu
  // tau itu pesanan siapa.
  const nama = (S.cabang && S.cabang.nama) || 'Outlet';
  const telepon = (S.cabang && S.cabang.no_hp) || '';
  const cuciKode = t.mesin_cuci_kode ? esc(tkPendekkanKode(t.mesin_cuci_kode)) : '';
  const keringKode = t.mesin_kering_kode ? esc(tkPendekkanKode(t.mesin_kering_kode)) : '';
  const cuciSub = tk3MesinSub(t, 'washer');
  const keringSub = tk3MesinSub(t, 'dryer');
  // Warna beda per status proses (kuning/merah/hijau, lihat mesinBadgeColor())
  // -- icon-nya TETAP beda per jenis mesin (fa-soap vs fa-wind di pemanggil),
  // cuma warnanya yang ngikutin status.
  const cuciColor = mesinBadgeColor(t.mesin_cuci_kode, cuciSub);
  const keringColor = mesinBadgeColor(t.mesin_kering_kode, keringSub);
  const cell = (icon, label, val, sub, big, color) => `
        <div class="tk3-cell">
          <span class="tk3-cell-ico"${color ? ` style="color:${color}"` : ''}><i class="fas ${icon}"></i></span>
          <div>
            <p class="tk3-cell-label">${label}</p>
            <p class="tk3-cell-val${big ? ' tk3-cell-mesin' : ''}${val ? '' : ' pending'}"${color ? ` style="color:${color}"` : ''}>${val || '-'}</p>
            ${sub ? `<p class="tk3-cell-sub">${esc(sub)}</p>` : ''}
          </div>
        </div>`;

  return `
    <article class="tk3-card" onclick="openDetail(${t.id}, '${from}')">
      <header class="tk3-head">
        <div class="tk3-who">
          <span class="tk3-avatar"><i class="fas fa-store"></i></span>
          <div>
            <h3 class="tk3-who-name">${esc(nama)}</h3>
            ${telepon ? `<a class="tk3-wa" href="https://wa.me/62${esc(telepon.replace(/\D/g, '').replace(/^0/, ''))}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i> ${esc(telepon)}</a>` : ''}
          </div>
        </div>
        <div class="tk3-status">
          ${tk3StatusPill(t)}
          ${tk3TimerChip(sidebar)}
        </div>
      </header>
      <p class="tk3-layanan"><i class="fas fa-shirt"></i> ${esc(t.layanan_label || '-')}${t.berat_kg ? ` · ${esc(t.berat_kg)} kg` : ''}</p>
      <div class="tk3-divider"></div>
      <div class="tk3-grid">
        ${cell('fa-receipt', 'Invoice', esc(invNomor), fmtDate(t.tanggal))}
        ${cell('fa-soap', 'Mesin Cuci', cuciKode, cuciSub, true, cuciColor)}
        ${cell('fa-wind', 'Mesin Kering', keringKode, keringSub, true, keringColor)}
        ${cell('fa-basket-shopping', 'Keranjang', t.kode_antrian ? esc(tkPendekkanKode(t.kode_antrian)) : '', '', true)}
      </div>
      <ol class="tk3-steps" style="grid-template-columns:repeat(${groups.length},1fr);">${stepsHtml}</ol>
      <div class="tk3-divider"></div>
      <footer class="tk3-foot">
        <div class="tk3-total">
          <span>Total</span><strong>${rupiah(t.total)}</strong>
          <em class="tk3-pay ${t.status_bayar === 'lunas' ? '' : 'unpaid'}"><i class="fas ${t.status_bayar === 'lunas' ? 'fa-circle-check' : 'fa-clock'}"></i> ${t.status_bayar === 'lunas' ? esc(labelMetode(t.metode_bayar).toUpperCase()) + ' · LUNAS' : Number(t.bayar_saat_ambil) ? 'BAYAR SAAT AMBIL' : 'BELUM BAYAR · ' + esc(labelMetode(t.metode_bayar).toUpperCase())}</em>
        </div>
        <span class="tk3-hint">Detail <i class="fas fa-chevron-right" style="font-size:.7em;"></i></span>
      </footer>
    </article>`;
}

/* ============================================================
   PAGE: DETAIL / TRACKING
   ============================================================ */
let _detailPollInt = null;
function openDetail(id, from) { S.detailFrom = from || 'aktif'; navToDetail(id); }
function backFromDetail() {
  clearInterval(_detailPollInt); _detailPollInt = null;
  navTo(S.detailFrom || 'aktif');
}
function navToDetail(id) {
  S.currentPage = 'detail';
  { const tb = document.getElementById('total-bar'); if (tb) tb.remove(); }
  document.querySelectorAll('.app-page').forEach((p) => p.classList.remove('active'));
  $('page-detail').classList.add('active');
  window.scrollTo(0, 0);
  loadDetail(id);
  // refresh berkala biar timer proses mesin & status tetap up to date selama customer nunggu
  clearInterval(_detailPollInt);
  _detailPollInt = setInterval(() => {
    if (S.currentPage === 'detail' && document.visibilityState === 'visible') loadDetail(id);
  }, 20000);
}

async function loadDetail(id) {
  const body = $('detail-body'); body.innerHTML = spinner();
  try {
    const res = await api(`/customer/transaksi/${id}?cabang_id=${S.cabang.id}&telepon=${encodeURIComponent(S.hp)}`);
    renderDetail(res.data);
  } catch (e) { body.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation'); }
}

function renderDetail(d) {
  $('detail-sub').textContent = d.no_invoice || '-';
  const items = d.items || [];
  const riwayat = d.riwayat || [];

  let html = '';
  // status terkini: pakai log terakhir, fallback ke status header (mis. belum ada log)
  const last = riwayat.length ? riwayat[riwayat.length - 1] : null;
  const statusKode = (last && last.kode) || d.status_kode || '';
  html += `<div class="card-zl" style="text-align:center;">
      <div style="font-size:12px;color:var(--text-muted);">Status saat ini</div>
      <div style="margin-top:8px;">${statusBadge(statusKode)}</div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted);">
        ${d.status_bayar === 'lunas' ? '<i class="fas fa-circle-check" style="color:var(--success);"></i> Sudah dibayar' : (Number(d.bayar_saat_ambil) ? '<i class="fas fa-hand-holding-dollar" style="color:#ea580c;"></i> Bayar saat ambil cucian di kasir' : '<i class="fas fa-clock" style="color:var(--warning);"></i> Belum dibayar — selesaikan di kasir')}
      </div>
    </div>`;

  // proses mesin — wewenang customer (pilih mesin / mulai / selesai cuci & kering)
  // + warning kalau durasi target sudah tercapai (sama seperti kasir)
  html += renderProsesMesinSection(d);

  // timeline
  if (riwayat.length) {
    html += `<div class="section-label"><i class="fas fa-timeline"></i> Riwayat Proses</div><div class="card-zl"><div class="timeline">`;
    riwayat.forEach((r, i) => {
      const isLast = i === riwayat.length - 1;
      const mesinInfo = r.kode_mesin
        ? `<div style="font-size:12px;color:var(--primary);font-weight:600;margin-top:2px;"><i class="fas fa-${r.mesin_tipe === 'dryer' ? 'wind' : 'soap'}"></i> ${esc(tkPendekkanKode(r.kode_mesin))}</div>`
        : '';
      // Catatan tambahan (mis. "Perubahan alokasi mesin D5 ke D1 oleh kasir"
      // pas kasir switch mesin -- lihat gantiMesin() di transaksi.service.js;
      // kode mesin di teksnya udah dipendekin dari sononya di server).
      const keteranganInfo = r.keterangan
        ? `<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-top:2px;">${esc(r.keterangan)}</div>`
        : '';
      html += `<div class="tl-step ${isLast ? 'current' : 'done'}">
        <div class="tl-dot"></div>
        <div class="tl-label">${esc(r.nama || r.kode)}</div>
        ${mesinInfo}
        ${keteranganInfo}
        <div style="font-size:11px;color:var(--slate-light);">${fmtDate(r.waktu)}</div>
      </div>`;
    });
    html += `</div></div>`;
  }

  // item
  html += `<div class="section-label"><i class="fas fa-list"></i> Rincian</div><div class="card-zl">`;
  items.forEach((it) => {
    html += `<div class="item-line"><span>${esc(it.nama_item)} ${it.qty > 1 ? '×' + it.qty : ''}</span><span>${rupiah(it.subtotal)}</span></div>`;
  });
  if (Number(d.diskon) > 0) {
    html += `<div class="drow" style="color:var(--success);"><span class="dl"><i class="fas fa-star"></i> Tukar Poin</span><span class="dv">- ${rupiah(d.diskon)}</span></div>`;
  }
  html += `<div class="drow" style="margin-top:6px;"><span class="dl">Total</span><span class="dv" style="color:var(--primary);font-size:15px;">${rupiah(d.total)}</span></div>`;
  html += `<div class="drow"><span class="dl">Pembayaran</span><span class="dv">${esc(labelMetode(d.metode_bayar))} · ${d.status_bayar === 'lunas' ? 'Lunas' : 'Belum'}</span></div>`;
  html += `</div>`;

  if (d.kode_antrian) html += `<div class="card-zl" style="text-align:center;"><div style="font-size:12px;color:var(--text-muted);">Kode Keranjang</div><div style="font-size:20px;font-weight:700;color:var(--primary);">${esc(d.kode_antrian)}</div></div>`;

  // tombol cetak nota untuk customer
  html += `<div style="display:flex;gap:8px;margin-top:12px;">
    <button class="btn-zl btn-light-zl" onclick="cetakNotaCustomer(false)" style="flex:1;font-size:12px;"><i class="fas fa-receipt"></i> Simpan Nota</button>
    <button class="btn-zl btn-light-zl" onclick="cetakNotaCustomer(true)" style="flex:1;font-size:12px;"><i class="fas fa-timeline"></i> Nota + Timeline</button>
  </div>`;

  $('detail-body').innerHTML = html;
  // simpan data untuk fungsi cetak
  window._customerDetailData = d;
}

/* ============================================================
   WEWENANG CUSTOMER: PROSES MESIN
   =============================================================
   Setelah kasir konfirmasi bayar, customer boleh menjalankan sendiri
   3 tahap mesin: Pilih Mesin -> Mulai Cuci/Kering -> Selesai Cuci/Kering.
   Tahap lain (antar, setrika, siap diambil, dst) tetap kasir-only —
   server (next_action) yang menentukan tahap mana yang boleh, bukan UI ini.
   ============================================================ */
const CUSTOMER_MESIN_STATUS = {
  alokasi_mesin_cuci:   { label: 'Pilih Mesin',   tipe: 'washer' },
  alokasi_mesin_kering: { label: 'Pilih Mesin',   tipe: 'dryer'  },
  mulai_cuci:           { label: 'Mulai Cuci' },
  mulai_kering:         { label: 'Mulai Kering' },
  selesai_cuci:         { label: 'Selesai Cuci' },
  selesai_kering:       { label: 'Selesai Kering' },
};
const PM = { transaksiId: null, tipe: null, pick: null };

/**
 * Label tahap berikutnya buat ditampilkan ke customer, termasuk kode mesin kalau relevan
 * (mis. "Mulai Cuci di Mesin W02"). Dipakai bareng di list "Pesanan Aktif" & detail pesanan
 * biar konsisten. `t` = objek transaksi yang punya next_action, riwayat, mesin_pakai
 * (dari /customer/transaksi/:id atau /customer/riwayat?tab=aktif).
 */
function nextActionLabelCustomer(t) {
  const na = (t && t.next_action) || {};
  if (!na.target && !na.label) return null;
  // Mode alokasi otomatis: server udah hitungin label yang tepat (termasuk
  // prediksi kode mesin / estimasi antrian) -- pakai apa adanya, jangan
  // ditimpa lookup statis CUSTOMER_MESIN_STATUS.
  if (na.tipe === 'lanjut' || na.tipe === 'menunggu_antrian' || na.tipe === 'menunggu_otomatis' || na.tipe === 'menunggu_gate') {
    return na.label || null;
  }
  const info = CUSTOMER_MESIN_STATUS[na.target];
  if (!info) return na.label || null; // tahap di luar wewenang customer (mis. kasir-only) -> tampilin apa adanya
  const jalan = (t.mesin_pakai || []).find((m) => !m.selesai);
  const riwayatAlokasi = (t.riwayat || []).filter((r) => r.kode === 'alokasi_mesin_cuci' || r.kode === 'alokasi_mesin_kering').pop();
  const kodeSumber = (jalan && jalan.kode_mesin) || (riwayatAlokasi && riwayatAlokasi.kode_mesin) || '';
  const kodeMesin = kodeSumber ? tkPendekkanKode(kodeSumber) : '';
  return kodeMesin && na.tipe !== 'pilih_mesin' ? `${info.label} di Mesin ${kodeMesin}` : info.label;
}

function fmtDurasi(menit) {
  if (menit == null) return '-';
  if (menit < 60) return menit + '"';
  const j = Math.floor(menit / 60), mn = menit % 60;
  return mn ? `${j}j ${mn}"` : `${j}j`;
}

function renderProsesMesinSection(d) {
  let html = '';

  // mesin yang sedang jalan untuk pesanan ini -> tampilkan ESTIMASI SELESAI
  // (countdown target-elapsed, BUKAN waktu yang udah berjalan) + warning overdue.
  const jalan = (d.mesin_pakai || []).find((m) => !m.selesai);
  if (jalan) {
    const target = jalan.durasi_target;
    const elapsed = jalan.durasi_menit;
    const overdue = !!(target && elapsed != null && elapsed >= target);
    const sisaTampil = (target != null && elapsed != null) ? Math.max(0, target - elapsed) : elapsed;
    html += `<div class="section-label"><i class="fas fa-gear"></i> Proses Mesin</div>
      <div class="card-zl">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">${esc(jalan.kode_mesin ? tkPendekkanKode(jalan.kode_mesin) : '-')} · ${jalan.tipe === 'dryer' ? 'Pengering' : 'Cuci'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;"><i class="fas fa-gear fa-spin"></i> Sedang berjalan</div>
          </div>
          <div style="font-size:18px;font-weight:800;color:${overdue ? '#dc2626' : 'var(--primary)'};">${esc(fmtDurasi(sisaTampil))}</div>
        </div>
        ${overdue ? `<div style="margin-top:10px;background:#dc2626;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;">
          <i class="fas fa-triangle-exclamation"></i> Waktu proses sudah tercapai — silakan lanjutkan ke tahap berikutnya
        </div>` : ''}
      </div>`;
  }

  // aksi berikutnya yang boleh dikerjakan customer sendiri (server yang menentukan lewat next_action)
  const na = d.next_action || {};

  // "Selesai Kering": TIDAK ADA tombol manual -- murni nunggu auto-complete
  // sistem (durasi dryer sudah pasti sejak awal, dipilih customer sendiri).
  // Ditampilin sebagai tombol merah-disabled (gaya sama kayak gate "Selesai
  // Cuci") biar konsisten, bukan teks polos -- estimasi selesainya dari
  // `jalan` (mesin kering yang lagi jalan, dihitung di atas).
  if ((d.status_bayar === 'lunas' || Number(d.bayar_saat_ambil)) && na.tipe === 'menunggu_otomatis') {
    const kodeKering = jalan && jalan.kode_mesin ? tkPendekkanKode(jalan.kode_mesin) : '';
    const sisaKering = (jalan && jalan.durasi_target != null && jalan.durasi_menit != null)
      ? Math.max(0, jalan.durasi_target - jalan.durasi_menit) : null;
    const labelKering = kodeKering
      ? `Proses Kering di ${kodeKering}${sisaKering != null ? `, estimasi selesai ${sisaKering} menit lagi` : ''}`
      : 'Proses Kering';
    html += `<div class="card-zl" style="margin-top:${jalan ? '10px' : '0'};">
      <button class="btn-zl" disabled
        style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
               padding:8px 8px 8px 20px;background:#dc2626;color:#fff;
               border:none;border-radius:999px;font-size:15px;font-weight:700;
               box-shadow:none;cursor:not-allowed;">
        <span style="display:flex;align-items:center;gap:10px;text-align:left;"><i class="fas fa-gear fa-spin" style="font-size:17px;"></i> ${esc(labelKering)}</span>
        <span style="width:38px;height:38px;border-radius:50%;background:#fff;flex-shrink:0;
                     display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.25);">
          <i class="fas fa-power-off" style="color:#9ca3af;font-size:15px;"></i>
        </span>
      </button>
    </div>`;
    return html;
  }

  // Semua mesin penuh -> antre (mode alokasi otomatis). Ditampilkan PERSISTEN
  // (bukan toast sekilas) sampai beneran dapat mesin -- halaman ini auto-poll
  // tiap 20 detik (lihat navToDetail), jadi begitu dapat mesin, section ini
  // otomatis ganti sendiri jadi tombol "Mulai Cuci/Kering di Mesin WXX".
  if ((d.status_bayar === 'lunas' || Number(d.bayar_saat_ambil)) && na.tipe === 'menunggu_antrian') {
    const jenisTxt = na.mesin_tipe === 'dryer' ? 'mesin pengering' : 'mesin cuci';
    html += `<div class="card-zl" style="margin-top:${jalan ? '10px' : '0'};text-align:center;background:var(--primary-light);">
      <div style="font-size:13px;color:var(--primary);font-weight:700;"><i class="fas fa-users-line"></i> Anda dalam antrian</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
        ${na.mesin_antrian_pendek
          ? (na.siap_tunggu_bongkar
            ? `Mesin <b>${esc(na.mesin_antrian_pendek)}</b> sudah siap, tunggu pelanggan sebelumnya mengeluarkan cucian dari mesin.`
            : `Anda dapat ${jenisTxt} <b>${esc(na.mesin_antrian_pendek)}</b>. Estimasi mulai <b>± ${na.estimasi_menit || 1} menit</b> lagi.`)
          : `Semua ${jenisTxt} sedang terpakai. ${na.estimasi_menit
            ? `Estimasi tersedia dalam <b>${na.estimasi_menit} menit</b> lagi.`
            : 'Mohon tunggu sebentar.'}`}
      </div>
    </div>`;
    return html;
  }

  // Poin 10: "Alokasi Mesin Kering" (abis Selesai Cuci) TIDAK minta klik
  // customer lagi kalau cabang mode alokasi 'otomatis' & prediksi mesin udah
  // ada (na.tipe==='lanjut') -- auto-trigger di background (reuse endpoint yang
  // sama persis dgn tombol manual, cuma dipanggil sendiri di sini), langsung
  // lompat ke tombol "Jalankan Mesin Kering" begitu server selesai proses.
  // Mode manual (na.tipe==='pilih_mesin') TETAP minta customer pilih sendiri,
  // gak diubah -- lolos ke blok umum di bawah.
  if ((d.status_bayar === 'lunas' || Number(d.bayar_saat_ambil)) && na.target === 'alokasi_mesin_kering' && na.tipe === 'lanjut') {
    autoAlokasiMesinKering(d.id);
    html += `<div class="card-zl" style="margin-top:${jalan ? '10px' : '0'};text-align:center;">
      <div style="font-size:13px;color:var(--text-muted);"><i class="fas fa-circle-notch fa-spin"></i> Menyiapkan mesin kering...</div>
    </div>`;
    return html;
  }

  const info = CUSTOMER_MESIN_STATUS[na.target];
  if ((d.status_bayar === 'lunas' || Number(d.bayar_saat_ambil)) && info) {
    const action = na.tipe === 'pilih_mesin'
      ? `bukaPilihMesinCustomer(${d.id},'${info.tipe}')`
      : (na.target === 'mulai_kering' ? `konfirmasiPintuKering(${d.id})` : `lanjutProsesCustomer(${d.id})`);

    // "Selesai Cuci": terkunci sampai GATE_SELESAI_CUCI_MENIT (30 menit) sejak
    // mesin mulai jalan -- siklus bilas mesin cuci baru mulai setelah itu,
    // klik sebelum itu berarti cucian ditandai selesai padahal belum sempat
    // dibilas. Server (next_action.tipe==='menunggu_gate') yang nentuin ini,
    // bukan dihitung ulang di sini -- biar 1 sumber kebenaran, konsisten sama kasir.
    const locked = na.tipe === 'menunggu_gate';
    const isSelesaiCuci = na.target === 'selesai_cuci';
    const isMulaiMesin = na.target === 'mulai_cuci' || na.target === 'mulai_kering';

    // Kode mesin (short form, lihat tkPendekkanKode()) buat disisipin ke label
    // tombol -- prioritas: mesin yang lagi beneran jalan > prediksi dari server
    // (mode alokasi otomatis, sebelum mesin di-assign) > riwayat alokasi.
    const riwayatAlokasi = (d.riwayat || []).filter((r) => r.kode === 'alokasi_mesin_cuci' || r.kode === 'alokasi_mesin_kering').pop();
    const kodeRaw = (jalan && jalan.kode_mesin) || na.mesin_prediksi || (riwayatAlokasi && riwayatAlokasi.kode_mesin) || '';
    const kodePendek = kodeRaw ? tkPendekkanKode(kodeRaw) : '';

    // Sisa waktu REAL siklus cuci (target-elapsed dari `jalan`) -- BUKAN sisa
    // gate 25 menit (na.sisa_menit itu cuma "kapan tombolnya kebuka", bukan
    // estimasi selesai beneran, makanya gak dipakai buat teks di bawah).
    const sisaReal = (jalan && jalan.durasi_target != null && jalan.durasi_menit != null)
      ? Math.max(0, jalan.durasi_target - jalan.durasi_menit) : null;

    let label = nextActionLabelCustomer(d) || info.label;
    let btnBg = locked ? '#d1d5db' : '#9ca3af';
    let infoTeks = 'Anda diberi wewenang untuk melanjutkan proses pesanan ini.';
    if (isSelesaiCuci) {
      // Poin 6+8+9: "Selesai Cuci" SELALU merah (locked=disabled / unlocked=clickable),
      // teks estimasi pakai sisa waktu siklus CUCI beneran (bukan sisa gate),
      // dan banner info-nya diganti jadi instruksi "klik kalau mesin OFF".
      btnBg = '#dc2626';
      infoTeks = `Klik tombol dibawah apabila mesin ${kodePendek || 'cuci'} sudah OFF / selesai`;
      if (locked) {
        label = kodePendek
          ? `Proses Cuci di ${kodePendek}${sisaReal != null ? `, Estimasi selesai ${sisaReal} menit lagi` : ''}`
          : 'Proses Cuci';
      }
    } else if (isMulaiMesin) {
      // Poin 1 & 10: kuning + teks "Jalankan Mesin Cuci/Kering <kode>".
      const verb = na.target === 'mulai_kering' ? 'Kering' : 'Cuci';
      label = kodePendek ? `Jalankan Mesin ${verb} ${kodePendek}` : `Jalankan Mesin ${verb}`;
      btnBg = '#eab308';
    }

    html += `<div class="card-zl" style="margin-top:${jalan ? '10px' : '0'};">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;"><i class="fas fa-circle-info"></i> ${esc(infoTeks)}</div>
      <button class="btn-zl" id="btn-proses-mesin" onclick="${action}" ${locked ? 'disabled' : ''}
        style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
               padding:8px 8px 8px 20px;background:${btnBg};color:#fff;
               border:none;border-radius:999px;font-size:15px;font-weight:700;
               box-shadow:${locked ? 'none' : '0 2px 8px rgba(0,0,0,0.18)'};
               transition:background 0.2s ease;${locked ? 'cursor:not-allowed;' : 'cursor:pointer;'}">
        <span style="display:flex;align-items:center;gap:10px;text-align:left;"><i class="fas fa-gear" style="font-size:17px;"></i> ${esc(label)}</span>
        <span style="width:38px;height:38px;border-radius:50%;background:#fff;flex-shrink:0;
                     display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.25);">
          <i class="fas fa-power-off" style="color:${locked ? '#9ca3af' : '#6b7280'};font-size:15px;"></i>
        </span>
      </button>
    </div>`;
  }

  return html;
}

/**
 * Perubahan #21: sebagian besar start pengering gagal karena pintu belum
 * tertutup rapat (mesin error dC). Wajib centang dulu sebelum mesin dijalankan.
 */
function konfirmasiPintuKering(transaksiId) {
  openSheet(`
    <h3><i class="fas fa-door-closed"></i> Sebelum menjalankan pengering</h3>
    <div class="card-zl" style="font-size:13px;line-height:1.5;">
      <div style="display:flex;gap:10px;align-items:flex-start;"><i class="fas fa-shirt" style="margin-top:3px;color:var(--primary);"></i><span>Pastikan semua cucian sudah masuk ke mesin pengering.</span></div>
      <div style="display:flex;gap:10px;align-items:flex-start;margin-top:8px;"><i class="fas fa-door-closed" style="margin-top:3px;color:#dc2626;"></i><span><b>Tutup pintu pengering dengan rapat sampai terdengar bunyi "klik".</b> Kalau pintu belum rapat, mesin tidak akan berputar.</span></div>
    </div>
    <label style="display:flex;gap:10px;align-items:center;font-size:13px;font-weight:600;margin:12px 0;cursor:pointer;">
      <input type="checkbox" id="cek-pintu-kering" onchange="$('btn-jalan-kering').disabled=!this.checked" style="width:20px;height:20px;">
      Cucian sudah masuk &amp; pintu SUDAH DITUTUP RAPAT
    </label>
    <button class="btn-zl btn-primary-zl" id="btn-jalan-kering" disabled onclick="closeSheet();lanjutProsesCustomer(${transaksiId})"><i class="fas fa-play"></i> Jalankan Pengering</button>`);
}

async function bukaPilihMesinCustomer(transaksiId, tipe) {
  PM.transaksiId = transaksiId; PM.tipe = tipe; PM.pick = null;
  openSheet(`<h3>Pilih Mesin ${tipe === 'washer' ? 'Cuci' : 'Pengering'}</h3><div id="pm-list">${spinner()}</div>`);
  try {
    const res = await api(`/customer/mesin?cabang_id=${S.cabang.id}&tipe=${tipe}`);
    const list = res.data || [];
    if (!list.length) { $('pm-list').innerHTML = emptyState('Tidak ada mesin tersedia saat ini', 'fa-gear'); return; }
    $('pm-list').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        ${list.map((m) => `
          <div class="pm-opt" data-id="${m.id}" onclick="pickMesinCustomer(${m.id})"
               style="border:2px solid var(--border);border-radius:10px;padding:10px 6px;text-align:center;cursor:pointer;">
            <div style="font-weight:700;font-size:13px;">${esc(tkPendekkanKode(m.kode_mesin))}</div>
            <div style="font-size:11px;color:var(--text-muted);">${m.kapasitas_kg || '-'} kg</div>
          </div>`).join('')}
      </div>
      <button class="btn-zl btn-primary-zl" id="btn-pm-pilih" onclick="doPilihMesinCustomer()" disabled style="margin-top:16px;">Pilih & Lanjut</button>`;
  } catch (e) { $('pm-list').innerHTML = emptyState('Gagal memuat mesin. ' + e.message, 'fa-triangle-exclamation'); }
}

function pickMesinCustomer(id) {
  PM.pick = id;
  document.querySelectorAll('.pm-opt').forEach((o) => {
    const sel = Number(o.dataset.id) === id;
    o.style.borderColor = sel ? 'var(--primary)' : 'var(--border)';
    o.style.background = sel ? 'var(--primary-light)' : '';
  });
  $('btn-pm-pilih').disabled = false;
}

async function doPilihMesinCustomer() {
  if (!PM.pick) { toast('Pilih mesin dulu', 'warning'); return; }
  const btn = $('btn-pm-pilih'); btnLoad(btn, true);
  try {
    await api(`/customer/transaksi/${PM.transaksiId}/mesin?cabang_id=${S.cabang.id}`, {
      method: 'POST', body: { telepon: S.hp, mesin_id: PM.pick },
    });
    closeSheet(); toast('Mesin dipilih', 'success');
    loadDetail(PM.transaksiId);
  } catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
}

// Poin 10: guard anti-dobel-panggil buat auto-alokasi mesin kering -- section
// renderProsesMesinSection() bisa render ulang berkali-kali (poll 20 detik,
// atau re-render lain) SEBELUM response pertama balik, jadi tanpa guard ini
// bisa nembak POST /mesin berkali-kali barengan buat transaksi yang sama.
const _autoAlokasiKeringInFlight = new Set();
async function autoAlokasiMesinKering(transaksiId) {
  if (_autoAlokasiKeringInFlight.has(transaksiId)) return;
  _autoAlokasiKeringInFlight.add(transaksiId);
  try {
    await api(`/customer/transaksi/${transaksiId}/mesin?cabang_id=${S.cabang.id}`, {
      method: 'POST', body: { telepon: S.hp },
    });
    // begitu server confirm, refresh detail -- section ini otomatis ganti
    // sendiri jadi tombol "Jalankan Mesin Kering <kode>" (na.target berubah).
    if (S.currentPage === 'detail') loadDetail(transaksiId);
  } catch (e) {
    // Diem-diem aja (mis. race semua dryer keburu penuh) -- render berikutnya
    // (poll 20 detik) bakal baca next_action terbaru dari server & nyesuaiin
    // sendiri (jatuh ke cabang 'menunggu_antrian' kalau memang penuh).
    console.warn('Auto-alokasi mesin kering gagal (akan dicoba ulang di poll berikutnya)', e.message);
  } finally {
    _autoAlokasiKeringInFlight.delete(transaksiId);
  }
}

async function lanjutProsesCustomer(transaksiId) {
  const btn = $('btn-proses-mesin');
  // feedback instan begitu ditekan (abu2 -> hijau) -- nggak nunggu server dulu,
  // biar customer langsung ngerasa "ke-pencet", baru nanti detail di-refresh
  // penuh dari loadDetail() begitu server konfirmasi.
  if (btn) { btn.style.background = '#16a34a'; btnLoad(btn, true); }
  try {
    await api(`/customer/transaksi/${transaksiId}/mesin?cabang_id=${S.cabang.id}`, {
      method: 'POST', body: { telepon: S.hp },
    });
    toast('Proses diperbarui', 'success');
    loadDetail(transaksiId);
  } catch (e) {
    if (e.details && e.details.antrian) {
      // "Semua mesin penuh, masuk antrian" itu KONDISI NORMAL (bukan
      // kegagalan) -- kasih info netral, tampilan tetap balik ke status
      // antre + estimasi (bukan toast merah kayak error beneran).
      toast('Semua mesin sedang penuh, pesanan Anda masuk antrian', 'warning');
      loadDetail(transaksiId);
    } else {
      toast(e.message || 'Gagal', 'danger');
    }
    if (btn) { btn.style.background = '#9ca3af'; btnLoad(btn, false); }
  }
}

/* ============================================================
   PAGE: PROFIL / DATA SAYA
   ============================================================ */
async function loadProfil() {
  const p = S.pelanggan || {};
  const body = $('profil-body');
  body.innerHTML = `
    <div class="card-zl" style="text-align:center;">
      <div class="ah-avatar" style="margin:0 auto 10px;background:var(--primary-light);color:var(--primary);width:64px;height:64px;font-size:26px;"><i class="fas fa-user"></i></div>
      <div style="font-size:18px;font-weight:700;">${esc(p.nama || '-')}</div>
      <div style="font-size:13px;color:var(--text-muted);">${esc(p.telepon || S.hp || '-')}</div>
      <div style="margin-top:12px;display:inline-flex;gap:6px;align-items:center;background:var(--primary-light);color:var(--primary);padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;">
        <i class="fas fa-star"></i> ${p.point || 0} poin
      </div>
    </div>
    <div class="section-label"><i class="fas fa-store"></i> Outlet</div>
    <div class="card-zl">
      <div class="drow"><span class="dl">Cabang</span><span class="dv">${esc(S.cabang ? S.cabang.nama : '-')}</span></div>
      ${S.cabang && S.cabang.kota ? `<div class="drow"><span class="dl">Kota</span><span class="dv">${esc(S.cabang.kota)}</span></div>` : ''}
      <div id="profil-mesin-status">${mesinStatusRowHtml(null, 'Mesin Cuci')}${mesinStatusRowHtml(null, 'Mesin Pengering')}</div>
    </div>
    <div style="margin-top:16px;">
      <button class="btn-zl btn-light-zl" onclick="gantiOutlet()"><i class="fas fa-map-location-dot"></i> Ganti Outlet</button>
      <button class="btn-zl btn-danger-zl" style="margin-top:10px;" onclick="lupakanSaya()"><i class="fas fa-right-from-bracket"></i> Lupakan Saya (di HP ini)</button>
    </div>
    <p style="font-size:11px;color:var(--slate-light);text-align:center;margin-top:14px;line-height:1.6;">
      Data pesanan tetap aman di server. "Lupakan saya" hanya menghapus ingatan nomor HP di perangkat ini.
    </p>`;

  if (S.cabang && S.cabang.id) loadMesinStatusProfil(S.cabang.id);
}

/** Baris status 1 tipe mesin ("Mesin Cuci" / "Mesin Pengering") di card Outlet. */
function mesinStatusRowHtml(st, label) {
  if (!st) {
    return `<div class="drow"><span class="dl">${esc(label)}</span><span class="dv"><span class="badge-zl bz-default">Memuat...</span></span></div>`;
  }
  const semuaTerpakai = st.idle === 0 && st.total > 0;
  const badge = semuaTerpakai
    ? `<span class="badge-zl bz-wait">Terpakai Semua</span>`
    : `<span class="badge-zl bz-done">Idle ${st.idle} Mesin</span>`;
  let baris = `<div class="drow"><span class="dl">${esc(label)}</span><span class="dv">${badge}</span></div>`;
  // ETA hanya muncul kalau semua mesin terpakai DAN ada estimasi menit; kalau ada
  // yang idle, baris ETA disembunyikan (customer sudah tahu bisa langsung pakai).
  if (semuaTerpakai && st.eta_menit != null) {
    baris += `<div style="font-size:11px;color:var(--text-muted);padding:0 0 9px;margin-top:-4px;">
      ${esc(label)} tersedia dalam ~${st.eta_menit} menit kedepan
    </div>`;
  }
  return baris;
}

async function loadMesinStatusProfil(cabangId) {
  const el = $('profil-mesin-status');
  if (!el) return;
  try {
    const res = await api(`/customer/mesin-status?cabang_id=${cabangId}`);
    const st = res.data || {};
    el.innerHTML = mesinStatusRowHtml(st.washer, 'Mesin Cuci') + mesinStatusRowHtml(st.dryer, 'Mesin Pengering');
  } catch (e) {
    el.innerHTML = `<div class="drow"><span class="dl">Status Mesin</span><span class="dv" style="color:var(--text-muted);font-weight:500;">Tidak tersedia</span></div>`;
  }
}

function gantiOutlet() { bukaGantiOutlet(); } // Perubahan #34
function lupakanSaya() {
  forgetHp();
  S.hp = null; S.pelanggan = null; S.order = blankOrder();
  refreshNavLock();
  toast('Nomor HP dilupakan di perangkat ini', 'success');
  navTo('pesan');
}

/* ============================================================
   CETAK NOTA CUSTOMER (JPG via html2canvas)
   withTimeline: false = nota ringkas, true = dengan riwayat proses
   ============================================================ */
function cetakNotaCustomer(withTimeline) {
  const d = window._customerDetailData;
  if (!d) { toast('Data belum siap, buka detail pesanan dulu', 'warning'); return; }

  if (typeof html2canvas === 'undefined') {
    toast('Library gambar belum dimuat (cek koneksi internet)', 'danger');
    return;
  }

  const cab = S.cabang || {};
  const outlet = cab.nama || 'ZLaundry';
  const alamatCab = [cab.alamat, cab.kota].filter(Boolean).join(', ');
  const telpCab = cab.no_hp || '';
  const items = d.items || [];
  const riw = d.riwayat || [];
  const belumBayar = d.status_bayar !== 'lunas';
  const judulStruk = belumBayar ? 'NOTA TAGIHAN' : 'TANDA TERIMA';
  const tgl = d.tanggal ? String(d.tanggal).slice(0, 16).replace('T', ' ') : '-';
  const krj = d.kode_keranjang || d.kode_antrian || '';

  const barisItem = items.map((it) => {
    const q = Number(it.qty) || 1;
    let suffix = '';
    if (it.item_tipe === 'barang') {
      suffix = ` ${q} ${it.barang_satuan || 'pcs'}`;
    } else {
      const map = { per_load: 'Load', per_kg: 'Kg', per_km: 'Km', per_sachet: 'Sachet', per_pcs: 'pcs' };
      const sat = map[it.satuan_hitung];
      suffix = sat ? ` ${q} ${sat}` : (q > 1 ? ` ×${q}` : '');
    }
    return `<tr><td>${esc(it.nama_item)}${suffix}</td><td style="text-align:right;">${rupiah(it.subtotal)}</td></tr>`;
  }).join('');

  // timeline proses (hanya jika withTimeline=true)
  let riwayatHtml = '';
  if (withTimeline && riw.length) {
    riwayatHtml = `<hr class="hr"><div class="c b">RIWAYAT PROSES</div><table>`;
    riw.forEach((r) => {
      const waktuFmt = r.waktu ? String(r.waktu).slice(0, 16).replace('T', ' ') : '-';
      riwayatHtml += `<tr><td>${esc(r.nama || r.kode)}</td><td style="text-align:right;white-space:nowrap;font-size:12px;">${esc(waktuFmt)}</td></tr>`;
    });
    riwayatHtml += `</table>`;
    // hitung total durasi proses
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

  // sosmed dari cabang
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
    <div class="row"><span>Nama</span><span class="r">${esc((d.pelanggan && d.pelanggan.nama) || '-')}</span></div>
    <div class="row"><span>Telp</span><span class="r">${esc((d.pelanggan && d.pelanggan.telepon) || S.hp || '-')}</span></div>
    <hr class="hr">
    <table>${barisItem}</table>
    <hr class="hr">
    ${d.berat_kg ? `<div class="row"><span>Berat</span><span class="r">${d.berat_kg} kg</span></div>` : ''}
    ${(Number(d.diskon) > 0) ? `
    <div class="row"><span>Subtotal</span><span class="r">${rupiah(d.subtotal)}</span></div>
    <div class="row" style="color:#16a34a;"><span>⭐ Tukar ${Number(d.poin_dipakai) || Math.round(Number(d.diskon) / 10)} poin</span><span class="r">- ${rupiah(d.diskon)}</span></div>` : ''}
    <div class="row b" style="font-size:17px;"><span>TOTAL</span><span class="r">${rupiah(d.total)}</span></div>
    ${belumBayar
      ? `<div class="krj" style="margin-top:6px;"><div>HARUS DIBAYAR</div><div class="v">${rupiah(d.total)}</div></div>
         <div class="c" style="font-size:11px;">Bayar di kasir saat antar/ambil cucian</div>`
      : `<div class="row"><span>Bayar</span><span class="r">${esc(labelMetode(d.metode_bayar).toUpperCase())} LUNAS</span></div>`}
    ${riwayatHtml}
    <hr class="hr">
    <div class="foot">${belumBayar
      ? `Mohon selesaikan pembayaran.<br>Simpan nota ini sebagai bukti pesanan.`
      : `Terima kasih sudah laundry<br>di ${esc(outlet)}.<br>Simpan struk ini sebagai bukti pengambilan.`}</div>
    ${sosmedHtml}
    <div class="foot">${new Date().toLocaleString('id-ID')}</div>
  `;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:-9999px;top:0;';
  const styleEl = document.createElement('style'); styleEl.textContent = css;
  const el = document.createElement('div'); el.className = 'struk'; el.innerHTML = isi;
  wrap.appendChild(styleEl); wrap.appendChild(el); document.body.appendChild(wrap);

  toast('Membuat nota...', 'success');
  html2canvas(el, { scale: 2, backgroundColor: '#ffffff' }).then((canvas) => {
    const jpg = canvas.toDataURL('image/jpeg', 0.92);
    document.body.removeChild(wrap);

    // Tampilkan preview modal
    const suffix = withTimeline ? '_timeline' : '';
    const namaFile = `Nota${suffix}_${(d.no_invoice || 'laundry')}.jpg`;
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
