/* app.js — interfaccia del comparatore. Il calcolo dei costi è in engine.js. */
(function () {
  'use strict';
  const E = window.EnergyEngine;
  const $ = (s) => document.querySelector(s);
  const STORE = 'energy-offers-v1';
  const PAGE = 40;
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf3 = (x) => x.toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const nf4 = (x) => x.toLocaleString('it-IT', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const eur = (x) => nf0.format(Math.round(x)) + ' €';
  const eur2 = (x) => nf2.format(x) + ' €';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => {
    if (!u) return null;
    const s = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    try { const x = new URL(s); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; }
  };
  const monthLabel = (k) => { const [m, y] = String(k).split('/'); return `${MESI[+m - 1] || m} ${y}`; };

  const DEFAULTS = {
    kind: 'luce', kwh: 2700, kw: 3, residente: true, f1: 33, f2: 31,
    punScen: '12m', punCustom: 0.15,
    smc: 1000, psvScen: '12m', psvCustom: 0.6, reteFix: null, reteVar: null,
    type: 'all', regione: '', durata: 0, eligible: true, search: '',
  };
  let state = Object.assign({}, DEFAULTS);
  try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* stato corrotto: default */ }
  state.search = '';

  let DATA = null;
  let shown = PAGE;
  let lastRows = [];
  const nodes = new Map();       // `${kind}-${id}` → <li>
  const detailCache = new Map(); // `${kind}-${shard}` → Promise<dict>

  /* ---------------- calcolo ---------------- */

  function luceProfile() {
    const f1 = state.f1 / 100, f2 = state.f2 / 100;
    return { kwh: state.kwh, kw: state.kw, residente: state.residente, f1, f2, f3: Math.max(0, 1 - f1 - f2) };
  }
  function gasProfile() {
    const p = DATA.gas.params;
    return { smc: state.smc, reteFix: state.reteFix ?? p.rete_fix_monthly, reteVar: state.reteVar ?? p.rete_var_per_smc };
  }

  function eligibleLuce(o, pr) {
    if (o.dr === '01' && !pr.residente) return false;
    if (o.dr === '02' && pr.residente) return false;
    if (o.cmin > 0 && pr.kwh < o.cmin) return false;
    if (o.cmax > 0 && pr.kwh > o.cmax) return false;
    if (o.pmin > 0 && pr.kw < o.pmin) return false;
    if (o.pmax > 0 && pr.kw > o.pmax) return false;
    return true;
  }
  function eligibleGas(o, pr) {
    if (o.cmin > 0 && pr.smc < o.cmin) return false;
    if (o.cmax > 0 && pr.smc > o.cmax) return false;
    return true;
  }

  function compute() {
    const kind = state.kind;
    const block = DATA[kind];
    const q = state.search.trim().toLowerCase();
    const rows = [];
    let pr, idx;
    if (kind === 'luce') { pr = luceProfile(); idx = E.punIndex(block.params, state.punScen, state.punCustom); }
    else { pr = gasProfile(); idx = E.psvIndex(block.params, state.psvScen, state.psvCustom); }
    for (const o of block.offers) {
      if (state.type !== 'all' && o.t !== state.type) continue;
      if (state.durata > 0 && o.t === 'F' && o.d > state.durata) continue;
      if (state.regione && o.r.length && !o.r.includes(state.regione)) continue;
      if (state.eligible && !(kind === 'luce' ? eligibleLuce(o, pr) : eligibleGas(o, pr))) continue;
      if (q && !(o.n.toLowerCase().includes(q) || o.v.includes(q))) continue;
      const c = kind === 'luce' ? E.costLuce(o, block.params, pr, idx) : E.costGas(o, block.params, pr, idx);
      rows.push({ o, c, total: c.total });
    }
    rows.sort((a, b) => a.total - b.total);
    return { rows, pr, idx };
  }

  /* ---------------- render lista ---------------- */

  function badges(o, c, kind) {
    const b = [];
    b.push(o.t === 'F'
      ? `<span class="badge F">Fissa${o.d > 0 ? ' ' + o.d + ' mesi' : ''}</span>`
      : `<span class="badge V">Variabile</span>`);
    if (kind === 'luce') b.push(`<span class="badge fasce">${o.m === 'mono' ? 'monoraria' : o.m === 'bi' ? 'bioraria' : 'multioraria'}</span>`);
    if (o.r.length) b.push(`<span class="badge" title="Offerta con restrizione territoriale">📍 ${o.r.length > 10 ? 'quasi tutte' : o.r.length + (o.r.length === 1 ? ' regione' : ' regioni')}</span>`);
    const fix = c.fissoVenditore;
    const susp = DATA[kind].params.suspicious_fix_annual;
    if (fix > 0 && fix < susp) b.push(`<span class="badge warn" title="Quota fissa sospetta">⚠ quota fissa</span>`);
    if (o.t === 'F' && o.d > 0) b.push(`<span class="badge" title="Penale di recesso non pubblicata nei dati ARERA">❓ recesso</span>`);
    return b.join('');
  }

  function renderList(res) {
    const ol = $('#ranking');
    const kind = state.kind;
    const rows = res.rows;
    lastRows = rows;
    const vis = rows.slice(0, shown);

    // FLIP: posizioni prima del riordino
    const first = new Map();
    for (const el of ol.children) if (el.dataset.key) first.set(el.dataset.key, el.getBoundingClientRect().top);

    if (!vis.length) {
      ol.innerHTML = `<li class="empty">Nessuna offerta con questi filtri.</li>`;
      $('#more').hidden = true;
      return;
    }
    const best = vis[0].total;
    const worst = vis[vis.length - 1].total;
    const span = Math.max(1, worst - best);
    const keep = new Set();
    const frag = document.createDocumentFragment();
    vis.forEach((r, i) => {
      const key = `${kind}-${r.o.id}`;
      keep.add(key);
      let el = nodes.get(key);
      const fresh = !el;
      if (fresh) {
        el = document.createElement('li');
        el.className = 'offer';
        el.dataset.key = key;
        el.dataset.id = r.o.id;
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        nodes.set(key, el);
      }
      const delta = r.total - best;
      el.innerHTML =
        `<span class="rank">${i + 1}</span>` +
        `<span class="name" title="${esc(r.o.n)}">${esc(r.o.n)}</span>` +
        `<span class="price"><b>${eur(r.total)}</b><span>${eur(r.total / 12)}/mese</span>` +
        `<em>${i === 0 ? 'la più economica' : '+' + eur(delta)}</em></span>` +
        `<span class="meta">${esc(r.o.v || '—')} ${badges(r.o, r.c, kind)}</span>` +
        `<span class="bar"><i style="width:${(12 + 88 * (r.total - best) / span).toFixed(1)}%"></i></span>`;
      el.setAttribute('aria-label', `${i + 1}°, ${r.o.n}, ${eur(r.total)} all'anno`);
      if (fresh && first.size) el.classList.add('enter');
      frag.appendChild(el);
    });
    for (const el of [...ol.children]) if (!keep.has(el.dataset.key)) el.remove();
    ol.appendChild(frag);

    // FLIP: inverti e anima
    const moved = [];
    for (const el of ol.children) {
      const f = first.get(el.dataset.key);
      if (f == null) continue;
      const d = f - el.getBoundingClientRect().top;
      if (Math.abs(d) > 1 && Math.abs(d) < 2400) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${d}px)`;
        moved.push(el);
      }
    }
    if (moved.length) {
      requestAnimationFrame(() => {
        for (const el of moved) {
          el.style.transition = 'transform .38s cubic-bezier(.2,.8,.2,1)';
          el.style.transform = '';
        }
      });
    }
    const more = $('#more');
    more.hidden = rows.length <= shown;
    more.textContent = `Mostra altre ${Math.min(PAGE, rows.length - shown)} (di ${nf0.format(rows.length)})`;
  }

  function renderSummary(res) {
    const rows = res.rows;
    const st = $('#stats');
    if (!rows.length) { st.innerHTML = ''; $('#histo').innerHTML = ''; return; }
    const totals = rows.map((r) => r.total);
    const med = totals[Math.floor(totals.length / 2)];
    const unit = state.kind === 'luce' ? state.kwh : state.smc;
    st.innerHTML =
      `<div class="stat best"><b>${eur(totals[0])}</b><span>migliore</span></div>` +
      `<div class="stat"><b>${eur(med)}</b><span>mediana</span></div>` +
      `<div class="stat"><b>${nf0.format(rows.length)}</b><span>offerte</span></div>`;
    const nudge = $('#nudge');
    const top = rows[0].o;
    if (!state.regione && top.r.length) {
      const where = top.r.length === 1 ? (DATA.regioni[top.r[0]] || top.r[0]) : `${top.r.length} regioni`;
      nudge.innerHTML = `La prima è attivabile solo in ${esc(where)}. <button type="button" id="nudgeBtn">Scegli dove abiti</button> per vedere solo le offerte valide per te.`;
      nudge.hidden = false;
      $('#nudgeBtn').onclick = () => { const s = $('#regione'); s.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => s.focus(), 350); };
    } else nudge.hidden = true;
    st.title = `Migliore: ${nf3(totals[0] / unit)} €/${state.kind === 'luce' ? 'kWh' : 'Smc'} tutto compreso`;
    // istogramma 2°-98° percentile
    const lo = totals[Math.floor(totals.length * 0.02)], hi = totals[Math.floor(totals.length * 0.98)] || lo + 1;
    const N = 30, bins = new Array(N).fill(0);
    for (const t of totals) { const k = Math.min(N - 1, Math.max(0, Math.floor((t - lo) / (hi - lo + 1e-9) * N))); bins[k]++; }
    const mx = Math.max(...bins) || 1;
    $('#histo').innerHTML = bins.map((b, i) => `<i class="${i === 0 ? 'hot' : ''}" style="height:${(4 + 96 * b / mx).toFixed(0)}%"></i>`).join('');
  }

  /* ---------------- controlli ---------------- */

  function setPct(slider) {
    const min = +slider.min, max = +slider.max, v = Math.min(max, Math.max(min, +slider.value));
    slider.style.setProperty('--pct', ((v - min) / (max - min) * 100) + '%');
  }

  function chips(container, items, current, onPick) {
    container.innerHTML = items.map((it) =>
      `<button type="button" class="chip" data-v="${it.v}" aria-pressed="${String(it.v) === String(current)}">${esc(it.label)}${it.small ? `<small>${esc(it.small)}</small>` : ''}</button>`).join('');
    container.onclick = (e) => { const b = e.target.closest('.chip'); if (b) onPick(b.dataset.v); };
  }

  function seg(container, items, current, onPick) {
    container.innerHTML = items.map((it) =>
      `<button type="button" role="radio" data-v="${it.v}" aria-checked="${it.v === current}">${esc(it.label)}${it.small ? `<small>${esc(it.small)}</small>` : ''}</button>`).join('');
    container.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
  }

  function syncControls() {
    document.body.dataset.kind = state.kind;
    for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t.dataset.kind === state.kind));

    // luce
    const kwh = $('#kwh'); kwh.value = state.kwh; setPct(kwh);
    $('#kwhNum').value = state.kwh;
    $('#kwhNum').style.width = (String(state.kwh).length + 0.25) + 'ch';
    $('#kwhHint').textContent = `≈ ${nf0.format(state.kwh / 12)} kWh al mese`;
    chips($('#kwhPresets'), [
      { v: 1500, label: 'Single', small: '1.500' }, { v: 2200, label: 'Coppia', small: '2.200' },
      { v: 2700, label: 'Famiglia', small: '2.700' }, { v: 4000, label: 'Famiglia numerosa', small: '4.000' },
    ], state.kwh, (v) => update({ kwh: +v }));
    chips($('#kwChips'), [1.5, 3, 4.5, 6, 10].map((k) => ({ v: k, label: nf0.format(k) === String(k) ? k + ' kW' : String(k).replace('.', ',') + ' kW' })),
      state.kw, (v) => update({ kw: +v }));
    $('#residente').checked = state.residente;
    const f1 = state.f1, f2 = state.f2, f3 = Math.max(0, 100 - f1 - f2);
    $('#f1').value = f1; $('#f2').value = f2; setPct($('#f1')); setPct($('#f2'));
    $('#f1Val').textContent = f1 + '%'; $('#f2Val').textContent = f2 + '%'; $('#f3Val').textContent = f3 + '%';
    $('#fasceSummary').textContent = `${f1} / ${f2} / ${f3}`;
    const bar = document.querySelectorAll('.fasce-bar span');
    bar[0].style.flexBasis = f1 + '%'; bar[1].style.flexBasis = f2 + '%'; bar[2].style.flexBasis = f3 + '%';
    chips($('#fascePresets'), [
      { v: '33-31', label: 'Tipica' }, { v: '20-30', label: 'Fuori casa di giorno' },
      { v: '40-30', label: 'Smart working' }, { v: '25-29', label: 'Sera e weekend' },
    ], `${f1}-${f2}`, (v) => { const [a, b] = v.split('-').map(Number); update({ f1: a, f2: b }); });

    if (DATA) {
      const lp = DATA.luce.params;
      seg($('#punSeg'), [
        { v: '12m', label: 'Media 12 mesi', small: nf3(lp.pun_12m.mono) + ' €/kWh' },
        { v: 'last', label: 'Ultimo mese', small: `${monthLabel(lp.pun_last.month)} · ${nf3(lp.pun_last.mono)}` },
        { v: 'custom', label: 'A scelta', small: nf3(state.punCustom) },
      ], state.punScen, (v) => update({ punScen: v }));
      const gp = DATA.gas.params;
      seg($('#psvSeg'), [
        { v: '12m', label: 'Media 12 mesi', small: nf3(gp.psv_12m) + ' €/Smc' },
        { v: 'last', label: 'Ultimo mese', small: `${monthLabel(gp.psv_last.month)} · ${nf3(gp.psv_last.value)}` },
        { v: 'custom', label: 'A scelta', small: nf3(state.psvCustom) },
      ], state.psvScen, (v) => update({ psvScen: v }));
      $('#reteFix').value = state.reteFix ?? gp.rete_fix_monthly;
      $('#reteVar').value = state.reteVar ?? gp.rete_var_per_smc;
      $('#reteSummary').textContent = `${nf2.format(+$('#reteFix').value)} €/mese + ${nf3(+$('#reteVar').value)} €/Smc`;
    }
    $('#punCustomBox').classList.toggle('on', state.punScen === 'custom');
    $('#punCustom').value = state.punCustom; setPct($('#punCustom'));
    $('#punCustomVal').textContent = `PUN ipotizzato: ${nf3(state.punCustom)} €/kWh (fasce in proporzione alla media 12 mesi)`;
    $('#psvCustomBox').classList.toggle('on', state.psvScen === 'custom');
    $('#psvCustom').value = state.psvCustom; setPct($('#psvCustom'));
    $('#psvCustomVal').textContent = `PSV ipotizzato: ${nf3(state.psvCustom)} €/Smc`;

    // gas
    const smc = $('#smc'); smc.value = state.smc; setPct(smc);
    $('#smcNum').value = state.smc;
    $('#smcNum').style.width = (String(state.smc).length + 0.25) + 'ch';
    $('#smcHint').textContent = `≈ ${nf0.format(state.smc / 12)} Smc al mese in media (ma d'inverno molto di più)`;
    chips($('#smcPresets'), [
      { v: 150, label: 'Solo cucina', small: '150' }, { v: 500, label: 'Cucina e acqua calda', small: '500' },
      { v: 1000, label: 'Riscaldamento', small: '1.000' }, { v: 1600, label: 'Casa grande', small: '1.600' },
    ], state.smc, (v) => update({ smc: +v }));

    // slider compatto agganciato all'header (mobile)
    const ms = $('#miniSlider'), src = state.kind === 'luce' ? kwh : smc;
    ms.min = src.min; ms.max = src.max; ms.step = src.step; ms.value = src.value; setPct(ms);
    $('#miniVal').textContent = state.kind === 'luce' ? `${nf0.format(state.kwh)} kWh` : `${nf0.format(state.smc)} Smc`;

    // riassunto del pannello impostazioni
    const typeTxt = { all: 'tutte', F: 'solo fisse', V: 'solo variabili' }[state.type];
    const parts = state.kind === 'luce'
      ? [`${String(state.kw).replace('.', ',')} kW`, state.residente ? 'residente' : 'non residente', `PUN ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.punCustom) }[state.punScen]}`, typeTxt]
      : [`PSV ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.psvCustom) }[state.psvScen]}`, typeTxt];
    if (state.durata) parts.push(`fisso ≤ ${state.durata} mesi`);
    $('#settingsTxt').textContent = parts.join(' · ');

    // filtri
    for (const b of document.querySelectorAll('#typeSeg button')) b.setAttribute('aria-checked', String(b.dataset.v === state.type));
    $('#regione').value = state.regione;
    $('#durata').value = String(state.durata);
    $('#eligible').checked = state.eligible;
    if (document.activeElement !== $('#search')) $('#search').value = state.search;
  }

  let frame = 0, saveTimer = 0;
  function update(patch, opts) {
    Object.assign(state, patch);
    if (!opts || !opts.keepPage) shown = PAGE;
    syncControls();
    if (!DATA) return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const res = compute();
      renderSummary(res);
      renderList(res);
    });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { search, ...rest } = state;
      try { localStorage.setItem(STORE, JSON.stringify(rest)); } catch (e) { /* privato */ }
    }, 300);
  }

  function bind() {
    for (const t of document.querySelectorAll('.tabs button')) {
      t.onclick = () => { if (state.kind !== t.dataset.kind) { $('#ranking').innerHTML = ''; update({ kind: t.dataset.kind }); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
    }
    $('#kwh').addEventListener('input', (e) => update({ kwh: +e.target.value }));
    $('#kwhNum').addEventListener('change', (e) => update({ kwh: clamp(Math.round(+e.target.value || 0), 100, 20000) }));
    $('#smc').addEventListener('input', (e) => update({ smc: +e.target.value }));
    $('#miniSlider').addEventListener('input', (e) => update(state.kind === 'luce' ? { kwh: +e.target.value } : { smc: +e.target.value }));
    $('#smcNum').addEventListener('change', (e) => update({ smc: clamp(Math.round(+e.target.value || 0), 10, 10000) }));
    $('#residente').addEventListener('change', (e) => update({ residente: e.target.checked }));
    $('#f1').addEventListener('input', (e) => { const f1 = +e.target.value; update({ f1, f2: Math.min(state.f2, 100 - f1) }); });
    $('#f2').addEventListener('input', (e) => { const f2 = +e.target.value; update({ f2, f1: Math.min(state.f1, 100 - f2) }); });
    $('#punCustom').addEventListener('input', (e) => update({ punCustom: +e.target.value }));
    $('#psvCustom').addEventListener('input', (e) => update({ psvCustom: +e.target.value }));
    $('#reteFix').addEventListener('change', (e) => update({ reteFix: Math.max(0, +e.target.value || 0) }));
    $('#reteVar').addEventListener('change', (e) => update({ reteVar: Math.max(0, +e.target.value || 0) }));
    $('#typeSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) update({ type: b.dataset.v }); };
    $('#regione').addEventListener('change', (e) => update({ regione: e.target.value }));
    $('#durata').addEventListener('change', (e) => update({ durata: +e.target.value }));
    $('#eligible').addEventListener('change', (e) => update({ eligible: e.target.checked }));
    $('#search').addEventListener('input', (e) => update({ search: e.target.value }));
    $('#more').onclick = () => { shown += PAGE; update({}, { keepPage: true }); };
    const ol = $('#ranking');
    ol.addEventListener('click', (e) => { const li = e.target.closest('.offer'); if (li) openDetail(+li.dataset.id); });
    ol.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const li = e.target.closest('.offer'); if (li) { e.preventDefault(); openDetail(+li.dataset.id); }
    });
    $('#backdrop').onclick = () => closeDetail();
    $('#sheetClose').onclick = () => closeDetail();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeDetail(); });
    window.addEventListener('popstate', () => { if (!$('#sheet').hidden) closeDetail(true); });
    swipeToClose();
    // impostazioni sempre aperte su desktop, chiuse di partenza su telefono
    const mq = window.matchMedia('(min-width: 960px)');
    const applyMq = () => { if (mq.matches) $('#settings').open = true; };
    mq.addEventListener('change', applyMq); applyMq();
    // slider compatto: compare quando il riquadro grande esce dallo schermo
    const miniToggle = () => {
      const h = [...document.querySelectorAll('.hero')].find((x) => x.offsetParent !== null);
      $('.top').classList.toggle('show-mini', !!h && !mq.matches && h.getBoundingClientRect().bottom < 120);
    };
    window.addEventListener('scroll', miniToggle, { passive: true });
    window.addEventListener('resize', miniToggle);
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------------- dettaglio ---------------- */

  function loadDetails(kind, id) {
    const shard = id % DATA.detail_shards;
    const key = `${kind}-${shard}`;
    if (!detailCache.has(key)) {
      const name = `details-${kind}-${String(shard).padStart(2, '0')}.json?v=${encodeURIComponent(DATA.generated_at)}`;
      detailCache.set(key, fetch(name).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch((e) => { detailCache.delete(key); throw e; }));
    }
    return detailCache.get(key).then((d) => d[String(id)]);
  }

  function openDetail(id) {
    const kind = state.kind;
    const pos = lastRows.findIndex((r) => r.o.id === id);
    const row = pos >= 0 ? lastRows[pos] : null;
    if (!row) return;
    const sheet = $('#sheet'), bd = $('#backdrop');
    $('#sheetBody').innerHTML = detailHead(row, pos, kind) + `<div id="dRest" class="loading">Carico i dettagli…</div>`;
    sheet.hidden = false; bd.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('on'); bd.classList.add('on'); });
    $('#sheetBody').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    history.pushState({ sheet: id }, '');
    $('#sheetClose').focus({ preventScroll: true });
    loadDetails(kind, id).then((d) => {
      const rest = $('#dRest'); if (!rest) return;
      rest.className = '';
      rest.innerHTML = d ? detailRest(row, d, kind) : '<p class="note">Dettagli non disponibili.</p>';
    }).catch(() => { const rest = $('#dRest'); if (rest) rest.innerHTML = '<p class="note warn">Non riesco a caricare i dettagli. Riprova.</p>'; });
  }

  function closeDetail(fromPop) {
    const sheet = $('#sheet'), bd = $('#backdrop');
    sheet.classList.remove('on'); bd.classList.remove('on');
    sheet.style.transform = '';
    document.body.style.overflow = '';
    setTimeout(() => { sheet.hidden = true; bd.hidden = true; }, 320);
    if (!fromPop && history.state && history.state.sheet != null) history.back();
  }

  function swipeToClose() {
    const sheet = $('#sheet'), body = $('#sheetBody');
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', (e) => {
      if (window.innerWidth >= 960 || body.scrollTop > 0) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      sheet.style.transition = '';
      if (dy > 110) closeDetail(); else sheet.style.transform = '';
      y0 = null;
    });
  }

  function breakdown(c, kind) {
    if (kind === 'luce') {
      const s = c.sistema;
      return [
        ['Energia', c.energia, 'var(--c-energia)'],
        ['Quota fissa venditore', c.fissoVenditore, 'var(--c-fisso)'],
        ['Dispacciamento', c.dispacciamento, 'var(--c-disp)'],
        ['Rete e oneri di sistema', s.fixAnnual + s.varAnnual + s.dispbt, 'var(--c-rete)'],
        ['Accise', s.excise, 'var(--c-accise)'],
        ['IVA 10%', c.iva, 'var(--c-iva)'],
        ['Canone RAI', c.rai, 'var(--c-rai)'],
      ];
    }
    return [
      ['Materia gas', c.energia, 'var(--c-energia)'],
      ['Quota fissa venditore', c.fissoVenditore, 'var(--c-fisso)'],
      ['Rete, oneri e accise', c.rete, 'var(--c-rete)'],
      ['IVA (10% / 22%)', c.iva, 'var(--c-iva)'],
    ];
  }

  function detailHead(row, pos, kind) {
    const { o, c } = row;
    const parts = breakdown(c, kind).filter((p) => Math.abs(p[1]) > 0.005);
    const pos_ = parts.filter((p) => p[1] > 0);
    const sumPos = pos_.reduce((a, p) => a + p[1], 0) || 1;
    return `<header class="d-head">
        <div class="badges">${badges(o, c, kind)}</div>
        <h2 id="sheetTitle">${esc(o.n)}</h2>
        <div class="vendor">${esc(o.v || 'venditore non indicato')}</div>
      </header>
      <div class="d-total"><b>${eur(row.total)}</b><span>all'anno · ${eur(row.total / 12)}/mese</span></div>
      <div class="d-rank">${pos + 1}° su ${nf0.format(lastRows.length)} con i filtri attuali${pos > 0 ? ` · +${eur(row.total - lastRows[0].total)} rispetto alla prima` : ''}</div>
      <div class="stack">${pos_.map((p) => `<i style="width:${(100 * p[1] / sumPos).toFixed(2)}%;background:${p[2]}" title="${esc(p[0])}"></i>`).join('')}</div>
      <div class="legend">${parts.map((p) => `<span class="k" style="--c:${p[2]}">${esc(p[0])}</span><span class="v">${eur2(p[1])}</span>`).join('')}
        <span class="k tot" style="--c:transparent">Totale annuo</span><span class="v tot">${eur2(row.total)}</span></div>`;
  }

  function priceRows(o, kind) {
    const P = DATA[kind].params;
    if (kind === 'gas') {
      if (o.t === 'F') return [['Prezzo gas fisso', nf4(o.p) + ' €/Smc']].concat(o.sb ? [['Oneri di bilanciamento', nf4(o.sb) + ' €/Smc']] : []);
      const psv = E.psvIndex(P, state.psvScen, state.psvCustom);
      return [['Spread sul PSV', '+' + nf4(o.p) + ' €/Smc'], ['PSV usato', nf4(psv) + ' €/Smc'],
        ['Prezzo risultante', nf4(psv + o.p + (o.sb || 0)) + ' €/Smc']].concat(o.sb ? [['di cui bilanciamento', nf4(o.sb) + ' €/Smc']] : []);
    }
    const idx = E.punIndex(P, state.punScen, state.punCustom);
    const L = P.lambda;
    const lab = o.m === 'mono' ? [['Monoraria', 0]] : o.m === 'bi' ? [['F1', 0], ['F2 e F3', 1]] : [['F1', 0], ['F2', 1], ['F3', 2]];
    if (o.t === 'F') return lab.map(([l, i]) => [`Prezzo ${l}`, nf4(o.p[i]) + ' €/kWh']);
    const key = o.m === 'mono' ? ['mono'] : o.m === 'bi' ? ['f1', 'f23'] : ['f1', 'f2', 'f3'];
    return lab.map(([l, i]) => {
      const pun = idx[key[i]];
      return [`${l}: PUN ${nf4(pun)} × ${String(L).replace('.', ',')} + ${nf4(o.p[i])}`, nf4(pun * L + o.p[i]) + ' €/kWh'];
    });
  }

  function detailRest(row, d, kind) {
    const { o, c } = row;
    const out = [];
    const notes = [];
    const susp = DATA[kind].params.suspicious_fix_annual;
    if (c.fissoVenditore > 0 && c.fissoVenditore < susp) {
      const alt = row.total + (12 * 12 - c.fissoVenditore) * (kind === 'luce' ? 1.10 : 1.22);
      notes.push(`La quota fissa dichiarata è di ${eur2(c.fissoVenditore)} all'anno: molto bassa. A volte è un errore di unità (€/mese scritto come €/anno). Se fosse 12 €/mese, il totale sarebbe circa ${eur(alt)}. Controlla le condizioni del venditore.`);
    }
    if (o.t === 'F' && o.d > 0) notes.push(`Prezzo fisso per ${o.d} mesi. I dati ARERA non dicono se c'è una penale di uscita anticipata: cercala nella scheda sintetica, sezione "Modalità e oneri per il recesso".`);
    if (state.regione && o.r.length && !o.r.includes(state.regione)) notes.push('Non attivabile nella regione scelta.');
    if (notes.length) out.push(notes.map((n) => `<p class="note warn">${esc(n)}</p>`).join(''));

    out.push(`<section class="d-sec"><h3>Prezzo</h3><table class="tbl">${priceRows(o, kind).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
      <tr><td>Quota fissa venditore</td><td>${eur2(c.fissoVenditore)}/anno</td></tr></table></section>`);

    if (d.componenti && d.componenti.length) {
      out.push(`<section class="d-sec"><h3>Voci pubblicate dal venditore</h3><table class="tbl">${d.componenti.map((x) =>
        `<tr><td>${esc(x.n)}${x.f ? ` · ${esc(x.f)}` : ''}${x.desc ? `<small>${esc(x.desc)}</small>` : ''}</td><td>${esc(x.p.toLocaleString('it-IT', { maximumFractionDigits: 6 }))} ${esc(x.um)}</td></tr>`).join('')}</table></section>`);
    }
    if (d.sconti && d.sconti.length) {
      out.push(`<section class="d-sec"><h3>Sconti e bonus <small>(non inclusi nel totale)</small></h3>${d.sconti.map((s) =>
        `<p class="desc"><b>${esc(s.n || 'Sconto')}</b>${s.prezzi && s.prezzi.length ? ' · ' + s.prezzi.map((p) => `${esc(p.p)} ${esc(p.um)}`).join(', ') : ''}<br>${esc(s.desc || '')}</p>`).join('')}</section>`);
    }
    if (d.condizioni && d.condizioni.length) {
      out.push(`<section class="d-sec"><h3>Condizioni contrattuali</h3>${d.condizioni.map((x) =>
        `<p class="desc"><b>${esc(x.tipo)}${x.lim ? ' · limitante' : ''}</b><br>${esc(x.desc || '')}</p>`).join('')}</section>`);
    }
    const regs = o.r.length ? o.r.map((r) => DATA.regioni[r] || r).join(', ') : 'tutta Italia';
    const lim = [];
    if (o.cmin > 0 || o.cmax > 0) lim.push(`consumo ${o.cmin ? 'da ' + nf0.format(o.cmin) : ''}${o.cmax ? ' fino a ' + nf0.format(o.cmax) : ''} ${kind === 'luce' ? 'kWh' : 'Smc'}/anno`);
    if (o.pmin > 0 || o.pmax > 0) lim.push(`potenza ${o.pmin ? 'da ' + o.pmin : ''}${o.pmax ? ' fino a ' + o.pmax : ''} kW`);
    const dr = { '01': 'solo residenti', '02': 'solo non residenti', '03': 'residenti e non' }[o.dr] || '—';
    const kv = [
      ['Codice offerta', d.codice], ['Tipo', o.t === 'F' ? `Prezzo fisso${o.d > 0 ? ` per ${o.d} mesi` : ''}` : 'Prezzo variabile'],
      ['Sottoscrivibile fino al', (d.al || '').replace('_', ' ')], ['Attivazione', (d.modalita || []).join(', ')],
      ['Dove', regs], kind === 'luce' ? ['Clienti', dr] : null, lim.length ? ['Limiti', lim.join(' · ')] : null,
      ['Telefono', d.tel],
    ].filter((x) => x && x[1]);
    out.push(`<section class="d-sec"><h3>Informazioni</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`);
    if (d.desc) out.push(`<section class="d-sec"><h3>Descrizione</h3><p class="desc">${esc(d.desc)}</p></section>`);

    const links = [];
    const uo = safeUrl(d.url_offerta), us = safeUrl(d.url_sito);
    if (uo) links.push(`<a class="btn primary" href="${esc(uo)}" target="_blank" rel="noopener noreferrer">Pagina dell'offerta</a>`);
    if (us && us !== uo) links.push(`<a class="btn" href="${esc(us)}" target="_blank" rel="noopener noreferrer">Sito del venditore</a>`);
    links.push(`<a class="btn" href="https://www.ilportaleofferte.it/portaleOfferte/" target="_blank" rel="noopener noreferrer">Portale Offerte ARERA</a>`);
    out.push(`<div class="actions">${links.join('')}</div>`);
    return out.join('');
  }

  /* ---------------- avvio ---------------- */

  function footer() {
    const L = DATA.luce, G = DATA.gas;
    const gen = new Date(DATA.generated_at);
    const genTxt = isNaN(gen) ? DATA.generated_at : gen.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
    $('#dataInfo').textContent = `${nf0.format(L.offers.length)} offerte luce · ${nf0.format(G.offers.length)} gas · aggiornato ${genTxt}`;
    const ser = L.params.pun_series;
    $('#foot').innerHTML =
      (DATA.warnings && DATA.warnings.length ? `<div class="warnbox">Dati non del tutto aggiornati: ${DATA.warnings.map(esc).join(' · ')}</div>` : '') +
      `<p>Costo annuo IVA inclusa, calcolato con lo stesso modello di <code>check_offers.py</code>: energia, quota fissa del venditore, dispacciamento, rete, oneri di sistema, accise, IVA e, per i residenti, canone RAI. Le variabili usano il PUN o il PSV scelto sopra. Non sono inclusi sconti, bonus e penali di recesso.</p>` +
      `<p>Fonti: offerte <a href="https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page" target="_blank" rel="noopener">Portale Offerte ARERA</a> (${esc(L.source_xml)}, ${esc(G.source_xml)}); PUN GME, media ${ser.length > 1 ? `${monthLabel(ser[ser.length - 12] ? ser[ser.length - 12][0] : ser[0][0])} – ${monthLabel(ser[ser.length - 1][0])}` : ''}; PSV: ${esc(G.params.psv_sources)}; parametri regolati ${esc(L.params.params_source)}. I costi di rete del gas sono medie nazionali, modificabili.</p>`;
    // regioni
    const sel = $('#regione');
    sel.innerHTML = `<option value="">Tutta Italia</option>` + Object.entries(DATA.regioni)
      .sort((a, b) => a[1].localeCompare(b[1], 'it')).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    sel.value = state.regione;
  }

  bind();
  syncControls();
  fetch('offers.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      footer();
      update({});
    })
    .catch((e) => {
      $('#dataInfo').textContent = 'Non riesco a caricare le offerte.';
      $('#ranking').innerHTML = `<li class="empty">Errore nel caricamento di offers.json (${esc(e.message)}).</li>`;
    });
})();
