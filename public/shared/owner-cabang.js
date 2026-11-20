/* ============================================================
   Perubahan #47 -- owner memakai app manager / kasir di cabang pilihan.
   - Cabang pilihan disimpan di localStorage 'zl_owner_cabang' ({id,kode,nama}).
   - Semua request owner membawa header X-Cabang-Id (lihat middleware/auth.js).
   - Perubahan #77: tombol Ganti cabang & App owner di header (sejajar Refresh/Profil), badge role di bawah nama.
   ============================================================ */
(function () {
  const KEY = 'zl_owner_cabang';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function set(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* abaikan */ } }
  const isOwner = (u) => !!(u && u.role === 'owner');
  function headers(user) { const c = get(); return isOwner(user) && c && c.id ? { 'X-Cabang-Id': String(c.id) } : {}; }

  /**
   * Perubahan #77: TIDAK ada bar terpisah lagi. Owner: tombol "Ganti cabang" & "App owner"
   * ditaruh sejajar tombol Refresh & Profil di header dashboard. Semua role: badge role
   * di bawah nama (Kasir / Manager / Owner).
   */
  const ROLE = { kasir: ['fa-cash-register', 'Kasir'], manager: ['fa-user-tie', 'Manager'], owner: ['fa-crown', 'Owner'], operator: ['fa-user-gear', 'Operator'], kurir: ['fa-motorcycle', 'Kurir'] };
  function pasangRole(user) {
    const nama = document.getElementById('dash-nama'); if (!nama) return;
    let el = document.getElementById('dash-role');
    if (!user) { if (el) el.remove(); return; }
    const r = ROLE[user.role] || ['fa-user', user.role || ''];
    if (!el) { el = document.createElement('div'); el.id = 'dash-role'; nama.insertAdjacentElement('afterend', el); }
    el.className = 'ah-role' + (user.role === 'owner' ? ' ow' : '');
    el.innerHTML = `<i class="fas ${r[0]}"></i> ${esc(r[1])}`;
  }
  function terapkan(user, token, apiBase) {
    const barLama = document.getElementById('owner-bar'); if (barLama) barLama.remove();
    document.body.classList.remove('owner-bar-on');
    pasangRole(user);
    const lamaBtn = document.querySelectorAll('.ob-hbtn');
    if (!isOwner(user)) { lamaBtn.forEach((x) => x.remove()); return; }
    let c = get();
    if (!c || !c.id) { c = { id: user.cabang_id, kode: '', nama: user.cabang_nama || '' }; set(c); }
    user.cabang_id = c.id; if (c.nama) user.cabang_nama = c.nama;
    // tombol di header dashboard (kotak sama dengan Refresh / Profil)
    const nama = document.getElementById('dash-nama');
    const top = nama && nama.closest('.ah-top');
    const wadah = top && top.lastElementChild;
    if (wadah && !wadah.querySelector('.ob-hbtn')) {
      wadah.insertAdjacentHTML('afterbegin',
        `<div class="ah-avatar ob-hbtn" id="ob-ganti" title="Ganti cabang" aria-label="Ganti cabang"><i class="fas fa-store"></i></div>
         <a class="ah-avatar ob-hbtn" href="../owner/" title="App owner" aria-label="App owner"><i class="fas fa-house"></i></a>`);
    }
    const g = document.getElementById('ob-ganti'); if (g) g.onclick = () => pilih(token, apiBase);
    // chip cabang: "ZL02 · Nama"
    setTimeout(() => { const o = document.getElementById('dash-outlet'); if (o && c.kode) o.textContent = `${c.kode} · ${c.nama || user.cabang_nama || ''}`; }, 0);
  }

  /** Sheet sederhana pilih cabang -> simpan -> muat ulang app. */
  async function pilih(token, apiBase, { judul = 'Pilih cabang', tujuan = null } = {}) {
    let list = [];
    try {
      const r = await fetch(apiBase + '/master/cabang', { headers: { Authorization: 'Bearer ' + token } });
      list = ((await r.json()).data || []).filter((x) => x.status !== 'nonaktif');
    } catch (e) { alert('Gagal memuat cabang'); return; }
    const c = get() || {};
    const bg = document.createElement('div');
    bg.className = 'ob-sheet-bg';
    bg.innerHTML = `<div class="ob-sheet"><div class="ob-t">${esc(judul)}</div>
      ${list.map((x) => `<button type="button" class="ob-c ${Number(c.id) === Number(x.id) ? 'on' : ''}" data-id="${x.id}">
        <b>${esc(x.kode)}</b><span>${esc(x.nama)}</span>${Number(c.id) === Number(x.id) ? '<i class="fas fa-check"></i>' : ''}</button>`).join('')}
      <button type="button" class="ob-x">Batal</button></div>`;
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('.ob-x')) { bg.remove(); return; }
      const b = e.target.closest('.ob-c'); if (!b) return;
      const x = list.find((y) => Number(y.id) === Number(b.dataset.id));
      set({ id: x.id, kode: x.kode, nama: x.nama });
      if (tujuan) window.location.href = tujuan; else window.location.reload();
    });
    document.body.appendChild(bg);
  }

  window.OwnerCabang = { KEY, get, set, headers, terapkan, pilih, isOwner };
})();
