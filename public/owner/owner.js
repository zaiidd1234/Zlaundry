/* ============================================================
   Perubahan #47 -- APP OWNER
   Dimuat SEBELUM ../manager/app.js. Fungsi umum (api, toast, openSheet,
   rupiah, esc, navTo, loadPerforma, loadCustomer, ...) berasal dari app
   manager; file ini menambah halaman owner:
     odash    : omzet hari/minggu/bulan, laba bersih bulan ini, status mesin
     ocabang  : kelola cabang + user (jatah cuci hanya di sini, #46)
     obukukas : buku kas (pantau) per cabang & gabungan
   Performa & Customer = layar manager + pilihan cabang (cabang_ids).
   ============================================================ */
(function () {
  const LS_PILIH = 'zl_owner_pilihan';
  const O = {
    cabang: [], pilihan: null, dash: null, users: null, tabCabang: 'cabang', filterUser: 'semua',
    kas: { dari: null, sampai: null, data: null },
  };
  const rp = (n) => (typeof rupiah === 'function' ? rupiah(n) : 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'));
  const ROLE_LABEL_O = { manager: 'Manager', kasir: 'Kasir', operator: 'Operator', kurir: 'Kurir' };

  function bacaPilihan() {
    try { const p = JSON.parse(localStorage.getItem(LS_PILIH) || 'null'); if (Array.isArray(p) && p.length) return p.map(Number); } catch (e) { /* abaikan */ }
    return null;
  }
  function idsPilihan() {
    const semua = O.cabang.filter((c) => c.status === 'aktif').map((c) => Number(c.id));
    const p = (O.pilihan || []).filter((x) => semua.includes(x));
    return p.length ? p : semua;
  }

  /** Dipanggil api() app manager untuk /performa & /pelanggan. */
  O.denganCabang = function (path) {
    if (/[?&]cabang_ids=/.test(path)) return path;
    const ids = idsPilihan();
    if (!ids.length) return path;
    return path + (path.includes('?') ? '&' : '?') + 'cabang_ids=' + ids.join(',');
  };

  O.mulai = async function () {
    if ($('ow-nama')) $('ow-nama').textContent = (S.user && S.user.nama) || 'Owner';
    O.pilihan = bacaPilihan();
    try { O.cabang = (await api('/owner/cabang')).data || []; } catch (e) { O.cabang = []; }
    navTo('odash');
  };

  O.nav = function (page) {
    if (page === 'odash') O.loadDash();
    else if (page === 'ocabang') O.loadCabang();
    else if (page === 'obukukas') O.loadKas();
  };

  /* ---------- pemilih cabang (Performa, Customer, Buku Kas) ---------- */
  function chipsCabang(onchange) {
    const ids = idsPilihan();
    const aktif = O.cabang.filter((c) => c.status === 'aktif');
    const semua = ids.length === aktif.length;
    return `<div class="ow-chips">
      <button class="${semua ? 'on' : ''}" onclick="OWNER.pilihCabang('semua','${onchange}')"><i class="fas fa-layer-group"></i> Semua cabang</button>
      ${aktif.map((c) => `<button class="${!semua && ids.includes(Number(c.id)) ? 'on' : ''}" onclick="OWNER.pilihCabang(${c.id},'${onchange}')">${esc(c.kode)}</button>`).join('')}
    </div>`;
  }
  O.pilihCabang = function (id, onchange) {
    const aktif = O.cabang.filter((c) => c.status === 'aktif').map((c) => Number(c.id));
    let ids = idsPilihan();
    if (id === 'semua') ids = aktif;
    else {
      const semua = ids.length === aktif.length;
      // dari "semua": klik satu cabang = hanya cabang itu; lalu klik lain = centang / hapus centang
      if (semua) ids = [Number(id)];
      else if (ids.includes(Number(id))) ids = ids.filter((x) => x !== Number(id));
      else ids = [...ids, Number(id)];
      if (!ids.length) ids = aktif;
    }
    O.pilihan = ids;
    try { localStorage.setItem(LS_PILIH, JSON.stringify(ids)); } catch (e) { /* abaikan */ }
    if (onchange === 'performa') { O.barCabang('performa'); loadPerforma(); }
    else if (onchange === 'customer') { O.barCabang('customer'); if (typeof CUST !== 'undefined' && CUST) { CUST.items = []; CUST.offset = 0; } loadCustomer(); }
    else if (onchange === 'kas') O.loadKas();
  };
  O.barCabang = function (page) {
    const el = $(page + '-cabsel'); if (!el) return;
    el.innerHTML = chipsCabang(page);
  };

  /* ---------- buka app manager / kasir sebagai owner ---------- */
  O.buka = function (app) {
    const kunci = app === 'kasir' ? ['zl_kasir_token', 'zl_kasir_user'] : ['zl_manager_token', 'zl_manager_user'];
    try { localStorage.setItem(kunci[0], S.token); localStorage.setItem(kunci[1], JSON.stringify(S.user)); } catch (e) { /* abaikan */ }
    window.OwnerCabang.pilih(S.token, API, { judul: `Buka sebagai ${app === 'kasir' ? 'Kasir' : 'Manager'} — pilih cabang`, tujuan: `../${app}/` });
  };

  /* ================= DASHBOARD ================= */
  O.loadDash = async function () {
    const body = $('odash-body'); if (!body) return;
    if (!O.dash) body.innerHTML = spinner();
    try { O.dash = (await api('/owner/dashboard')).data; renderDash(); }
    catch (e) { body.innerHTML = emptyState('Gagal memuat dashboard. ' + e.message, 'fa-triangle-exclamation'); }
  };
  function tglPendek(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function kartuOmzet(judul, total, f, ekstra = '', kelas = '') {
    const d = O.dash;
    return `<div class="ow-om ${kelas}"><div class="k">${judul}</div><div class="v">${rp(total)}${ekstra}</div>
      <div class="ow-cb">${d.cabang.map((c) => `<div>${esc(c.kode)}<b>${rp(f(c))}</b>${kelas === 'bln' && c.target_omzet_bulanan ? `<div class="ow-bar"><i style="width:${Math.min(100, Math.round((c.bulan_ini.omzet / c.target_omzet_bulanan) * 100))}%"></i></div>` : ''}</div>`).join('')}</div></div>`;
  }
  function renderDash() {
    const d = O.dash; const t = d.total;
    if ($('ow-sub')) $('ow-sub').textContent = `Owner · ${d.cabang.length} cabang · ${tglPendek(d.tanggal)}`;
    const pct = t.target_omzet_bulanan ? `<small>${Math.round((t.bulan_ini / t.target_omzet_bulanan) * 100)}% target</small>` : '';
    const bln = new Date(`${d.bulan_mulai}T00:00:00Z`).toLocaleDateString('id-ID', { month: 'long', timeZone: 'UTC' });
    let h = kartuOmzet('Omzet hari ini', t.hari_ini, (c) => c.hari_ini.omzet)
      + kartuOmzet(`Omzet minggu ini · ${tglPendek(d.minggu_mulai)} – ${tglPendek(d.tanggal)}`, t.minggu_ini, (c) => c.minggu_ini.omzet)
      + kartuOmzet(`Omzet bulan ini · ${bln}`, t.bulan_ini, (c) => c.bulan_ini.omzet, pct, 'bln')
      + kartuOmzet('Laba bersih bulan ini', t.laba_bersih_bulan_ini, (c) => c.laba_bersih_bulan_ini, '', 'lb');
    h += `<div class="ow-sec">Status mesin <small>hanya tampilan</small></div>`;
    // Perubahan #56: kartu mesin = ikon 3D berwarna (status) + kode singkat (D1) + cycle. Tanpa teks status & waktu.
    const IK = window.IK3D;
    let kol = 4;
    const kartuM = (m) => `<div class="mz-card"><div class="mz-ico ${IK.kelasMesin(m.status)}"><i class="fas ${m.tipe === 'dryer' ? 'fa-wind' : 'fa-soap'}"></i></div>
      <div class="mz-kode">${esc(IK.kodeMesin(m.kode))}</div><div class="mz-sub">${Number(m.total_cycle || 0).toLocaleString('id-ID')} cy</div></div>`;
    const baris = (list) => (list.length ? `<div class="mz-grid ow-mzg" style="--mz-kol:${kol}">${list.map(kartuM).join('')}</div>` : '');
    d.cabang.forEach((c) => {
      const dr = c.mesin.filter((m) => m.tipe === 'dryer'); const wa = c.mesin.filter((m) => m.tipe === 'washer');
      kol = Math.max(dr.length, wa.length, 1); // 1 baris per jenis
      h += `<div class="ow-mz"><div class="n">${esc(c.kode)} · ${esc(c.nama)}</div>${baris(dr)}${baris(wa)}${!dr.length && !wa.length ? '<div class="ow-hint">Belum ada mesin</div>' : ''}</div>`;
    });
    h += `<div class="ow-leg"><span><i class="fas fa-circle" style="color:#22c55e"></i>Kosong</span><span><i class="fas fa-circle" style="color:#f59e0b"></i>Teralokasi</span><span><i class="fas fa-circle" style="color:#ef4444"></i>Jalan</span><span><i class="fas fa-circle" style="color:#94a3b8"></i>Maintenance</span></div>`;
    $('odash-body').innerHTML = h;
  }

  /* ================= CABANG & USER ================= */
  O.loadCabang = async function () {
    const body = $('ocabang-body'); if (!body) return;
    body.innerHTML = spinner();
    try {
      const [c, u, iv] = await Promise.all([api('/owner/cabang'), api('/owner/user'), api('/owner/investasi').catch(() => null)]);
      O.cabang = c.data || []; O.users = u.data || []; O.inv = iv && iv.data;
      renderCabang();
    } catch (e) { body.innerHTML = emptyState('Gagal memuat. ' + e.message, 'fa-triangle-exclamation'); }
  };
  O.tab = function (t) { O.tabCabang = t; renderCabang(); };
  function renderCabang() {
    let h = `<div class="ow-tabs"><button class="${O.tabCabang === 'cabang' ? 'on' : ''}" onclick="OWNER.tab('cabang')">Cabang (${O.cabang.length})</button>
      <button class="${O.tabCabang === 'user' ? 'on' : ''}" onclick="OWNER.tab('user')">User (${(O.users || []).length})</button></div>`;
    if (O.tabCabang === 'cabang') {
      h += tabelInvestasi(O.inv);
      h += O.cabang.map((c) => `<div class="ow-cc" onclick="OWNER.editCabang(${c.id})"><b>${esc(c.kode)} · ${esc(c.nama)}</b>
        <small>${esc([c.alamat, c.kota].filter(Boolean).join(' · ') || '-')}${c.no_hp ? ' · ' + esc(c.no_hp) : ''}</small>
        ${c.status !== 'aktif' ? '<span class="ow-tg off">Tutup</span>' : ''}
        <span class="ow-tg">${Number(c.absensi_aktif) ? `Absensi aktif · ${c.radius_absen_m} m` : 'Absensi mati'}</span>
        ${c.target_omzet_bulanan ? `<span class="ow-tg">Target ${rp(c.target_omzet_bulanan)}</span>` : ''}
        <span class="ow-tg k"><i class="fas fa-lock"></i> Antrian ${esc(c.pemilihan_mesin || '-')}</span>
        <div class="ow-mb">${metodeTags(c)}</div></div>`).join('');
      h += `<div class="ow-hint">Tambah cabang baru: ditunda (butuh layanan, harga, mesin & keranjang).</div>`;
    } else {
      const f = O.filterUser;
      h += `<div class="ow-chips"><button class="${f === 'semua' ? 'on' : ''}" onclick="OWNER.filterU('semua')">Semua cabang</button>
        ${O.cabang.map((c) => `<button class="${Number(f) === Number(c.id) ? 'on' : ''}" onclick="OWNER.filterU(${c.id})">${esc(c.kode)}</button>`).join('')}
        <button onclick="OWNER.userBaru()"><i class="fas fa-user-plus"></i> User baru</button></div>`;
      const list = (O.users || []).filter((u) => f === 'semua' || Number(u.cabang_id) === Number(f));
      h += list.length ? list.map((u) => `<div class="ow-us ${u.status === 'nonaktif' ? 'off' : ''}" onclick="OWNER.editUser(${u.id})">
          <div class="ow-av">${esc((u.nama || '?').trim().slice(0, 1).toUpperCase())}</div>
          <div style="min-width:0;"><b>${esc(u.nama)}</b><small>${esc(u.cabang_kode)} · @${esc(u.username)}${u.status === 'nonaktif' ? ' · nonaktif' : ''}${u.role === 'kasir' ? ` · jatah ${Number(u.jatah_cuci_mingguan) > 0 ? rp(u.jatah_cuci_mingguan) + '/mgg' : '—'}` : ''}</small></div>
          <span class="ow-rl ${u.role}">${ROLE_LABEL_O[u.role] || esc(u.role)}</span></div>`).join('') : emptyState('Belum ada user', 'fa-users');
    }
    $('ocabang-body').innerHTML = h;
  }
  O.filterU = function (f) { O.filterUser = f; renderCabang(); };

  /* Perubahan #55 -- ringkasan pengembalian modal & benefit investor per cabang */
  const pct = (n) => (n == null ? '–' : Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + '%');
  // ringkas: 291.481.980 -> "291,48 jt" supaya tabel muat di layar HP
  const jt = (n) => { if (n == null) return '–'; const v = Number(n) || 0; if (Math.abs(v) < 1e6) return Math.round(v).toLocaleString('id-ID');
    return (v / 1e6).toLocaleString('id-ID', { minimumFractionDigits: v % 1e6 ? 2 : 0, maximumFractionDigits: 2 }) + ' jt'; };
  const rpx = jt;
  const blnTxt = (n) => (n == null ? '–' : n === 0 ? 'Lunas' : `±${n} bln`);
  function tabelInvestasi(iv) {
    if (!iv || !iv.cabang || !iv.cabang.length) return '';
    const list = iv.cabang.filter((x) => x.modal != null || x.pengembalian.total || x.investor.total || x.operator.total);
    if (!list.length) return '';
    const T = iv.total; const multi = list.length > 1;
    const kol = list.map((x) => `<th>${esc(x.kode)}</th>`).join('') + (multi ? '<th>Total</th>' : '');
    const brs = (lbl, f, ft, cls = '') => `<tr class="${cls}"><td>${lbl}</td>${list.map((x) => `<td>${f(x)}</td>`).join('')}${multi ? `<td>${ft}</td>` : ''}</tr>`;
    const bar = (x) => { const p = Math.max(0, Math.min(100, Number(x.pengembalian.persen) || 0)); return `<div class="ow-bar"><i style="width:${p}%"></i></div>`; };
    return `<div class="ow-iv">
      <div class="ow-sec" style="margin-top:0;">Investasi & benefit <small>Rupiah · jt = juta</small></div>
      <div class="ow-ivw"><table class="ow-ivt">
        <thead><tr><th></th>${kol}</tr></thead>
        <tbody>
          ${brs('Modal investasi', (x) => rpx(x.modal), rpx(T.modal), 'b')}
          <tr class="h"><td colspan="${list.length + (multi ? 2 : 1)}"><i class="fas fa-rotate-left"></i> Pengembalian modal (2-201)</td></tr>
          ${brs('Sudah kembali', (x) => jt(x.pengembalian.total) + bar(x), jt(T.kembali))}
          ${brs('Kurang', (x) => `<span class="m">${rpx(x.pengembalian.kurang)}</span>`, `<span class="m">${jt(T.kurang)}</span>`)}
          ${brs('% kembali', (x) => pct(x.pengembalian.persen), pct(T.persen))}
          ${brs('Perkiraan lunas', (x) => blnTxt(x.pengembalian.perkiraan_bulan_lunas), blnTxt(T.perkiraan_bulan_lunas))}
          <tr class="h"><td colspan="${list.length + (multi ? 2 : 1)}"><i class="fas fa-hand-holding-dollar"></i> Benefit investor (2-202)</td></tr>
          ${brs('Total', (x) => jt(x.investor.total), jt(T.investor))}
          ${brs('Rata² 3 bln', (x) => jt(x.investor.rata3), jt(T.investor_rata3))}
          ${brs('% / bulan', (x) => `<span class="g">${pct(x.investor.persen_bulan)}</span>`, `<span class="g">${pct(T.persen_bulan)}</span>`)}
          ${brs('% / tahun <small>forecast</small>', (x) => `<span class="g">${pct(x.investor.persen_tahun)}</span>`, `<span class="g">${pct(T.persen_tahun)}</span>`)}
          <tr class="h"><td colspan="${list.length + (multi ? 2 : 1)}"><i class="fas fa-user-gear"></i> Share profit operator (2-203)</td></tr>
          ${brs('Total', (x) => jt(x.operator.total), jt(T.operator))}
        </tbody></table></div>
      <div class="ow-hint">Rata-rata = 3 bulan terakhir yang ada pembagian. % / tahun = % / bulan × 12. Perkiraan lunas = kurang ÷ rata-rata pengembalian 3 bulan terakhir. Modal diubah lewat Edit cabang.</div>
    </div>`;
  }

  /* Perubahan #83: saklar 4 cara bayar per cabang */
  const MB = [
    { k: 'cash', kol: 'bayar_cash_aktif', label: 'Cash', ico: 'fa-money-bill-wave', ket: 'Bayar tunai di kasir' },
    { k: 'qris', kol: 'bayar_qris_aktif', label: 'QRIS', ico: 'fa-qrcode', ket: 'QRIS statis toko, dikonfirmasi kasir' },
    { k: 'kiosk', kol: 'winpay_aktif', label: 'Kios-K', ico: 'fa-tablet-screen-button', ket: 'QR Winpay di tablet, lunas otomatis' },
    { k: 'poin', kol: 'tukar_poin_aktif', label: 'Poin', ico: 'fa-star', ket: 'Tukar poin (perolehan poin tetap jalan)' },
  ];
  const mbOn = (c, m) => (c[m.kol] === undefined || c[m.kol] === null ? m.k !== 'kiosk' : !!Number(c[m.kol]));
  function metodeTags(c) {
    return MB.map((m) => `<span class="ow-tg ${mbOn(c, m) ? 'mb-on' : 'mb-off'}"><i class="fas ${m.ico}"></i> ${m.label}</span>`).join('');
  }
  function metodeSwitches(c) {
    return `<div class="ow-sec">Metode bayar <small>langsung tersimpan</small></div>
      <div class="ow-mbl">${MB.map((m) => `<label class="ow-mbr">
        <span class="ow-mbi mb-${m.k}"><i class="fas ${m.ico}"></i></span>
        <span class="ow-mbt"><b>${m.label}</b><small>${m.ket}${m.k === 'kiosk' && c.mdr_winpay_persen != null ? ` · potongan ${String(Number(c.mdr_winpay_persen)).replace('.', ',')}%` : ''}</small></span>
        <input type="checkbox" class="ow-sw" ${mbOn(c, m) ? 'checked' : ''} onchange="OWNER.setMetode(${c.id}, '${m.k}', this)">
      </label>`).join('')}</div>
      <div class="ow-hint">Minimal 1 dari Cash / QRIS / Kios-K harus aktif. Pesanan yang sudah dibuat tidak berubah.</div>`;
  }
  O.setMetode = async function (id, k, el) {
    const on = el.checked; el.disabled = true;
    try {
      const r = await api(`/owner/cabang/${id}/metode-bayar`, { method: 'PUT', body: { [k]: on ? 1 : 0 } });
      const c = O.cabang.find((x) => Number(x.id) === Number(id));
      if (c && r.data) { c.bayar_cash_aktif = r.data.cash ? 1 : 0; c.bayar_qris_aktif = r.data.qris ? 1 : 0; c.winpay_aktif = r.data.kiosk ? 1 : 0; c.tukar_poin_aktif = r.data.poin ? 1 : 0; }
      toast(`${(MB.find((m) => m.k === k) || {}).label} ${on ? 'diaktifkan' : 'dinonaktifkan'}`, 'success');
      renderCabang();
    } catch (e) { el.checked = !on; toast(e.message || 'Gagal', 'danger'); }
    el.disabled = false;
  };

  const fld = (id, label, val, extra = '') => `<div class="field"><label>${label}</label><input type="text" id="${id}" value="${esc(val == null ? '' : val)}" ${extra}></div>`;
  const opsiCabang = (sel) => O.cabang.map((c) => `<option value="${c.id}" ${Number(sel) === Number(c.id) ? 'selected' : ''}>${esc(c.kode)} · ${esc(c.nama)}</option>`).join('');
  const opsiRole = (sel) => Object.keys(ROLE_LABEL_O).map((r) => `<option value="${r}" ${sel === r ? 'selected' : ''}>${ROLE_LABEL_O[r]}</option>`).join('');

  O.editCabang = function (id) {
    const c = O.cabang.find((x) => Number(x.id) === Number(id)); if (!c) return;
    openSheet(`<h3><i class="fas fa-store"></i> ${esc(c.kode)}</h3>
      ${fld('oc-nama', 'Nama', c.nama)}
      <div class="ow-g2">${fld('oc-hp', 'No HP', c.no_hp)}${fld('oc-wa', 'Link WA', c.link_wa)}</div>
      ${fld('oc-alamat', 'Alamat', c.alamat)}
      <div class="ow-g2">${fld('oc-kota', 'Kota', c.kota)}${fld('oc-prov', 'Provinsi', c.provinsi)}
        ${fld('oc-target', 'Target omzet / bulan (Rp)', c.target_omzet_bulanan != null ? Math.round(c.target_omzet_bulanan) : '', 'inputmode="numeric"')}
        ${fld('oc-modal', 'Modal investasi (Rp)', c.modal_investasi != null ? Math.round(c.modal_investasi) : '', 'inputmode="numeric"')}
        ${fld('oc-poin', 'Nilai 1 poin (Rp)', c.nilai_per_poin != null ? Number(c.nilai_per_poin) : '', 'inputmode="decimal"')}
        ${fld('oc-lat', 'Latitude', c.latitude, 'inputmode="decimal"')}${fld('oc-lng', 'Longitude', c.longitude, 'inputmode="decimal"')}
        ${fld('oc-radius', 'Radius absen (m)', c.radius_absen_m, 'inputmode="numeric"')}
        <div class="field"><label>Absensi</label><select id="oc-absen"><option value="1" ${Number(c.absensi_aktif) ? 'selected' : ''}>Aktif</option><option value="0" ${Number(c.absensi_aktif) ? '' : 'selected'}>Mati</option></select></div></div>
      ${fld('oc-gmap', 'Link review Google', c.link_gmap_review)}
      <div class="ow-g2">${fld('oc-ig', 'Instagram', c.link_ig)}${fld('oc-fb', 'Facebook', c.link_fb)}</div>
      ${fld('oc-tt', 'TikTok', c.link_tiktok)}
      <div class="field"><label>Status cabang</label><select id="oc-status"><option value="aktif" ${c.status === 'aktif' ? 'selected' : ''}>Buka</option><option value="nonaktif" ${c.status !== 'aktif' ? 'selected' : ''}>Tutup</option></select></div>
      ${metodeSwitches(c)}
      <div class="ow-g2">${fld('oc-mdr', 'Potongan Winpay / Kios-K (%)', c.mdr_winpay_persen != null ? String(Number(c.mdr_winpay_persen)).replace('.', ',') : '', 'inputmode="decimal" placeholder="0,35"')}</div>
      <div class="ow-g2 ow-lock">${fld('', '<i class="fas fa-lock"></i> Mode antrian mesin', c.pemilihan_mesin, 'disabled')}</div>
      <div class="ow-hint">Mode antrian mesin dikunci (parameter produksi).</div>
      <div class="ow-b2"><button class="btn-zl btn-light-zl" onclick="closeSheet()">Batal</button><button class="btn-zl btn-primary-zl" id="btn-oc" onclick="OWNER.simpanCabang(${c.id})"><i class="fas fa-check"></i> Simpan</button></div>`);
  };
  O.simpanCabang = async function (id) {
    const v = (x) => ($(x) ? $(x).value.trim() : undefined);
    const btn = $('btn-oc'); btnLoad(btn, true);
    try {
      await api(`/owner/cabang/${id}`, { method: 'PUT', body: {
        nama: v('oc-nama'), no_hp: v('oc-hp'), link_wa: v('oc-wa'), alamat: v('oc-alamat'), kota: v('oc-kota'), provinsi: v('oc-prov'),
        target_omzet_bulanan: (v('oc-target') || '').replace(/[^\d]/g, ''), modal_investasi: (v('oc-modal') || '').replace(/[^\d]/g, ''), nilai_per_poin: v('oc-poin'),
        latitude: v('oc-lat'), longitude: v('oc-lng'), radius_absen_m: v('oc-radius'), absensi_aktif: v('oc-absen'),
        link_gmap_review: v('oc-gmap'), link_ig: v('oc-ig'), link_fb: v('oc-fb'), link_tiktok: v('oc-tt'), status: v('oc-status'),
        mdr_winpay_persen: v('oc-mdr'),
      } });
      closeSheet(); toast('Cabang disimpan', 'success'); O.loadCabang();
    } catch (e) { toast(e.message || 'Gagal menyimpan', 'danger'); btnLoad(btn, false); }
  };

  function formUser(u) {
    const baru = !u; u = u || { role: 'kasir', cabang_id: (O.cabang[0] || {}).id, jatah_cuci_mingguan: 20000, status: 'aktif' };
    return `${fld('ou-nama', 'Nama', u.nama)}
      ${baru ? `<div class="ow-g2">${fld('ou-username', 'Username', '', 'autocapitalize="off" placeholder="huruf kecil"')}${fld('ou-pass', 'Password', '', 'placeholder="min. 6 karakter"')}</div>` : ''}
      <div class="ow-g2">
        <div class="field"><label>Role</label><select id="ou-role" onchange="document.getElementById('ou-jatah-w').style.display=this.value==='kasir'?'':'none'">${opsiRole(u.role)}</select></div>
        <div class="field"><label>Cabang</label><select id="ou-cabang">${opsiCabang(u.cabang_id)}</select></div>
        ${fld('ou-hp', 'No HP', u.telepon, 'inputmode="tel" placeholder="08xxxxxxxxxx"')}
        <div id="ou-jatah-w" style="${u.role === 'kasir' ? '' : 'display:none'}">${fld('ou-jatah', '<i class="fas fa-crown"></i> Jatah cuci / minggu (Rp)', Number(u.jatah_cuci_mingguan) || 0, 'inputmode="numeric"')}</div>
      </div>
      <div class="ow-hint">Jatah cuci hanya bisa diubah owner (0 = tidak dapat). Manager hanya melihat.</div>
      ${baru ? '' : `<div class="field"><label>Status</label><select id="ou-status"><option value="aktif" ${u.status === 'aktif' ? 'selected' : ''}>Aktif</option><option value="nonaktif" ${u.status !== 'aktif' ? 'selected' : ''}>Nonaktif</option></select></div>`}`;
  }
  O.userBaru = function () {
    openSheet(`<h3><i class="fas fa-user-plus"></i> User baru</h3>${formUser(null)}
      <div class="ow-b2"><button class="btn-zl btn-light-zl" onclick="closeSheet()">Batal</button><button class="btn-zl btn-primary-zl" id="btn-ou" onclick="OWNER.simpanUser(0)"><i class="fas fa-check"></i> Simpan</button></div>`);
  };
  O.editUser = function (id) {
    const u = (O.users || []).find((x) => Number(x.id) === Number(id)); if (!u) return;
    openSheet(`<h3><i class="fas fa-pen"></i> ${esc(u.nama)}</h3><div class="ow-hint">@${esc(u.username)}</div>${formUser(u)}
      <div class="ow-b2"><button class="btn-zl btn-light-zl" onclick="OWNER.resetPass(${u.id})"><i class="fas fa-key"></i> Reset password</button><button class="btn-zl btn-danger-zl" onclick="OWNER.hapusUser(${u.id})"><i class="fas fa-trash"></i> Hapus</button></div>
      <div class="ow-hint" style="margin-top:6px;">Hapus: kalau user sudah punya riwayat transaksi / kas / absensi → otomatis dinonaktifkan.</div>
      <div class="ow-b2"><button class="btn-zl btn-light-zl" onclick="closeSheet()">Batal</button><button class="btn-zl btn-primary-zl" id="btn-ou" onclick="OWNER.simpanUser(${u.id})"><i class="fas fa-check"></i> Simpan</button></div>`);
  };
  O.simpanUser = async function (id) {
    const v = (x) => ($(x) ? $(x).value.trim() : undefined);
    const body = { nama: v('ou-nama'), role: v('ou-role'), cabang_id: v('ou-cabang'), telepon: v('ou-hp') };
    if (body.role === 'kasir') body.jatah_cuci_mingguan = (v('ou-jatah') || '0').replace(/[^\d]/g, '') || 0;
    if (!id) { body.username = v('ou-username'); body.password = $('ou-pass') ? $('ou-pass').value : ''; }
    else body.status = v('ou-status');
    const btn = $('btn-ou'); btnLoad(btn, true);
    try {
      await api(id ? `/owner/user/${id}` : '/owner/user', { method: id ? 'PATCH' : 'POST', body });
      closeSheet(); toast(id ? 'User disimpan' : 'User ditambahkan', 'success'); O.tabCabang = 'user'; O.loadCabang();
    } catch (e) { toast(e.message || 'Gagal menyimpan', 'danger'); btnLoad(btn, false); }
  };
  O.resetPass = function (id) {
    const u = (O.users || []).find((x) => Number(x.id) === Number(id)); if (!u) return;
    openSheet(`<h3><i class="fas fa-key"></i> Reset password</h3><div class="ow-hint">${esc(u.nama)} · @${esc(u.username)}</div>
      ${fld('ou-np', 'Password baru', '', 'placeholder="min. 6 karakter"')}
      <div class="ow-b2"><button class="btn-zl btn-light-zl" onclick="OWNER.editUser(${id})">Batal</button><button class="btn-zl btn-primary-zl" id="btn-np" onclick="OWNER.simpanPass(${id})"><i class="fas fa-check"></i> Reset</button></div>`);
  };
  O.simpanPass = async function (id) {
    const btn = $('btn-np'); btnLoad(btn, true);
    try { await api(`/owner/user/${id}/reset-password`, { method: 'POST', body: { password: $('ou-np').value } }); closeSheet(); toast('Password direset', 'success'); }
    catch (e) { toast(e.message || 'Gagal', 'danger'); btnLoad(btn, false); }
  };
  O.hapusUser = async function (id) {
    const u = (O.users || []).find((x) => Number(x.id) === Number(id)); if (!u) return;
    if (!confirm(`Hapus ${u.nama}? Kalau sudah punya riwayat, user dinonaktifkan.`)) return;
    try {
      const r = (await api(`/owner/user/${id}`, { method: 'DELETE' })).data;
      closeSheet(); toast(r.hasil === 'dihapus' ? `${u.nama} dihapus` : `${u.nama} punya riwayat → dinonaktifkan`, 'success');
      O.tabCabang = 'user'; O.loadCabang();
    } catch (e) { toast(e.message || 'Gagal', 'danger'); }
  };

  /* ================= BUKU KAS ================= */
  O.loadKas = async function () {
    const body = $('obukukas-body'); if (!body) return;
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const ymd = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    O.kas.dari = O.kas.dari || `${ymd.slice(0, 7)}-01`; O.kas.sampai = O.kas.sampai || ymd;
    body.innerHTML = spinner();
    try {
      O.kas.data = (await api(`/owner/kas?dari=${O.kas.dari}&sampai=${O.kas.sampai}&cabang_ids=${idsPilihan().join(',')}`)).data;
      renderKas();
    } catch (e) { body.innerHTML = emptyState('Gagal memuat buku kas. ' + e.message, 'fa-triangle-exclamation'); }
  };
  O.setRange = function () { O.kas.dari = $('ok-dari').value || O.kas.dari; O.kas.sampai = $('ok-sampai').value || O.kas.sampai; O.loadKas(); };
  function k3(o, saldoLabel = 'Saldo') {
    return `<div class="ow-k3"><div>${saldoLabel}<b>${rp(o.saldo && o.saldo.total != null ? o.saldo.total : o.saldo)}</b></div><div class="m">Masuk<b>${rp(o.masuk)}</b></div><div class="kl">Keluar<b>${rp(o.keluar)}</b></div></div>`;
  }
  function renderKas() {
    const d = O.kas.data;
    let h = chipsCabang('kas');
    h += `<div class="ow-rng"><input type="date" id="ok-dari" value="${d.dari}" onchange="OWNER.setRange()"><span>–</span><input type="date" id="ok-sampai" value="${d.sampai}" onchange="OWNER.setRange()">
      <button class="btn-zl btn-light-zl" style="flex:0 0 auto;width:auto;padding:8px 12px;" onclick="OWNER.excelKas()"><i class="fas fa-file-excel"></i> Excel</button></div>`;
    if (!d.cabang.length) { $('obukukas-body').innerHTML = h + emptyState('Tidak ada cabang dipilih', 'fa-store'); return; }
    if (d.cabang.length > 1 && d.total) {
      h += `<div class="ow-kas"><div class="h"><span><i class="fas fa-layer-group"></i> Gabungan ${d.cabang.length} cabang</span></div>
        <div style="font-size:11px;font-weight:700;margin:2px 0 4px;">Kas Besar</div>${k3(d.total.kas_besar, 'Saldo s/d akhir')}
        <div style="font-size:11px;font-weight:700;margin:8px 0 4px;">Kas Kecil</div>${k3(d.total.kas_kecil, 'Saldo sekarang')}</div>`;
    }
    d.cabang.forEach((c) => {
      const rinci = (rows) => rows.map((r) => `<div class="ow-rc"><span>${r.jenis === 'masuk' ? '+' : '−'} ${esc(r.label)}</span><b>${rp(r.nominal)}</b></div>`).join('');
      h += `<div class="ow-kas"><div class="h"><span>${esc(c.kode)} · ${esc(c.nama)}</span></div>
        <div style="font-size:11px;font-weight:700;margin:2px 0 4px;">Kas Besar</div>${k3(c.kas_besar, 'Saldo s/d akhir')}${rinci(c.kas_besar.rinci)}
        <div style="font-size:11px;font-weight:700;margin:8px 0 4px;">Kas Kecil <span style="font-weight:500;color:#64748b;">· cash ${rp(c.kas_kecil.saldo.cash)} · gopay ${rp(c.kas_kecil.saldo.gopay)}</span></div>${k3(c.kas_kecil, 'Saldo sekarang')}${rinci(c.kas_kecil.rinci)}</div>`;
    });
    h += `<div class="ow-sec">Mutasi Kas Besar <small>${d.mutasi_besar.length} baris${d.mutasi_besar.length >= 500 ? ' (maks 500)' : ''}</small></div><div class="ow-kas">`;
    h += d.mutasi_besar.length ? d.mutasi_besar.map((m) => `<div class="ow-mut"><span>${esc(String(m.tanggal).slice(8, 10) + '/' + String(m.tanggal).slice(5, 7))} · ${esc(m.cabang_kode || '')} · ${esc(m.sumber_label)}<small>${esc(m.keterangan || m.coa_nama || '')}</small></span>
      <span class="${m.jenis === 'masuk' ? 'm' : 'kl'}">${m.jenis === 'masuk' ? '+' : '−'}${rp(m.nominal)}</span></div>`).join('') : '<div class="ow-hint">Tidak ada mutasi di rentang ini.</div>';
    h += '</div>';
    $('obukukas-body').innerHTML = h;
  }
  O.excelKas = function () {
    const d = O.kas.data; if (!d || typeof XLSX === 'undefined') { toast('Excel belum siap', 'warning'); return; }
    const ring = [['Cabang', 'Kas', 'Saldo', 'Masuk', 'Keluar']];
    d.cabang.forEach((c) => {
      ring.push([c.kode, 'Kas Besar', c.kas_besar.saldo, c.kas_besar.masuk, c.kas_besar.keluar]);
      ring.push([c.kode, 'Kas Kecil', c.kas_kecil.saldo.total, c.kas_kecil.masuk, c.kas_kecil.keluar]);
    });
    const rinci = [['Cabang', 'Kas', 'Jenis', 'Keterangan', 'Nominal']];
    d.cabang.forEach((c) => {
      c.kas_besar.rinci.forEach((r) => rinci.push([c.kode, 'Kas Besar', r.jenis, r.label, r.nominal]));
      c.kas_kecil.rinci.forEach((r) => rinci.push([c.kode, 'Kas Kecil', r.jenis, r.label, r.nominal]));
    });
    const mut = [['Tanggal', 'Cabang', 'Jenis', 'Sumber', 'Akun', 'Keterangan', 'Nominal']];
    d.mutasi_besar.forEach((m) => mut.push([m.tanggal, m.cabang_kode, m.jenis, m.sumber_label, `${m.coa_kode || ''} ${m.coa_nama || ''}`.trim(), m.keterangan || '', m.nominal]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ring), 'Ringkasan');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rinci), 'Rincian');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mut), 'Mutasi Kas Besar');
    XLSX.writeFile(wb, `Buku_Kas_${d.dari}_${d.sampai}.xlsx`);
  };

  window.OWNER = O;
})();
