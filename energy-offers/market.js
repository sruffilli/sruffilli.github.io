/* market.js — tab "Mercato": grafici PUN/PSV (SVG fatto a mano) e curiosità sulle offerte.
 *
 * I dati delle serie arrivano da offers.json → market (web_export.build_market).
 * Le curiosità sono calcolate qui, con engine.js e sul profilo dell'utente,
 * tramite le funzioni che app.js espone in window.EnergyApp.
 */
(function () {
  'use strict';
  const E = window.EnergyEngine;
  const A = () => window.EnergyApp;
  const $ = (s) => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const MESI_LUNGHI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  let ready = false;
  const charts = [];   // funzioni di ridisegno, per il resize

  const f3 = (x) => x.toLocaleString('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const pct = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toLocaleString('it-IT', { maximumFractionDigits: 0 }) + '%';
  const ym = (k) => { const [y, m] = k.split('-'); return `${MESI[+m - 1]} ${y}`; };
  const ymd = (k) => { const [y, m, d] = k.split('-'); return `${+d} ${MESI[+m - 1]} ${y}`; };
  const esc = (s) => A().fmt.esc(s);
  const aMese = (m) => (/^[aeiou]/.test(m) ? 'ad ' : 'a ') + m;   // "a settembre", "ad agosto"

  /* ---------------- grafici ---------------- */

  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
    const start = Math.floor(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 0.01; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /*
   * chart(container, { labels, series:[{name,color,values,dash,area}], kind:'line'|'bar',
   *   yFmt, xFmt(label,i), tipFmt(label,i), refs:[{y,label}], highlight(i)->bool, height })
   */
  function chart(container, cfg) {
    const draw = () => {
      container.innerHTML = '';
      const W = Math.max(280, container.clientWidth || 320);
      const H = cfg.height || (W < 520 ? 210 : 260);
      const P = { l: 44, r: 12, t: 12, b: 26 };
      const n = cfg.labels.length;
      if (!n) { container.innerHTML = '<p class="hint">Dati non disponibili.</p>'; return; }
      const all = cfg.series.flatMap((s) => s.values).filter((v) => v != null);
      (cfg.refs || []).forEach((r) => all.push(r.y));
      let lo = Math.min(...all), hi = Math.max(...all);
      const nonNeg = lo >= 0;
      if (cfg.kind === 'bar' || cfg.zero) lo = 0; else lo = lo - (hi - lo) * 0.08;
      if (nonNeg) lo = Math.max(0, lo);
      hi = hi + (hi - lo) * 0.08;
      const ticks = niceTicks(lo, hi, 4).filter((t) => !nonNeg || t >= 0);
      lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
      const iw = W - P.l - P.r, ih = H - P.t - P.b;
      const slot = iw / n;
      const x = cfg.kind === 'bar' ? (i) => P.l + slot * (i + 0.5) : (i) => P.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
      const y = (v) => P.t + ih * (1 - (v - lo) / (hi - lo || 1));

      const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'svgchart', role: 'img' }, container);
      if (cfg.aria) svg.setAttribute('aria-label', cfg.aria);
      const defs = el('defs', {}, svg);
      cfg.series.forEach((s, si) => {
        const g = el('linearGradient', { id: `g-${container.id}-${si}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }, g);
        el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, g);
      });
      // griglia
      for (const t of ticks) {
        if (t < lo || t > hi) continue;
        el('line', { x1: P.l, x2: W - P.r, y1: y(t), y2: y(t), class: 'grid' }, svg);
        const tx = el('text', { x: P.l - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
        tx.textContent = cfg.yFmt(t);
      }
      // etichette x
      // etichette: xFmt decide quali indici meritano un'etichetta (inizio
      // mese, inizio anno…); qui si salta quella che finirebbe troppo vicina.
      let lastX = -Infinity;
      const minGap = cfg.xGap || 44;
      for (let i = 0; i < n; i++) {
        const lab = cfg.xFmt(cfg.labels[i], i);
        if (!lab || x(i) - lastX < minGap) continue;
        const tx = el('text', { x: x(i), y: H - 7, class: 'tick', 'text-anchor': 'middle' }, svg);
        tx.textContent = lab;
        lastX = x(i);
      }
      // riferimenti
      for (const r of cfg.refs || []) {
        el('line', { x1: P.l, x2: W - P.r, y1: y(r.y), y2: y(r.y), class: 'ref' }, svg);
        const tx = el('text', { x: W - P.r - 2, y: y(r.y) - 4, class: 'ref-label', 'text-anchor': 'end' }, svg);
        tx.textContent = r.label;
      }
      // serie
      cfg.series.forEach((s, si) => {
        if (cfg.kind === 'bar') {
          const bw = Math.max(2, slot * 0.68);
          s.values.forEach((v, i) => {
            if (v == null) return;
            el('rect', {
              x: x(i) - bw / 2, y: y(v), width: bw, height: Math.max(1, y(lo) - y(v)), rx: Math.min(4, bw / 3),
              fill: s.color, opacity: cfg.highlight && !cfg.highlight(i) ? 0.45 : 1,
            }, svg);
          });
          return;
        }
        let d = '', started = false, first = null, last = null;
        s.values.forEach((v, i) => {
          if (v == null) { started = false; return; }
          d += (started ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
          started = true; if (first == null) first = i; last = i;
        });
        if (s.area && first != null) {
          el('path', { d: d + `L${x(last).toFixed(1)},${y(lo)}L${x(first).toFixed(1)},${y(lo)}Z`, fill: `url(#g-${container.id}-${si})` }, svg);
        }
        el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.2, 'stroke-linejoin': 'round',
          'stroke-linecap': 'round', 'stroke-dasharray': s.dash ? '5 4' : 'none', opacity: s.opacity || 1 }, svg);
      });
      // interazione
      const guide = el('line', { y1: P.t, y2: H - P.b, class: 'guide', visibility: 'hidden' }, svg);
      const dots = cfg.series.map((s) => el('circle', { r: 4.5, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' }, svg));
      const tip = document.createElement('div');
      tip.className = 'tip'; tip.hidden = true; container.appendChild(tip);
      const hit = el('rect', { x: P.l, y: P.t, width: iw, height: ih, fill: 'transparent' }, svg);
      const at = (ev) => {
        const r = svg.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (W / r.width);
        let i = cfg.kind === 'bar' ? Math.floor((px - P.l) / slot) : Math.round(((px - P.l) / iw) * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
        cfg.series.forEach((s, si) => {
          const v = s.values[i];
          if (v == null || cfg.kind === 'bar') { dots[si].setAttribute('visibility', 'hidden'); return; }
          dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(v)); dots[si].setAttribute('visibility', 'visible');
        });
        tip.innerHTML = cfg.tipFmt(cfg.labels[i], i);
        tip.hidden = false;
        const left = (x(i) / W) * r.width;
        tip.style.left = Math.max(4, Math.min(r.width - tip.offsetWidth - 4, left - tip.offsetWidth / 2)) + 'px';
      };
      hit.addEventListener('pointermove', at);
      hit.addEventListener('pointerdown', at);
      hit.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType === 'touch') return;
        tip.hidden = true; guide.setAttribute('visibility', 'hidden');
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      });
    };
    draw();
    charts.push(draw);
  }

  function kpis(container, items) {
    container.innerHTML = items.map((k) =>
      `<div class="kpi ${k.cls || ''}"><span>${esc(k.label)}</span><b>${esc(k.value)}</b>${k.sub ? `<small>${esc(k.sub)}</small>` : ''}</div>`).join('');
  }

  /* ---------------- sezioni ---------------- */

  function seriesStats(rows) {     // rows [[label, value]]
    const last = rows[rows.length - 1];
    const lastIdx = rows.length - 1;
    const yearAgo = rows[lastIdx - 12];
    const avg12 = rows.slice(-12).reduce((a, r) => a + r[1], 0) / Math.min(12, rows.length);
    let max = rows[0];
    for (const r of rows) if (r[1] > max[1]) max = r;
    return { last, yearAgo, avg12, max };
  }

  function renderPun() {
    const M = A().data().market;
    const now = new Date();
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const full = M.pun_monthly;
    // l'ultimo mese è parziale se è quello in corso: le KPI usano l'ultimo chiuso
    const closed = full.length && full[full.length - 1][0] === curKey ? full.slice(0, -1) : full;
    const st = seriesStats(closed);
    const partial = full.length !== closed.length ? full[full.length - 1] : null;
    kpis($('#punKpis'), [
      { label: `Ultimo mese chiuso`, value: `${f3(st.last[1])} €/kWh`, sub: ym(st.last[0]) },
      st.yearAgo ? { label: 'Un anno prima', value: pct(st.last[1] / st.yearAgo[1] - 1), sub: `${f3(st.yearAgo[1])} a ${ym(st.yearAgo[0])}`, cls: st.last[1] > st.yearAgo[1] ? 'up' : 'down' } : null,
      { label: 'Media 12 mesi', value: `${f3(st.avg12)} €/kWh` },
      partial ? { label: `${MESI_LUNGHI[+partial[0].slice(5) - 1]} finora`, value: `${f3(partial[1])} €/kWh`, sub: 'mese in corso' } : null,
      { label: 'Record', value: `${f3(st.max[1])} €/kWh`, sub: ym(st.max[0]) },
    ].filter(Boolean));

    const segEl = $('#punRange');
    const ranges = [['1y', '1 anno'], ['5y', '5 anni'], ['all', 'Dal 2005']];
    const state = A().state();
    segEl.innerHTML = ranges.map(([v, l]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${state.punRange === v}">${l}</button>`).join('');
    segEl.onclick = (e) => { const b = e.target.closest('button'); if (b) { A().update({ punRange: b.dataset.v }); } };
    const n = { '1y': 13, '5y': 61, all: full.length }[state.punRange] || 61;
    const rows = full.slice(-n);
    chart($('#punChart'), {
      aria: 'PUN mensile',
      labels: rows.map((r) => r[0]),
      series: [{ name: 'PUN', color: 'var(--c-pun)', values: rows.map((r) => r[1]), area: true }],
      refs: [{ y: st.avg12, label: `media 12 mesi ${f3(st.avg12)}` }],
      yFmt: (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 }),
      xFmt: (l) => (n <= 13 ? MESI[+l.slice(5) - 1] : (l.slice(5) === '01' ? l.slice(0, 4) : '')),
      xGap: n <= 13 ? 36 : 40,
      tipFmt: (l, i) => `<b>${ym(l)}${l === curKey ? ' (parziale)' : ''}</b><br>${f3(rows[i][1])} €/kWh`,
    });
  }

  function renderDaily() {
    const rows = A().data().market.pun_daily || [];
    if (!rows.length) { $('#punDaily').innerHTML = '<p class="hint">Dati giornalieri non disponibili.</p>'; $('#dailyKpis').innerHTML = ''; return; }
    const ma = rows.map((r, i) => {
      if (i < 29) return null;
      let s = 0; for (let k = i - 29; k <= i; k++) s += rows[k][1];
      return s / 30;
    });
    let mx = rows[0], mn = rows[0];
    for (const r of rows) { if (r[1] > mx[1]) mx = r; if (r[1] < mn[1]) mn = r; }
    const last = rows[rows.length - 1];
    kpis($('#dailyKpis'), [
      { label: 'Ultimo giorno', value: `${f3(last[1])} €/kWh`, sub: ymd(last[0]) },
      { label: 'Giorno più caro', value: `${f3(mx[1])} €/kWh`, sub: ymd(mx[0]), cls: 'up' },
      { label: 'Giorno più economico', value: `${f3(mn[1])} €/kWh`, sub: ymd(mn[0]), cls: 'down' },
    ]);
    chart($('#punDaily'), {
      aria: 'PUN giornaliero',
      labels: rows.map((r) => r[0]),
      series: [
        { name: 'PUN', color: 'var(--c-pun)', values: rows.map((r) => r[1]), width: 1.2, opacity: 0.55 },
        { name: 'media 30 gg', color: 'var(--c-pun)', values: ma, dash: true, width: 2.4 },
      ],
      yFmt: (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 }),
      xFmt: (l) => (l.slice(8) === '01' ? MESI[+l.slice(5, 7) - 1] : ''),
      xGap: 34,
      tipFmt: (l, i) => `<b>${ymd(l)}</b><br>${f3(rows[i][1])} €/kWh${ma[i] ? `<br><small>media 30 gg ${f3(ma[i])}</small>` : ''}`,
    });
  }

  function renderHourly() {
    const h = A().data().market.pun_hourly;
    if (!h) { $('#punHourly').innerHTML = '<p class="hint">Dati orari non disponibili.</p>'; return; }
    const wd = h.weekday, we = h.weekend;
    let mx = 0, mn = 0;
    wd.forEach((v, i) => { if (v > wd[mx]) mx = i; if (v < wd[mn]) mn = i; });
    $('#hourlyHint').textContent = `Prezzo medio ora per ora, dal ${ymd(h.from)} al ${ymd(h.to)}. Nei giorni feriali l'ora più cara è ${mx}-${mx + 1} (${f3(wd[mx])} €/kWh), la più economica ${mn}-${mn + 1} (${f3(wd[mn])}).`;
    chart($('#punHourly'), {
      aria: 'Profilo orario del PUN',
      labels: wd.map((_, i) => i),
      series: [
        { name: 'feriali', color: 'var(--c-pun)', values: wd, area: true },
        { name: 'weekend', color: 'var(--c-alt)', values: we, dash: true },
      ],
      yFmt: (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 }),
      xFmt: (l) => (l % 6 === 0 ? `${l}:00` : ''),
      tipFmt: (l, i) => `<b>${l}:00–${l + 1}:00</b><br>feriali ${wd[i] != null ? f3(wd[i]) : '—'}<br>weekend ${we[i] != null ? f3(we[i]) : '—'}`,
    });
  }

  function renderSeason() {
    const full = A().data().market.pun_monthly;
    const thisYear = new Date().getFullYear();
    const sums = new Array(12).fill(0), counts = new Array(12).fill(0);
    let y0 = Infinity, y1 = -Infinity;
    for (const [k, v] of full) {
      const y = +k.slice(0, 4), m = +k.slice(5) - 1;
      // 2022 (crisi) da solo sposta tutte le medie: escluso. Anno in corso escluso (parziale).
      if (y < 2014 || y === 2022 || y >= thisYear) continue;
      sums[m] += v; counts[m]++; y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : null));
    const cur = new Date().getMonth();
    let mx = 0, mn = 0;
    avg.forEach((v, i) => { if (v > avg[mx]) mx = i; if (v < avg[mn]) mn = i; });
    $('#seasonHint').textContent = `PUN medio per mese dell'anno, ${y0}–${y1} senza il 2022. Il mese più caro è ${MESI_LUNGHI[mx]}, il più economico ${MESI_LUNGHI[mn]}: aspettare l'autunno per cambiare contratto non conviene.`;
    chart($('#punSeason'), {
      aria: 'Stagionalità del PUN',
      kind: 'bar',
      labels: MESI,
      series: [{ name: 'media', color: 'var(--c-pun)', values: avg }],
      highlight: (i) => i === cur,
      yFmt: (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 }),
      xFmt: (l) => l,
      xGap: 30,
      tipFmt: (l, i) => `<b>${MESI_LUNGHI[i]}</b><br>media ${f3(avg[i])} €/kWh`,
    });
  }

  function renderPsv() {
    const rows = A().data().market.psv_monthly;
    const st = seriesStats(rows);
    kpis($('#psvKpis'), [
      { label: 'Ultimo mese', value: `${f3(st.last[1])} €/Smc`, sub: ym(st.last[0]) },
      st.yearAgo ? { label: 'Un anno prima', value: pct(st.last[1] / st.yearAgo[1] - 1), sub: `${f3(st.yearAgo[1])} a ${ym(st.yearAgo[0])}`, cls: st.last[1] > st.yearAgo[1] ? 'up' : 'down' } : null,
      { label: 'Media 12 mesi', value: `${f3(st.avg12)} €/Smc` },
      { label: 'Record', value: `${f3(st.max[1])} €/Smc`, sub: ym(st.max[0]) },
    ].filter(Boolean));
    chart($('#psvChart'), {
      aria: 'PSV mensile',
      labels: rows.map((r) => r[0]),
      series: [{ name: 'PSV', color: 'var(--c-psv)', values: rows.map((r) => r[1]), area: true }],
      refs: [{ y: st.avg12, label: `media 12 mesi ${f3(st.avg12)}` }],
      yFmt: (v) => v.toLocaleString('it-IT', { maximumFractionDigits: 2 }),
      xFmt: (l) => (l.slice(5) === '01' ? l.slice(0, 4) : ''),
      xGap: 40,
      tipFmt: (l, i) => `<b>${ym(l)}</b><br>${f3(rows[i][1])} €/Smc`,
    });
  }

  /* ---------------- curiosità ---------------- */

  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // Indice (PUN mono o PSV) al quale la variabile migliore costa come la fissa migliore.
  function breakeven(kind, bestFixedTotal) {
    const app = A();
    const costAt = (p) => {
      const rows = app.compute(kind, { market: true, scenario: 'custom', custom: p }).rows.filter((r) => r.o.t === 'V');
      return rows.length ? rows[0].total : Infinity;
    };
    let lo = kind === 'luce' ? 0.01 : 0.05, hi = kind === 'luce' ? 0.8 : 2.5;
    if (costAt(lo) >= bestFixedTotal) return { always: 'F' };
    if (costAt(hi) <= bestFixedTotal) return { always: 'V' };
    for (let k = 0; k < 32; k++) {
      const mid = (lo + hi) / 2;
      if (costAt(mid) < bestFixedTotal) lo = mid; else hi = mid;
    }
    return { p: (lo + hi) / 2 };
  }

  function energyPrice(o, kind, pr) {       // prezzo medio energia di una fissa sul profilo
    if (kind === 'gas') return o.p;
    if (o.m === 'mono') return o.p[0];
    if (o.m === 'bi') return o.p[0] * pr.f1 + o.p[1] * (pr.f2 + pr.f3);
    return o.p[0] * pr.f1 + o.p[1] * pr.f2 + o.p[2] * pr.f3;
  }

  function renderFacts() {
    const app = A();
    const D = app.data();
    const st = app.state();
    const kind = st.factsKind === 'gas' ? 'gas' : 'luce';
    const { nf0, eur } = app.fmt;
    for (const b of document.querySelectorAll('#factsSeg button')) b.setAttribute('aria-checked', String(b.dataset.v === kind));
    $('#factsSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) app.update({ factsKind: b.dataset.v }); };

    const P = D[kind].params;
    const unit = kind === 'luce' ? '€/kWh' : '€/Smc';
    const idxName = kind === 'luce' ? 'PUN' : 'PSV';
    const res12 = app.compute(kind, { market: true, scenario: '12m' });
    const rows = res12.rows;
    const pr = res12.pr;
    const resLast = app.compute(kind, { market: true, scenario: 'last' });
    const idx12 = kind === 'luce' ? P.pun_12m.mono : P.psv_12m;
    const idxLast = kind === 'luce' ? P.pun_last.mono : P.psv_last.value;
    const lastLabel = MESI_LUNGHI[+String(kind === 'luce' ? P.pun_last.month : P.psv_last.month).split('/')[0] - 1];
    const regione = st.regione ? (D.regioni[st.regione] || st.regione) : 'tutta Italia';
    $('#factsHint').textContent = kind === 'luce'
      ? `Calcolate sul tuo profilo: ${nf0.format(st.kwh)} kWh, ${String(st.kw).replace('.', ',')} kW, ${st.residente ? 'residente' : 'non residente'}, ${regione}. Le variabili usano il PUN medio degli ultimi 12 mesi, salvo dove indicato. Tocca un'offerta per i dettagli.`
      : `Calcolate sul tuo profilo: ${nf0.format(st.smc)} Smc l'anno, ${regione}. Le variabili usano il PSV medio degli ultimi 12 mesi, salvo dove indicato. Tocca un'offerta per i dettagli.`;
    if (!rows.length) { $('#facts').innerHTML = '<p class="hint">Nessuna offerta per questo profilo.</p>'; return; }

    const facts = [];
    const fixed = rows.filter((r) => r.o.t === 'F');
    const vars = rows.filter((r) => r.o.t === 'V');
    const varsLast = resLast.rows.filter((r) => r.o.t === 'V');
    const listOf = (arr, extra) => arr.map((r) => ({ r, extra: extra ? extra(r) : null }));

    // 1. fisse o variabili
    if (fixed.length && vars.length) {
      const bF = fixed[0], bV = vars[0], bVL = varsLast[0];
      facts.push({
        icon: '⚖️', title: 'Fissa o variabile?',
        big: bV.total < bF.total ? 'Oggi vince la variabile' : 'Oggi vince la fissa',
        text: `Con il ${idxName} medio dei 12 mesi (${f3(idx12)} ${unit}) la variabile migliore costa ${eur(bV.total)} l'anno, la fissa migliore ${eur(bF.total)}. Ma se il ${idxName} restasse al livello di ${lastLabel} (${f3(idxLast)}), la variabile migliore costerebbe ${eur(bVL.total)}.`,
        list: listOf([bF, bV], (r) => (r.o.t === 'F' ? 'fissa migliore' : 'variabile migliore')
          + (r.c.fissoVenditore > 0 && r.c.fissoVenditore < P.suspicious_fix_annual ? ' · ⚠ quota fissa sospetta' : '')),
      });
      // 2. pareggio
      const be = breakeven(kind, bF.total);
      if (be.p) {
        const A_ = aMese(lastLabel); const At = A_[0].toUpperCase() + A_.slice(1);
        const vs = idxLast > be.p ? `${At} era ${f3(idxLast)}: sopra.` : `${At} era ${f3(idxLast)}: sotto.`;
        facts.push({
          icon: '🎯', title: 'Il prezzo di pareggio',
          big: `${f3(be.p)} ${unit}`,
          text: `È il ${idxName} medio al quale la variabile migliore costa come la fissa migliore. Se pensi che nei prossimi mesi starà sopra, conviene bloccare il prezzo. ${vs} La media dei 12 mesi è ${f3(idx12)}.`,
        });
      }
    }

    // 3. forbice — senza gli errori evidenti nei dati (oltre 5 volte la mediana:
    // un €/kWh pubblicato come €/MWh dà totali da centinaia di migliaia di euro)
    const totals = rows.map((r) => r.total);
    const q1 = quantile(totals, 0.25), q3 = quantile(totals, 0.75), med = quantile(totals, 0.5);
    const isError = (r) => r.total > 5 * med;
    const sane = rows.filter((r) => !isError(r));
    const nErr = rows.length - sane.length;
    const worst = sane[sane.length - 1];
    facts.push({
      icon: '↔️', title: 'La forbice',
      big: `${(worst.total / sane[0].total).toLocaleString('it-IT', { maximumFractionDigits: 1 })} volte`,
      text: `Tanto costa l'offerta più cara rispetto alla più economica: ${eur(worst.total)} contro ${eur(sane[0].total)} l'anno, per la stessa ${kind === 'luce' ? 'energia' : 'quantità di gas'}. Metà delle ${nf0.format(rows.length)} offerte sta tra ${eur(q1)} e ${eur(q3)}.${nErr ? ` Escluse ${nErr} con un errore evidente nei dati (sotto, in "Fuori scala").` : ''}`,
    });

    // 4. fuori scala
    const fence = q3 + 3 * (q3 - q1);
    const outl = rows.filter((r) => r.total > fence);
    facts.push({
      icon: '🚩', title: 'Fuori scala',
      big: outl.length ? `${nf0.format(outl.length)} offerte` : 'Nessuna',
      text: outl.length
        ? `Costano più di ${eur(fence)} l'anno, molto oltre il resto del mercato (la mediana è ${eur(med)}). Le tre più care:`
        : `Nessuna offerta è molto oltre il resto del mercato (mediana ${eur(med)}). Le tre più care:`,
      list: listOf(rows.slice(-3).reverse(), (r) => (isError(r) ? 'quasi certamente un errore nei dati del venditore' : `${pct(r.total / med - 1)} sulla mediana`)),
    });

    // 5. quote fisse sospette
    const susp = rows.filter((r) => r.c.fissoVenditore > 0 && r.c.fissoVenditore < P.suspicious_fix_annual);
    if (susp.length) {
      facts.push({
        icon: '🧐', title: 'Quote fisse sospette',
        big: `${nf0.format(susp.length)} offerte`,
        text: `Dichiarano una quota fissa tra 0 e ${nf0.format(P.suspicious_fix_annual)} € l'anno. Spesso è un errore del venditore, che scrive al mese una cifra che il portale legge all'anno: in classifica sembrano più convenienti di quanto sono.`,
        list: listOf(susp.slice(0, 4), (r) => `${A().fmt.eur2(r.c.fissoVenditore)}/anno dichiarati`),
      });
    }

    // 6. fisse sotto l'ingrosso
    const wholesale = kind === 'luce'
      ? (P.pun_last.f1 * pr.f1 + P.pun_last.f2 * pr.f2 + P.pun_last.f3 * pr.f3) * P.lambda
      : P.psv_last.value;
    const under = fixed.filter((r) => energyPrice(r.o, kind, pr) < wholesale);
    if (under.length) {
      facts.push({
        icon: '🏷️', title: `Fisse sotto il prezzo all'ingrosso`,
        big: `${nf0.format(under.length)} offerte`,
        text: `Vendono l'energia a meno di quanto costava all'ingrosso ${aMese(lastLabel)} (${f3(wholesale)} ${unit}${kind === 'luce' ? ', perdite di rete incluse' : ''}). Sono prezzi decisi prima del rialzo o coperti in anticipo: di solito il venditore li ritira presto.`,
        list: listOf(under.slice(0, 4), (r) => `${f3(energyPrice(r.o, kind, pr))} ${unit}${r.o.al ? ` · fino al ${ymd(r.o.al)}` : ''}`),
      });
    }

    // 7. spread negativi e spread zero
    const spreadMin = (o) => (kind === 'luce' ? Math.min(...o.p) : o.p);
    const neg = vars.filter((r) => spreadMin(r.o) < 0);
    const zero = vars.filter((r) => (kind === 'luce' ? r.o.p.every((v) => v === 0) : r.o.p === 0));
    if (neg.length) {
      facts.push({
        icon: '🎁', title: 'Spread negativo',
        big: `${nf0.format(neg.length)} offerte`,
        text: `Variabili che vendono sotto il ${idxName}: il venditore recupera con la quota fissa o con altre voci. Guarda il totale, non lo spread.`,
        list: listOf(neg.slice(0, 4), (r) => `spread ${f3(spreadMin(r.o))} ${unit}`),
      });
    }
    if (vars.length) {
      facts.push({
        icon: '0️⃣', title: 'Spread zero',
        big: `${Math.round((100 * zero.length) / vars.length)}% delle variabili`,
        text: `${nf0.format(zero.length)} offerte variabili su ${nf0.format(vars.length)} non aggiungono nulla al ${idxName}: il venditore guadagna solo sulla quota fissa. Fra queste la migliore costa ${zero.length ? eur(zero[0].total) : '—'} l'anno.`,
        list: zero.length ? listOf(zero.slice(0, 1), () => 'la migliore a spread zero') : null,
      });
    }

    // 8. in scadenza fra le prime 20
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const soon = rows.slice(0, 20).filter((r) => {
      if (!r.o.al) return false;
      const d = new Date(r.o.al + 'T00:00:00');
      return (d - today) / 86400000 <= 7;
    });
    facts.push({
      icon: '⏳', title: 'Scadono a breve',
      big: soon.length ? `${soon.length} delle prime 20` : 'Nessuna delle prime 20',
      text: soon.length
        ? 'Si possono sottoscrivere ancora per al massimo 7 giorni, poi il venditore pubblica un listino nuovo, spesso più caro.'
        : 'Nessuna delle 20 offerte più economiche smette di essere sottoscrivibile nei prossimi 7 giorni.',
      list: soon.length ? listOf(soon.slice(0, 5), (r) => `fino al ${ymd(r.o.al)}`) : null,
    });

    // 9. venditori
    const byV = new Map();
    for (const r of rows) byV.set(r.o.v || '—', (byV.get(r.o.v || '—') || 0) + 1);
    const topV = [...byV.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const regional = rows.filter((r) => r.o.r.length).length;
    facts.push({
      icon: '🏢', title: 'Chi vende',
      big: `${nf0.format(byV.size)} venditori`,
      text: `I più presenti: ${topV.map(([v, c]) => `${v} (${c} offerte)`).join(', ')}. ${Math.round((100 * regional) / rows.length)}% delle offerte vale solo in alcune regioni.`,
    });

    const box = $('#facts');
    box.innerHTML = facts.map((f, fi) => `<article class="fact card">
        <div class="fact-head"><span class="fact-icon" aria-hidden="true">${f.icon}</span><h3>${esc(f.title)}</h3></div>
        <b class="fact-big">${esc(f.big)}</b>
        <p>${esc(f.text)}</p>
        ${f.list && f.list.length ? `<ul class="fact-list">${f.list.map((it, li) => {
          const pos = rows.indexOf(it.r);
          return `<li><button type="button" data-f="${fi}" data-l="${li}"><span class="fl-name">${esc(it.r.o.n)}</span><span class="fl-meta">${esc(it.r.o.v || '')}${it.extra ? ' · ' + esc(it.extra) : ''}</span><span class="fl-val">${eur(it.r.total)}${pos >= 0 ? `<small>${pos + 1}°</small>` : ''}</span></button></li>`;
        }).join('')}</ul>` : ''}
      </article>`).join('');
    box.onclick = (e) => {
      const b = e.target.closest('button[data-f]'); if (!b) return;
      const it = facts[+b.dataset.f].list[+b.dataset.l];
      const pos = rows.indexOf(it.r);
      if (pos >= 0) app.openRow(kind, it.r, pos, rows);
      else {   // riga da un altro scenario (es. ultimo mese): apri sullo scenario dei 12 mesi
        const p2 = rows.findIndex((r) => r.o.id === it.r.o.id);
        if (p2 >= 0) app.openRow(kind, rows[p2], p2, rows);
      }
    };
  }

  function footer() {
    const D = A().data();
    const M = D.market;
    $('#marketFoot').innerHTML =
      (M.warnings && M.warnings.length ? `<div class="warnbox">${M.warnings.map(esc).join(' · ')}</div>` : '') +
      `<p>Fonti: PUN mensile, giornaliero e orario dall'API Esiti del <a href="https://www.mercatoelettrico.org/" target="_blank" rel="noopener">GME</a>; PSV: ${esc(D.gas.params.psv_sources)}. Valori in €/kWh e €/Smc, IVA e altre voci escluse: sono prezzi all'ingrosso, non quello che si paga in bolletta.</p>`;
  }

  function render() {
    if (!ready) return;
    charts.length = 0;
    renderPun();
    renderDaily();
    renderHourly();
    renderSeason();
    renderPsv();
    renderFacts();
    footer();
  }

  let rz = 0;
  window.addEventListener('resize', () => {
    if (!ready || A().state().kind !== 'mercato') return;
    clearTimeout(rz);
    rz = setTimeout(() => charts.forEach((d) => d()), 150);
  });

  window.EnergyMarket = {
    ready() { ready = true; if (A().state().kind === 'mercato') render(); },
    render,
  };
})();
