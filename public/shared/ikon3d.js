/* ============================================================
   Perubahan #35 -- kartu ikon 3D bersama (customer › Pesan & kasir › Pesankan)
   Hanya helper tampilan; state & aksi tetap di app masing-masing.
   ============================================================ */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const IKON_LAYANAN = {
    cuci: ['g-cuci', 'fa-soap'], kering: ['g-kering', 'fa-wind'], lipat: ['g-lipat', 'fa-shirt'],
    setrika_lipat: ['g-setrika', 'fa-fire'], antar: ['g-antar', 'fa-truck-fast'], antar_jemput: ['g-aj', 'fa-route'], jemput: ['g-aj', 'fa-truck-ramp-box'],
    drop_off: ['g-drop', 'fa-people-carry-box'],
  };
  // ikon otomatis dari nama barang (dipakai kalau belum ada foto)
  const IKON_BARANG = [
    [/deterjen|detergen|detergent|sabun|rinso|attack|so\s*klin|daia/i, 'g-sabun', 'fa-pump-soap'],
    [/pewangi|softener|molto|parfum|wangi|downy/i, 'g-wangi', 'fa-spray-can-sparkles'],
    [/pemutih|bayclin|vanish|noda/i, 'g-aj', 'fa-flask'],
    [/plastik|kantong|kresek|tas/i, 'g-drop', 'fa-bag-shopping'],
    [/hanger|gantungan/i, 'g-lipat', 'fa-shirt'],
    [/kopi|coffee|latte|cappu|espresso|americano|mocha|golda|good\s*day/i, 'g-kopi', 'fa-mug-saucer'],
    [/milk|susu|yakult|cimory|yogurt|yoghurt|ultra/i, 'g-lipat', 'fa-bottle-droplet'],
    [/\bteh\b|tea|pucuk|nutrisari|jasmine|jsmn|sosro/i, 'g-teh', 'fa-glass-water'],
    [/pop\s*mie|indomie|\bmie\b|nasi|bakso|soto|makan|sosis|nugget/i, 'g-mie', 'fa-bowl-food'],
    [/roti|bakery|toast|bread/i, 'g-teh', 'fa-bread-slice'],
    [/jelly|inaco|es\s*krim|ice\s*cream/i, 'g-drop', 'fa-ice-cream'],
    [/wafer|biskuit|biscuit|oreo|ritz|good\s*time|cookie|tango|tanggo|kugi|crispy|crcr|roll/i, 'g-kering', 'fa-cookie-bite'],
    [/chitato|chiki|cha-?cha|walut|keripik|kripik|snack|kacang|peanut|permen|candy/i, 'g-setrika', 'fa-cookie'],
    [/air|mineral|aqua|crystalin|pocari|isoplus|lasegar|aspen|florida|orange|jus|juice|soda|cola|sprite|fanta|drink|minum/i, 'g-air', 'fa-bottle-water'],
    [/rokok|sampoerna|gudang|surya|djarum/i, 'g-berat', 'fa-smoking'],
  ];
  function ikonLayanan(kat) { const x = IKON_LAYANAN[kat] || ['g-berat', 'fa-circle']; return { g: x[0], ico: x[1] }; }
  function ikonBarang(b) {
    for (const [re, g, ico] of IKON_BARANG) if (re.test(b.nama || '')) return { g, ico };
    if (b.kategori === 'cafe') return /\d+\s*ml/i.test(b.nama || '') ? { g: 'g-air', ico: 'fa-bottle-water' } : { g: 'g-kering', ico: 'fa-cookie-bite' };
    return { g: 'g-sabun', ico: 'fa-box' };
  }
  function fotoUrl(apiBase, b) { return b && b.foto_v ? `${apiBase}/customer/barang-foto/${b.id}?v=${b.foto_v}` : null; }

  /** Kartu. o: {sel, g, ico, foto, nama, desc, harga, badge, extra, onclick, dis, cam} */
  function tile(o) {
    const visual = o.foto
      ? `<div class="ik-foto${o.zoom ? ' zm' : ''}" ${o.zoom ? `onclick="event.stopPropagation();${o.zoom}"` : ''}><img src="${esc(o.foto)}" alt="" loading="lazy">${o.zoom ? '<span class="ik-zm"><i class="fas fa-magnifying-glass-plus"></i></span>' : ''}</div>`
      : `<div class="ik-ico ${o.g}"><i class="fas ${o.ico}"></i>${o.badge ? `<span class="ik-badge">${esc(o.badge)}</span>` : ''}</div>`;
    return `<div class="ik-tile ${o.sel ? 'sel' : ''} ${o.dis ? 'dis' : ''}" ${o.onclick ? `onclick="${o.onclick}"` : ''}>
      ${o.sel ? '<span class="ik-ok"><i class="fas fa-check"></i></span>' : ''}
      ${o.cam ? `<span class="ik-cam" title="Ganti foto" onclick="event.stopPropagation();${o.cam}"><i class="fas fa-camera"></i></span>` : ''}
      ${visual}
      <div class="ik-name">${esc(o.nama)}</div>${o.desc ? `<div class="ik-desc">${o.desc}</div>` : ''}${o.harga ? `<div class="ik-price">${o.harga}</div>` : ''}${o.extra || ''}
    </div>`;
  }
  /** Stepper −/+ (klik tidak ikut memilih kartu). */
  function qty(n, minus, plus, maxReached) {
    return `<div class="ik-qty" onclick="event.stopPropagation()"><button onclick="${minus}" ${n <= 0 ? 'disabled' : ''}>−</button><b>${n}</b><button onclick="${plus}" ${maxReached ? 'disabled' : ''}>+</button></div>`;
  }
  function sec(ico, judul, open, ring, onclick) {
    return `<div class="ik-sec section-label" onclick="${onclick}"><span><i class="fas ${ico}"></i> ${judul}${ring ? ` <small>(${esc(ring)})</small>` : ''}</span><i class="fas fa-chevron-${open ? 'up' : 'down'}"></i></div>`;
  }

  /* ---- berat desimal: terima koma atau titik ---- */
  function parseBerat(v) {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    if (!s) return NaN;
    if (!/^\d*\.?\d*$/.test(s)) return NaN;
    return Number(s);
  }
  function rapikanBerat(n) { return Math.round(Number(n) * 10) / 10; }
  function fmtBerat(n) {
    if (n === '' || n == null || isNaN(Number(n)) || Number(n) <= 0) return '';
    return String(rapikanBerat(n)).replace('.', ',');
  }
  /** Berat untuk hitungan harga/tier/rekomendasi: dibulatkan, minimal 1 kg. */
  function beratHitung(n) { const b = Number(n) || 0; return b > 0 ? Math.max(1, Math.round(b)) : 0; }

  /* ---- ringkasan (resume) panel bawah ---- */
  function resumeHtml(items) {
    return items.map((r) => r.foto
      ? `<div class="ik-ri foto"><div class="fw"><img src="${esc(r.foto)}" alt=""></div>${r.badge ? `<span class="b">${esc(r.badge)}</span>` : ''}</div>`
      : `<div class="ik-ri ${r.g}" title="${esc(r.title || '')}"><i class="fas ${r.ico}"></i>${r.badge ? `<span class="b">${esc(r.badge)}</span>` : ''}</div>`).join('');
  }

  /* ---- foto: potong persegi tengah & kecilkan di HP ---- */
  function kecilkanFoto(file, sisi = 320) {
    // FileReader -> data: URL (CSP app hanya mengizinkan img data:, bukan blob:)
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('File bukan gambar'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Gambar tidak bisa dibaca'));
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          const c = document.createElement('canvas'); c.width = sisi; c.height = sisi;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, sisi, sisi);
          let data = c.toDataURL('image/webp', 0.8);
          if (!/^data:image\/webp/.test(data)) data = c.toDataURL('image/jpeg', 0.82);
          resolve(data);
        };
        img.onerror = () => reject(new Error('Gambar tidak bisa dibaca (format tidak didukung, coba JPG/PNG)'));
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  /** Perubahan #40: foto diperbesar (layar penuh) + tombol aksi. o: {foto, nama, info, tombol, aksi, nonaktif} */
  function zoomFoto(o) {
    tutupZoom();
    const el = document.createElement('div');
    el.className = 'ik-lb'; el.id = 'ik-lb';
    el.innerHTML = `<button class="ik-lb-x" aria-label="Tutup"><i class="fas fa-xmark"></i></button>
      <div class="ik-lb-in"><img src="${esc(o.foto)}" alt="">
        <div class="ik-lb-n">${esc(o.nama || '')}</div>${o.info ? `<div class="ik-lb-i">${esc(o.info)}</div>` : ''}
        ${o.tombol ? `<button class="ik-lb-b" ${o.nonaktif ? 'disabled' : ''}>${o.tombol}</button>` : ''}</div>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ik-lb-b')) { tutupZoom(); if (typeof o.aksi === 'function') o.aksi(); return; }
      if (!e.target.closest('img') && !e.target.closest('.ik-lb-n') && !e.target.closest('.ik-lb-i')) tutupZoom();
    });
    document.body.appendChild(el);
    document.addEventListener('keydown', escZoom);
  }
  function escZoom(e) { if (e.key === 'Escape') tutupZoom(); }
  function tutupZoom() { const el = document.getElementById('ik-lb'); if (el) el.remove(); document.removeEventListener('keydown', escZoom); }

  /**
   * Perubahan #52: satu kartu Kering yang berputar tiap diklik.
   *  mati (pertama kali) -> rekomendasi; durasi X -> durasi berikutnya yang
   *  lebih tinggi; durasi tertinggi -> mati; mati (sesudahnya) -> terendah.
   * o: state order ({kering, kering_manual, kering_pernah}); list: layanan kering; rekomId: id rekomendasi.
   */
  function putarKering(o, list, rekomId) {
    const urut = [...list].filter((h) => Number(h.durasi_menit) > 0).sort((a, b) => Number(a.durasi_menit) - Number(b.durasi_menit));
    if (!urut.length) return;
    if (!o.kering) {
      o.kering = !o.kering_pernah && rekomId ? rekomId : urut[0].id;
      o.kering_pernah = true;
    } else {
      const i = urut.findIndex((h) => Number(h.id) === Number(o.kering));
      o.kering = i < 0 || i === urut.length - 1 ? null : urut[i + 1].id;
    }
    o.kering_manual = !!o.kering && Number(o.kering) !== Number(rekomId);
  }
  /** Kartu Kering tunggal (#52). */
  function tileKering(o, list, rekomId, rupiah, onclick) {
    const pilih = list.find((h) => Number(h.id) === Number(o.kering));
    const rek = list.find((h) => Number(h.id) === Number(rekomId));
    const m = pilih ? Number(pilih.durasi_menit) || 0 : 0;
    const desc = pilih ? (m === 15 ? 'tambahan kering · kalau 30/45 belum kering' : `${m} menit · ketuk untuk ganti`)
      : (rek ? `ketuk: ${Number(rek.durasi_menit)}' disarankan` : 'ketuk untuk pilih');
    return tile({ sel: !!pilih, g: 'g-kering', ico: 'fa-wind', badge: m ? `${m}'` : '', nama: m ? `Kering ${m}'` : 'Kering', desc,
      harga: pilih ? rupiah(pilih.harga) : '', onclick, // Perubahan #53: belum dipilih -> tanpa harga (netral)
      extra: pilih && Number(pilih.id) === Number(rekomId) ? '<div class="ik-rek">disarankan</div>' : '' });
  }
  /** Perubahan #51: ringkasan item ringkas (chip kecil satu baris). r: {g, ico, foto, label} */
  function chipsHtml(items) {
    return items.map((r) => `<span class="ik-chip">${r.foto ? `<i class="f"><img src="${esc(r.foto)}" alt=""></i>` : `<i class="${r.g}"><i class="fas ${r.ico}"></i></i>`}${esc(r.label || '')}</span>`).join('');
  }

  /** Lebar isian berat mengikuti panjang angka supaya "9,4 kg" tetap di tengah. */
  function lebarBerat(v) { return `${Math.max(1, String(v || '0').length) * 0.62 + 0.25}em`; }
  function pasLebar(el) { if (el) el.style.width = lebarBerat(el.value); }

  /** Perubahan #56 -- kode tampilan saja (database tetap kode lengkap).
   *  "ZL01-D01" -> "D1", "ZL02-W10" -> "W10"; keranjang "ZL02-K-102" -> "K-102". */
  function kodeMesin(k) {
    const s = String(k || ''); const m = s.match(/([A-Za-z]+)-?0*(\d+)$/);
    return m ? m[1].toUpperCase() + Number(m[2]) : (s.split('-').pop() || s);
  }
  function kodeKeranjang(k) {
    const s = String(k || ''); if (!s) return ''; const m = s.match(/([A-Za-z]+)-?(\d+)$/);
    return m ? `${m[1].toUpperCase()}-${m[2]}` : s;
  }
  /** status papan -> kelas warna */
  function kelasMesin(st) { return { running: 'mz-run', idle: 'mz-idle', teralokasi: 'mz-alloc', maintenance: 'mz-maint', nonaktif: 'mz-off' }[st] || 'mz-idle'; }
  /**
   * Perubahan #65/#67/#68: bar chart transaksi per jam 06..24 (CSS, tanpa library), dipakai kasir & manager.
   * perJam: [{jam, jumlah}] 0..23 (jam < 6 digabung ke batang 06).
   * opt.pembanding: [{jam, rata}] -> garis (rata-rata 4 minggu); opt.jamNow: indeks jam yang diwarnai oranye;
   * opt.kiri / opt.kanan: teks judul kecil; opt.labelGaris: legenda garis.
   */
  function grafikJam(perJam, opt = {}) {
    const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
    const v = Array(18).fill(0); const p = Array(18).fill(0);
    (perJam || []).forEach((r) => { v[Math.max(0, Number(r.jam) - 6)] += Number(r.jumlah) || 0; });
    const adaP = Array.isArray(opt.pembanding) && opt.pembanding.length;
    if (adaP) opt.pembanding.forEach((r) => { p[Math.max(0, Number(r.jam) - 6)] += Number(r.rata) || 0; });
    const maks = Math.max(1, ...v, ...(adaP ? p : [0]));
    const step = maks <= 5 ? 1 : maks <= 10 ? 2 : Math.ceil(maks / 5);
    const atas = Math.ceil(maks / step) * step;
    const garis = []; for (let y = 0; y <= atas; y += step) garis.push(y);
    const pad = (h) => String(h).padStart(2, '0');
    const n18 = 18;
    let line = '';
    if (adaP) {
      const pts = p.map((y, i) => `${((i + 0.5) / n18) * 100},${100 - (y / atas) * 100}`).join(' ');
      line = `<svg class="tpj-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${pts}" /></svg>
        ${p.map((y, i) => `<span class="tpj-dot" style="left:${((i + 0.5) / n18) * 100}%;bottom:${(y / atas) * 100}%" title="${pad(i + 6)}:00 · ${opt.labelGaris || 'pembanding'} ${fmt(y)}"></span>`).join('')}`;
    }
    return `<div class="tpj-card">
      <div class="tpj-head"><span>${opt.kiri || ''}</span><span>${opt.kanan || ''}</span></div>
      <div class="tpj-plot">
        <div class="tpj-y">${garis.slice().reverse().map((y) => `<span>${y}</span>`).join('')}</div>
        <div class="tpj-area">
          ${garis.map((y) => `<i class="tpj-grid" style="bottom:${(y / atas) * 100}%"></i>`).join('')}
          <div class="tpj-bars">${v.map((n, i) => `<div class="tpj-b${i + 6 === opt.jamNow ? ' now' : ''}" title="${pad(i + 6)}:00–${pad(i + 7)}:00 · ${n} transaksi${adaP ? ` · ${opt.labelGaris || 'pembanding'} ${fmt(p[i])}` : ''}">
              ${n ? `<em>${n}</em>` : ''}<b style="height:${(n / atas) * 100}%"></b></div>`).join('')}</div>
          ${line}
        </div>
      </div>
      <div class="tpj-x"><span></span><div>${v.map((_, i) => `<span>${(i % 3 === 0) ? pad(i + 6) : ''}</span>`).join('')}<span class="tpj-24">24</span></div></div>
      ${adaP ? `<div class="tpj-lg"><span><i class="bar"></i>Transaksi</span><span><i class="ln"></i>${esc(opt.labelGaris || 'Pembanding')}</span></div>` : ''}
    </div>`;
  }

  /**
   * Perubahan #75: perbarui isi container dengan HTML baru TANPA menggambar ulang semuanya
   * (tidak berkedip, scroll & elemen yang sama tidak disentuh). Diff sederhana per node.
   */
  function patchHtml(container, html) {
    if (!container) return;
    const tpl = document.createElement('div');
    tpl.innerHTML = html;
    morphAnak(container, tpl);
  }
  function samaNode(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName; }
  function morphAnak(lama, baru) {
    const L = Array.from(lama.childNodes); const B = Array.from(baru.childNodes);
    for (let i = 0; i < B.length; i++) {
      const b = B[i]; const a = L[i];
      if (!a) { lama.appendChild(b.cloneNode(true)); continue; }
      if (!samaNode(a, b)) { lama.replaceChild(b.cloneNode(true), a); continue; }
      if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; continue; }
      if (a.nodeType !== 1) continue;
      if (a === document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(a.nodeName)) continue; // jangan ganggu yang sedang diketik
      // atribut
      for (const at of Array.from(a.attributes)) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
      for (const at of Array.from(b.attributes)) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
      if (a.nodeName === 'CANVAS') continue; // kanvas Chart.js tidak disentuh
      morphAnak(a, b);
    }
    for (let i = L.length - 1; i >= B.length; i--) if (L[i]) lama.removeChild(L[i]);
  }

  window.IK3D = { patchHtml, grafikJam, kodeMesin, kodeKeranjang, kelasMesin, putarKering, tileKering, chipsHtml, zoomFoto, tutupZoom, esc, ikonLayanan, ikonBarang, fotoUrl, tile, qty, sec, parseBerat, rapikanBerat, fmtBerat, beratHitung, lebarBerat, pasLebar, resumeHtml, kecilkanFoto };
})();
