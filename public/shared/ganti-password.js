/* ============================================================
   Perubahan #82 — Ganti password mandiri (kasir / manager / owner)
   Dipakai app kasir, manager & owner (butuh global: openSheet, closeSheet,
   api, toast, btnLoad, esc, S, saveSession, $).
   Setelah berhasil: perangkat ini dapat token baru, perangkat lain wajib
   login ulang (server menolak token lama).
   ============================================================ */
(function () {
  const st = document.createElement('style');
  st.textContent = `
.gp-btn { margin-bottom: 10px; background: var(--tk3-bg, #fff); color: var(--tk3-ink, var(--text)); border: 1px solid var(--border, #e5e7eb) !important; }
.gp-wrap { position: relative; }
.gp-wrap input { padding-right: 44px !important; }
.gp-eye { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: none; background: none; color: var(--text-muted, #6b7280); font-size: 15px; padding: 8px; cursor: pointer; }
.gp-info { font-size: 11px; color: var(--text-muted, #6b7280); background: rgba(99,102,241,.08); border-radius: 10px; padding: 9px 11px; margin-bottom: 14px; line-height: 1.45; }
.gp-err { font-size: 12px; color: var(--danger, #dc2626); margin: -6px 0 12px; min-height: 0; }`;
  document.head.appendChild(st);

  function kolom(id, label, ph, ac) {
    return `<div class="field"><label>${label}</label><div class="gp-wrap">
      <input type="password" id="${id}" placeholder="${ph}" autocomplete="${ac}" oninput="GantiPassword.cek()">
      <button type="button" class="gp-eye" onclick="GantiPassword.lihat('${id}', this)" aria-label="Lihat"><i class="fas fa-eye"></i></button>
    </div></div>`;
  }

  function buka() {
    const u = (typeof S !== 'undefined' && S && S.user) || {};
    openSheet(`
      <h3><i class="fas fa-key"></i> Ganti Password</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${esc(u.nama || '-')} · @${esc(u.username || '-')}</div>
      ${kolom('gp-lama', 'Password lama', 'password sekarang', 'current-password')}
      ${kolom('gp-baru', 'Password baru', 'minimal 6 karakter', 'new-password')}
      ${kolom('gp-ulang', 'Ulangi password baru', 'ketik ulang password baru', 'new-password')}
      <div class="gp-err" id="gp-err"></div>
      <div class="gp-info"><i class="fas fa-circle-info"></i> Setelah diganti, login di HP / perangkat lain otomatis keluar dan harus login ulang dengan password baru. Perangkat ini tetap masuk.</div>
      <button class="btn-zl btn-primary-zl" id="btn-gp" onclick="GantiPassword.simpan()"><i class="fas fa-check"></i> Simpan Password</button>`);
    setTimeout(() => { const el = $('gp-lama'); if (el) el.focus(); }, 50);
  }

  function lihat(id, btn) {
    const el = $(id); if (!el) return;
    const tampil = el.type === 'password';
    el.type = tampil ? 'text' : 'password';
    btn.innerHTML = `<i class="fas fa-eye${tampil ? '-slash' : ''}"></i>`;
  }

  function salah() {
    const lama = ($('gp-lama') || {}).value || '';
    const baru = ($('gp-baru') || {}).value || '';
    const ulang = ($('gp-ulang') || {}).value || '';
    if (!lama) return 'Isi password lama';
    if (baru.length < 6) return 'Password baru minimal 6 karakter';
    if (baru === lama) return 'Password baru harus beda dengan password lama';
    if (ulang !== baru) return 'Ulangi password baru belum sama';
    return '';
  }

  function cek() {
    const box = $('gp-err'); if (!box) return;
    const baru = ($('gp-baru') || {}).value || '';
    const ulang = ($('gp-ulang') || {}).value || '';
    let m = '';
    if (baru && baru.length < 6) m = 'Password baru minimal 6 karakter';
    else if (ulang && ulang !== baru) m = 'Ulangi password baru belum sama';
    box.textContent = m;
  }

  async function simpan() {
    const m = salah();
    if (m) { $('gp-err').textContent = m; toast(m, 'warning'); return; }
    const btn = $('btn-gp'); btnLoad(btn, true);
    try {
      const res = await api('/auth/ganti-password', { method: 'POST', body: { password_lama: $('gp-lama').value, password_baru: $('gp-baru').value } });
      if (res && res.data && res.data.token) { S.token = res.data.token; saveSession(); }
      closeSheet(); toast('Password berhasil diganti', 'success');
    } catch (e) {
      $('gp-err').textContent = e.message || 'Gagal ganti password';
      toast(e.message || 'Gagal ganti password', 'danger');
      btnLoad(btn, false);
    }
  }

  window.GantiPassword = { buka, lihat, cek, simpan };
})();
