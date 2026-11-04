/*
 * analisi.js — i grafici interattivi dell'articolo "Fisso o variabile" (analisi.html).
 *
 * Leggono i dati veri del comparatore che stanno accanto alla pagina:
 * offers.json (offerte di oggi, PUN/PSV, serie di mercato) e history/ (i 58
 * snapshot mensili della macchina del tempo), e fanno i conti con engine.js,
 * lo stesso motore della classifica. Si aggiornano quindi a ogni pubblicazione.
 *
 * I grafici usano una copia fedele del Panel di
 * data/energy/market-study-2026-11/article/build.py: stesse classi CSS, stessi
 * margini, stesse larghezze (680 px desktop, 380 px telefono). Chi cambia uno
 * dei due deve cambiare anche l'altro, o i grafici vivi stonano con quelli fissi.
 *
 * Senza i dati accanto (pagina aperta da sola) ogni widget mostra un rimando
 * alla versione pubblicata, e il resto dell'articolo resta leggibile.
 *
 * In node esporta le funzioni di calcolo per i test (tests/test_web_time_machine.py).
 */
(function (root, factory) {
  const api = factory(root.EnergyEngine || (typeof require === 'function' ? require('./engine.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EnergyArticle = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const PUBLISHED = 'https://tools.ruffilli.it/energy-offers/analisi.html';
  const DESKTOP_W = 680, PHONE_W = 380;
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const MESI_LUNGHI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto',
    'settembre', 'ottobre', 'novembre', 'dicembre'];
  // Profilo dello studio (utente tipo) e soglia della quota fissa "bassa o nulla".
  const STD = { kwh: 2700, smc: 1400 };
  const LOW_FEE = 36;

  /* ---------------- formattazione, come build.py ---------------- */

  function it(x, d) {
    d = d || 0;
    const neg = x < 0;
    const s = Math.abs(x).toFixed(d);
    let [i, f] = s.split('.');
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + i + (f ? ',' + f : '');
  }
  const signed = (x, d) => (x > 0 ? '+' : x < 0 ? '−' : '') + it(Math.abs(x), d);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (v) => v.toFixed(1);
  const tyear = (m) => { const [y, mm] = m.slice(0, 7).split('-').map(Number); return y + (mm - 1) / 12; };
  const monthName = (m) => { const [y, mm] = m.split('-'); return `${MESI_LUNGHI[+mm - 1]} ${y}`; };
  const monthShort = (m) => { const [y, mm] = m.split('-'); return `${MESI[+mm - 1]} ${y}`; };
  // chiavi 'M/YYYY' dei parametri (pun_last.month) → 'YYYY-MM'
  const isoMonth = (k) => { const [m, y] = String(k).split('/'); return `${y}-${String(m).padStart(2, '0')}`; };

  /* ---------------- SVG: copia del Panel di build.py ---------------- */

  class Panel {
    constructor(W, H, xr, yr, o) {
      o = o || {};
      this.W = W; this.H = H; this.oy = o.oy || 0;
      [this.x0, this.x1] = xr; [this.y0, this.y1] = yr;
      this.ml = o.ml ?? 48; this.mr = o.mr ?? 12; this.mt = o.mt ?? 26; this.mb = o.mb ?? 26;
      this.fs = o.fs ?? 13;
      this.out = [];
    }
    X(x) { return this.ml + (x - this.x0) / (this.x1 - this.x0) * (this.W - this.ml - this.mr); }
    Y(y) { return this.oy + this.mt + (this.y1 - y) / (this.y1 - this.y0) * (this.H - this.mt - this.mb); }
    get top() { return this.oy + this.mt; }
    get bottom() { return this.oy + this.H - this.mb; }
    title(t) {
      this.out.push(`<text class="pt" x="${f1(this.ml > 40 ? this.ml - 40 : 2)}" y="${f1(this.oy + this.fs + 2)}" font-size="${this.fs + 1}">${esc(t)}</text>`);
    }
    yaxis(ticks, fmt, zeroLine) {
      zeroLine = zeroLine !== false;
      for (const v of ticks) {
        const y = this.Y(v);
        const cls = v === 0 && zeroLine ? 'zero' : 'grid';
        this.out.push(`<line class="${cls}" x1="${this.ml}" x2="${this.W - this.mr}" y1="${f1(y)}" y2="${f1(y)}"/>`);
        this.out.push(`<text class="tick" x="${this.ml - 6}" y="${f1(y + this.fs * 0.35)}" text-anchor="end" font-size="${this.fs}">${esc(fmt(v))}</text>`);
      }
    }
    xaxis(ticks) {
      const y = this.bottom;
      this.out.push(`<line class="axis" x1="${this.ml}" x2="${this.W - this.mr}" y1="${f1(y)}" y2="${f1(y)}"/>`);
      for (const [v, label] of ticks) {
        const x = this.X(v);
        this.out.push(`<line class="axis" x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y)}" y2="${f1(y + 4)}"/>`);
        this.out.push(`<text class="tick" x="${f1(x)}" y="${f1(y + this.fs + 5)}" text-anchor="middle" font-size="${this.fs}">${esc(label)}</text>`);
      }
    }
    line(pts, cls) {
      let seg = [];
      for (const [x, y] of pts.concat([[null, null]])) {
        if (y == null) {
          if (seg.length > 1) this.out.push(`<polyline class="${cls}" points="${seg.map(([a, b]) => `${f1(a)},${f1(b)}`).join(' ')}" />`);
          seg = [];
        } else seg.push([this.X(x), this.Y(y)]);
      }
    }
    bar(xc, w, ya, yb, cls) {
      const x = this.X(xc - w / 2), ww = this.X(xc + w / 2) - x;
      const [y1, y2] = [this.Y(ya), this.Y(yb)].sort((a, b) => a - b);
      this.out.push(`<rect class="${cls}" x="${f1(x)}" y="${f1(y1)}" width="${f1(Math.max(ww, 0.8))}" height="${f1(Math.max(y2 - y1, 0.3))}" />`);
    }
    band(ya, yb, cls) {
      let [y1, y2] = [this.Y(ya), this.Y(yb)].sort((a, b) => a - b);
      y1 = Math.max(y1, this.top); y2 = Math.min(y2, this.bottom);
      this.out.push(`<rect class="${cls}" x="${this.ml}" y="${f1(y1)}" width="${this.W - this.ml - this.mr}" height="${f1(y2 - y1)}"/>`);
    }
    hline(v, cls) {
      const y = this.Y(v);
      this.out.push(`<line class="${cls}" x1="${this.ml}" x2="${this.W - this.mr}" y1="${f1(y)}" y2="${f1(y)}"/>`);
    }
    vline(v, cls) {
      const x = this.X(v);
      this.out.push(`<line class="${cls}" x1="${f1(x)}" x2="${f1(x)}" y1="${f1(this.top)}" y2="${f1(this.bottom)}"/>`);
    }
    dot(x, y, cls, r) {
      this.out.push(`<circle class="${cls}" cx="${f1(this.X(x))}" cy="${f1(this.Y(y))}" r="${r || 3.5}"/>`);
    }
    text(x, y, s, cls, anchor, dx, dy, size) {
      const fs = size || this.fs - 1;
      this.out.push(`<text class="${cls || 'ann'}" x="${f1(this.X(x) + (dx || 0))}" y="${f1(this.Y(y) + (dy || 0))}" text-anchor="${anchor || 'start'}" font-size="${fs}">${esc(s)}</text>`);
    }
    textPx(px, py, s, cls, anchor, size) {
      const fs = size || this.fs - 1;
      this.out.push(`<text class="${cls || 'ann'}" x="${f1(px)}" y="${f1(py)}" text-anchor="${anchor || 'start'}" font-size="${fs}">${esc(s)}</text>`);
    }
  }

  function svg(W, H, panels, label) {
    return `<svg viewBox="0 0 ${W} ${Math.round(H)}" width="100%" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${panels.map((p) => p.out.join('\n')).join('\n')}</svg>`;
  }

  // Barre orizzontali nello stile di "Quanto si perde con quattro modi di scegliere":
  // rows = [{label, bars: [{v, cls, txt}]}].
  function hbars(W, rows, xmax, xticks, label, opts) {
    opts = opts || {};
    const phone = W < 500;
    const fs = phone ? 12 : 13;
    const ml = opts.ml || (phone ? 150 : 190);
    const per = rows[0].bars.length;
    const rowh = 12 + per * 17 + 6;
    const H = 30 + rowh * rows.length + 30;
    const p = new Panel(W, H, [0, xmax], [0, 1], { ml, mr: 56, mt: 10, mb: 30, fs });
    p.xaxis(xticks.map((v) => [v, it(v)]));
    for (const v of xticks.slice(1)) {
      const x = p.X(v);
      p.out.push(`<line class="grid" x1="${f1(x)}" x2="${f1(x)}" y1="${p.top}" y2="${p.bottom}"/>`);
    }
    rows.forEach((row, i) => {
      const yc = p.top + 10 + i * rowh;
      p.textPx(ml - 8, yc + 15, row.label, 'tick strong', 'end', fs);
      row.bars.forEach((b, j) => {
        const y = yc + j * 17, x0 = p.X(0), v = Math.max(0, Math.min(b.v, xmax));
        p.out.push(`<rect class="${b.cls}" x="${f1(x0)}" y="${f1(y)}" width="${f1(Math.max(p.X(v) - x0, 0.8))}" height="14"/>`);
        p.textPx(p.X(v) + 5, y + 11.5, b.txt, 'ann', 'start', fs - 1);
      });
    });
    return svg(W, H, [p], label);
  }

  const niceMax = (v, steps) => {
    const raw = Math.max(v, 1) / steps;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = [1, 2, 2.5, 5, 10].find((k) => k * mag >= raw) * mag;
    return n * steps;
  };
  const ticksTo = (max, steps) => Array.from({ length: steps + 1 }, (_, i) => max / steps * i);

  /* ---------------- calcolo: offerte come le vede lo studio ---------------- */

  function oddFloor(kind, P) {
    if (P.implausible_floor) return P.implausible_floor * (P.implausible_ratio || 0.5);
    if (kind === 'luce') return 0.5 * Math.min(P.pun_12m.mono, P.pun_last.mono) * P.lambda;
    return 0.5 * Math.min(P.psv_12m, P.psv_last.value);
  }

  function profile(kind, amount, P) {
    if (kind === 'luce') return { kwh: amount, kw: 3, residente: true, f1: 0.33, f2: 0.31, f3: 0.36 };
    return { smc: amount, reteFix: P.rete_fix_monthly, reteVar: P.rete_var_per_smc };
  }

  function eligible(o, kind, pr) {
    if (o.so === 0) return false;                                       // solo in coppia
    if (o.r.length || (o.pr && o.pr.length) || (o.cm && o.cm.length)) return false;   // zona limitata
    const amount = kind === 'luce' ? pr.kwh : pr.smc;
    if (o.cmin > 0 && amount < o.cmin) return false;
    if (o.cmax > 0 && amount > o.cmax) return false;
    if (kind === 'luce') {
      if (o.dr === '02') return false;                                  // solo non residenti
      if (o.pmin > 0 && pr.kw < o.pmin) return false;
      if (o.pmax > 0 && pr.kw > o.pmax) return false;
    }
    return true;
  }

  /*
   * Offerte nazionali, vendibili da sole, plausibili, deduplicate (varianti
   * regionali con stesso nome, prezzo e quota), ordinate per costo annuo.
   * params: il set di parametri da usare (allora, poi o di oggi); index: 'last'
   * per prezzare le variabili all'indice dell'ultimo mese.
   */
  function rankOffers(block, kind, amount, params, index) {
    const P = params || block.params;
    const pr = profile(kind, amount, P);
    const idx = kind === 'luce' ? E.punIndex(P, index || '12m') : E.psvIndex(P, index || '12m');
    const floor = oddFloor(kind, block.params);
    const seen = new Set(), rows = [];
    for (const o of block.offers) {
      if (!eligible(o, kind, pr)) continue;
      const key = [o.n, o.v, JSON.stringify(o.p), o.fx, o.fk || 0, o.t].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const c = kind === 'luce' ? E.costLuce(o, P, pr, idx) : E.costGas(o, P, pr, idx);
      if (o.t === 'F' && c.energia / amount < floor) continue;
      rows.push({ o, total: c.total, fee: c.fissoVenditore });
    }
    rows.sort((a, b) => a.total - b.total);
    return rows;
  }

  const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];

  // Widget 2: distanze dalla migliore offerta.
  function shoppingGaps(block, kind, amount) {
    const rows = rankOffers(block, kind, amount);
    const t = rows.map((r) => r.total);
    return { best: rows[0], n: rows.length, tenth: t[Math.min(9, t.length - 1)], median: quantile(t, 0.5),
             p75: quantile(t, 0.75), p90: quantile(t, 0.9) };
  }

  // Widget 1: segnale fisso/variabile sulle offerte di oggi.
  function todaySignal(block, kind) {
    const P = block.params, amount = STD[kind === 'luce' ? 'kwh' : 'smc'];
    const ratio = kind === 'luce' ? P.pun_last.mono / P.pun_12m.mono : P.psv_last.value / P.psv_12m;
    const r12 = rankOffers(block, kind, amount, P, '12m'), rl = rankOffers(block, kind, amount, P, 'last');
    const f = r12.find((r) => r.o.t === 'F'), v12 = r12.find((r) => r.o.t === 'V'), vl = rl.find((r) => r.o.t === 'V');
    if (!f || !v12 || !vl) return null;
    return Object.assign({ ratio, f, v12, vl, lastMonth: isoMonth(kind === 'luce' ? P.pun_last.month : P.psv_last.month) },
      E.fixVarSignal(ratio, f.total, v12.total, vl.total));
  }

  // Widget 3: migliore fissa e variabile di uno snapshot storico, allora e col senno di poi.
  function monthOutcome(snapshot, kind) {
    const block = snapshot[kind], amount = STD[kind === 'luce' ? 'kwh' : 'smc'];
    const best = (rows, t) => rows.find((r) => r.o.t === t) || null;
    const then = rankOffers(block, kind, amount, block.params);
    const out = { then: { F: best(then, 'F'), V: best(then, 'V') }, poi: null,
                  months: block.params_hindsight ? block.params_hindsight.months : 0 };
    if (block.params_hindsight) {
      const poi = rankOffers(block, kind, amount, block.params_hindsight);
      // stesse offerte di "allora", prezzate col senno di poi (come time_machine.py)
      const tot = (r) => r && poi.find((x) => x.o.id === r.o.id);
      out.poi = { F: tot(out.then.F), V: tot(out.then.V), bestF: best(poi, 'F'), bestV: best(poi, 'V') };
    }
    return out;
  }

  // Widget 4: costo in più della migliore con quota bassa e della migliore con quota alta.
  function breakEvenCurve(block, kind, xs) {
    const pts = xs.map((x) => {
      const rows = rankOffers(block, kind, x);
      const low = rows.find((r) => r.fee <= LOW_FEE), high = rows.find((r) => r.fee > LOW_FEE);
      if (!low || !high) return null;
      const best = rows[0].total;
      return { x, low: low.total - best, high: high.total - best, lowRow: low, highRow: high };
    }).filter(Boolean);
    let cross = null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1].low - pts[i - 1].high, b = pts[i].low - pts[i].high;
      if (a <= 0 && b > 0) { cross = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * (-a) / (b - a); break; }
    }
    return { pts, cross };
  }

  // Ultimo mese CHIUSO di una serie [[YYYY-MM, v]]: la serie GME include il mese in corso, parziale.
  function closedSeries(series, generatedAt) {
    const cur = String(generatedAt || '').slice(0, 7);
    return series.filter(([m]) => !cur || m < cur);
  }

  /* ---------------- disegno dei widget ---------------- */

  function wholesaleChart(pun, psv, W) {
    const phone = W < 500;
    const fs = phone ? 12 : 13;
    const lastYear = +pun[pun.length - 1][0].slice(0, 4);
    const xEnd = tyear(pun[pun.length - 1][0]) + 1 / 12;   // come build.py: (2005, 2026 + 10/12) con ottobre ultimo
    const H1 = phone ? 250 : 260;
    const a = new Panel(W, H1, [2005, xEnd], [0, 0.6], { ml: 44, fs });
    a.title('PUN, elettricità · €/kWh');
    a.yaxis([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6], (v) => it(v, 1));
    const yt = [];
    for (let y = 2005; y <= lastYear - 1; y += phone ? 5 : 2) yt.push([y, String(y)]);
    a.xaxis(yt);
    a.line(pun.map(([k, v]) => [tyear(k), v]), 'ln c1');
    const peak = pun.reduce((m, kv) => (kv[1] > m[1] ? kv : m));
    a.dot(tyear(peak[0]), peak[1], 'dt c1');
    a.text(tyear(peak[0]), peak[1], `${monthShort(peak[0])}: ${it(peak[1], 3)}`, 'ann', 'end', -8, 6);
    const last = pun[pun.length - 1];
    a.dot(tyear(last[0]), last[1], 'dt c1');
    if (phone) a.text(tyear(last[0]), last[1], it(last[1], 3), 'ann', 'end', -7, -6);
    else a.text(tyear(last[0]), last[1], `${monthShort(last[0])}: ${it(last[1], 3)}`, 'ann', 'end', -6, -10);
    const H2 = 230;
    const b = new Panel(W, H2, [2020, tyear(psv[psv.length - 1][0]) + 1 / 12], [0, 2.5], { oy: H1 + 6, ml: 44, fs });
    b.title('PSV, gas · €/Smc');
    b.yaxis([0, 0.5, 1.0, 1.5, 2.0, 2.5], (v) => it(v, 1));
    const gt = [];
    for (let y = 2020; y <= +psv[psv.length - 1][0].slice(0, 4); y++) gt.push([y, phone ? `’${String(y % 100).padStart(2, '0')}` : String(y)]);
    b.xaxis(gt);
    b.line(psv.map(([k, v]) => [tyear(k), v]), 'ln c2');
    const pg = psv.reduce((m, kv) => (kv[1] > m[1] ? kv : m));
    b.dot(tyear(pg[0]), pg[1], 'dt c2');
    b.text(tyear(pg[0]), pg[1], `${monthShort(pg[0])}: ${it(pg[1], 2)}`, 'ann', 'start', 8, 5);
    const lg = psv[psv.length - 1];
    b.dot(tyear(lg[0]), lg[1], 'dt c2');
    b.text(tyear(lg[0]), lg[1], `${monthShort(lg[0])}: ${it(lg[1], 3)}`, 'ann', 'end', -6, -10);
    return svg(W, H1 + H2 + 6, [a, b], "Prezzo all'ingrosso mensile di luce (PUN) e gas (PSV)");
  }

  function gaugeChart(ratio, label, cls, W) {
    const phone = W < 500;
    const fs = phone ? 12 : 13;
    const p = new Panel(W, 86, [0.3, 2.8], [0, 1], { ml: 12, mr: 12, mt: 14, mb: 26, fs });
    p.out.push(`<rect class="zone-down" x="${f1(p.X(0.3))}" y="${f1(p.top)}" width="${f1(p.X(1 / 1.2) - p.X(0.3))}" height="${f1(p.bottom - p.top)}"/>`);
    p.out.push(`<rect class="zone-up" x="${f1(p.X(1.2))}" y="${f1(p.top)}" width="${f1(p.X(2.8) - p.X(1.2))}" height="${f1(p.bottom - p.top)}"/>`);
    p.vline(1.0, 'ref');
    p.xaxis([[0.5, '0,5'], [0.83, '0,83'], [1.2, '1,2'], [1.6, '1,6'], [2.0, '2,0'], [2.4, '2,4']]);
    const r = Math.max(0.3, Math.min(2.8, ratio));
    p.dot(r, 0.5, 'dt ' + cls, 6);
    p.text(r, 0.5, `${label} ${it(ratio, 2)}`, 'ann strong', r > 2.2 ? 'end' : 'start', r > 2.2 ? -10 : 10, 4, fs);
    p.textPx(p.X(0.3) + 4, p.top + fs - 1, 'variabile', 'ann muted', 'start', fs - 2);
    p.textPx(p.X(2.8) - 4, p.top + fs - 1, 'fisso', 'ann muted', 'end', fs - 2);
    return svg(W, 86, [p], `Segnale ${label}: ${it(ratio, 2)}`);
  }

  function lineChart(curve, kind, W) {
    const phone = W < 500;
    const fs = phone ? 12 : 13;
    const xs = curve.pts.map((p) => p.x);
    const ymax = niceMax(Math.max(...curve.pts.map((p) => Math.max(p.low, p.high))), 4);
    const p = new Panel(W, 250, [xs[0], xs[xs.length - 1]], [0, ymax], { ml: 46, mr: 26, fs });
    p.title(`€ l'anno in più della migliore offerta · ${kind === 'luce' ? 'kWh' : 'Smc'} l'anno in basso`);
    p.yaxis(ticksTo(ymax, 4), (v) => it(v));
    const step = kind === 'luce' ? (phone ? 2000 : 1000) : (phone ? 1000 : 500);
    const xt = [];
    for (let x = Math.ceil(xs[0] / step) * step; x <= xs[xs.length - 1]; x += step) xt.push([x, it(x)]);
    p.xaxis(xt);
    p.line(curve.pts.map((q) => [q.x, q.low]), 'ln c3');
    p.line(curve.pts.map((q) => [q.x, q.high]), 'ln c1');
    if (curve.cross) {
      p.vline(curve.cross, 'ref');
      p.text(curve.cross, ymax, `pareggio ≈ ${it(Math.round(curve.cross / 50) * 50)}`, 'ann', curve.cross > (xs[0] + xs[xs.length - 1]) / 2 ? 'end' : 'start', curve.cross > (xs[0] + xs[xs.length - 1]) / 2 ? -6 : 6, fs + 2);
    }
    return svg(W, 250, [p], 'Quota fissa bassa contro quota fissa alta, al variare del consumo');
  }

  /* ---------------- browser ---------------- */

  function both(el, fn) {
    el.querySelector('.chart-d').innerHTML = fn(DESKTOP_W);
    el.querySelector('.chart-m').innerHTML = fn(PHONE_W);
  }

  function seg(el, items, cur, onPick) {
    el.innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === cur}">${esc(l)}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
  }

  function unavailable(why) {
    for (const el of document.querySelectorAll('.widget')) {
      el.querySelector('.wbody').innerHTML = `<p class="wnote">Questo grafico interattivo legge le offerte del comparatore${why ? ` (${esc(why)})` : ''}. Lo trovi nella <a href="${PUBLISHED}">versione pubblicata dell'articolo</a>.</p>`;
    }
  }

  function widgetToday(D) {
    const el = document.getElementById('w-oggi');
    if (!el) return;
    const cards = ['luce', 'gas'].map((kind) => {
      const s = todaySignal(D[kind], kind);
      if (!s) return '';
      const idx = kind === 'luce' ? 'PUN' : 'PSV', cls = kind === 'luce' ? 'c1' : 'c2';
      const head = s.regime === 'calm' ? 'mercato calmo, fisso e variabile si equivalgono'
        : s.choice === 'F' ? 'il segnale indica il fisso' : 'il segnale indica il variabile';
      const rows = [
        { label: 'Fissa migliore', bars: [{ v: s.f.total, cls: 'b3', txt: `${it(s.f.total)} €` }] },
        { label: 'Variabile, in classifica', bars: [{ v: s.v12.total, cls: 'b1', txt: `${it(s.v12.total)} €` }] },
        { label: `Variabile, al ${idx} di ${MESI[+s.lastMonth.slice(5) - 1]}`, bars: [{ v: s.vl.total, cls: 'b2', txt: `${it(s.vl.total)} €` }] },
      ];
      const xmax = niceMax(Math.max(s.f.total, s.v12.total, s.vl.total) * 1.08, 4);
      return `<div class="wcard"><div class="wcard-head"><b>${kind === 'luce' ? 'Luce' : 'Gas'}</b>: ${esc(head)}</div>
        <div class="chart chart-d">${gaugeChart(s.ratio, idx, cls, DESKTOP_W)}${hbars(DESKTOP_W, rows, xmax, ticksTo(xmax, 4), 'Costo annuo')}</div>
        <div class="chart chart-m">${gaugeChart(s.ratio, idx, cls, PHONE_W)}${hbars(PHONE_W, rows, xmax, ticksTo(xmax, 2), 'Costo annuo')}</div>
        <p class="wtext">Il ${idx} di ${monthName(s.lastMonth)} vale ${it(s.ratio, 2)} volte la media dei 12 mesi su cui il portale calcola la classifica. A quel prezzo la variabile migliore costerebbe ${it(s.vl.total)} € l'anno invece di ${it(s.v12.total)} €. La fissa migliore, ${esc(s.f.o.n)}, costa ${it(s.f.total)} €${s.premium > E.PREMIUM_CAP ? `, il ${Math.round(s.premium * 100)}% sopra la variabile in classifica` : ''}.</p></div>`;
    }).join('');
    el.querySelector('.wbody').innerHTML = cards + `<p class="wnote">Offerte nazionali di ${esc(dayOf(D))}, utente tipo (${it(STD.kwh)} kWh, ${it(STD.smc)} Smc). Si aggiorna a ogni pubblicazione del comparatore.</p>`;
  }

  const dayOf = (D) => {
    const d = new Date(D.generated_at);
    return isNaN(d) ? D.generated_at : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  function widgetShopping(D) {
    const el = document.getElementById('w-cercare');
    if (!el) return;
    const st = { kind: 'luce', luce: STD.kwh, gas: STD.smc };
    el.querySelector('.wbody').innerHTML = `<div class="wctl"><div class="wseg" data-k="kind"></div>
      <label class="wrange"><span class="wval"></span><input type="range"></label></div>
      <div class="chart chart-d"></div><div class="chart chart-m"></div><p class="wtext"></p>`;
    const input = el.querySelector('input');
    const draw = () => {
      seg(el.querySelector('.wseg'), [['luce', 'Luce'], ['gas', 'Gas']], st.kind, (v) => { st.kind = v; draw(); });
      const luce = st.kind === 'luce';
      Object.assign(input, luce ? { min: 500, max: 8000, step: 100 } : { min: 100, max: 3000, step: 50 });
      input.value = st[st.kind];
      el.querySelector('.wval').textContent = `${it(st[st.kind])} ${luce ? 'kWh' : 'Smc'} l'anno`;
      const g = shoppingGaps(D[st.kind], st.kind, st[st.kind]);
      if (!g.best) return;
      const b = g.best.total;
      const rows = [['10ª offerta', g.tenth, 'b3'], ['Offerta mediana', g.median, 'b1'],
        ['Una su quattro costa più di', g.p75, 'b2'], ['Una su dieci costa più di', g.p90, 'b4']]
        .map(([label, v, cls]) => ({ label, bars: [{ v: v - b, cls, txt: `+${it(v - b)} €` }] }));
      const xmax = niceMax((g.p90 - b) * 1.15, 4);
      both(el, (W) => hbars(W, rows, xmax, ticksTo(xmax, W < 500 ? 2 : 4), "Euro l'anno in più della migliore offerta"));
      el.querySelector('.wtext').textContent = `A ${it(st[st.kind])} ${luce ? 'kWh' : 'Smc'} l'anno la migliore offerta nazionale di oggi, ${g.best.o.n} (${g.best.o.v || 'venditore non indicato'}), costa ${it(b)} € l'anno tutto compreso, su ${it(g.n)} offerte. Fermarsi all'offerta mediana costa ${it(g.median - b)} € in più.`;
    };
    input.addEventListener('input', () => { st[st.kind] = +input.value; draw(); });
    draw();
  }

  function widgetMonth(D) {
    const el = document.getElementById('w-mese');
    if (!el) return;
    const cache = new Map();
    fetch('history/index.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((ix) => {
        const months = ix.months.map((x) => x.m);
        const st = { kind: 'luce', m: months.includes('2023-01') ? '2023-01' : months[0] };
        el.querySelector('.wbody').innerHTML = `<div class="wctl"><div class="wseg"></div>
          <span class="wnav"><button type="button" data-d="-1" aria-label="Mese precedente">‹</button><select aria-label="Mese di firma"></select><button type="button" data-d="1" aria-label="Mese successivo">›</button></span></div>
          <div class="chart chart-d"></div><div class="chart chart-m"></div><p class="wtext"></p>`;
        const sel = el.querySelector('select');
        sel.innerHTML = months.map((m) => `<option value="${m}">${monthName(m)}</option>`).join('');
        el.querySelector('.wnav').onclick = (e) => {
          const b = e.target.closest('button[data-d]'); if (!b) return;
          const i = months.indexOf(st.m) + +b.dataset.d;
          if (i >= 0 && i < months.length) { st.m = months[i]; draw(); }
        };
        sel.onchange = () => { st.m = sel.value; draw(); };
        const load = (m) => {
          if (!cache.has(m)) cache.set(m, fetch(`history/${m}/offers.json?v=${encodeURIComponent(ix.generated_at)}`).then((r) => r.json()));
          return cache.get(m);
        };
        const draw = () => {
          seg(el.querySelector('.wseg'), [['luce', 'Luce'], ['gas', 'Gas']], st.kind, (v) => { st.kind = v; draw(); });
          sel.value = st.m;
          load(st.m).then((snap) => {
            const o = monthOutcome(snap, st.kind);
            if (!o.then.F || !o.then.V) return;
            const rows = [['Fissa migliore', 'F'], ['Variabile migliore', 'V']].map(([label, t]) => ({
              label, bars: [{ v: o.then[t].total, cls: 'b1', txt: `allora ${it(o.then[t].total)} €` }]
                .concat(o.poi && o.poi[t] ? [{ v: o.poi[t].total, cls: 'b2', txt: `poi ${it(o.poi[t].total)} €` }] : []),
            }));
            const all = rows.flatMap((r) => r.bars.map((b) => b.v));
            const xmax = niceMax(Math.max(...all) * 1.22, 4);
            both(el, (W) => hbars(W, rows, xmax, ticksTo(xmax, W < 500 ? 2 : 4), 'Costo annuo della migliore fissa e della migliore variabile'));
            const day = new Date(snap.time_machine.day + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
            let txt = `Il ${day} la fissa migliore era ${o.then.F.o.n} e la variabile migliore ${o.then.V.o.n}. `;
            if (!o.poi) txt += 'Col senno di poi non si può ancora dire: nessun mese di fornitura è chiuso.';
            else {
              const d = o.poi.F.total - o.poi.V.total;
              txt += `Col senno di poi ${d < 0 ? 'ha vinto il fisso' : 'ha vinto il variabile'}, di ${it(Math.abs(d))} € l'anno`;
              txt += o.months < 12 ? `, ma il conto è provvisorio: solo ${o.months} mesi su 12 sono già chiusi.` : '.';
            }
            el.querySelector('.wtext').textContent = txt;
          }).catch(() => { el.querySelector('.wtext').textContent = `Non riesco a caricare ${monthName(st.m)}.`; });
        };
        draw();
      })
      .catch(() => { el.querySelector('.wbody').innerHTML = `<p class="wnote">Lo storico mensile non è disponibile qui. Lo trovi nella <a href="${PUBLISHED}">versione pubblicata dell'articolo</a>.</p>`; });
  }

  function widgetBreakEven(D) {
    const el = document.getElementById('w-pareggio');
    if (!el) return;
    const st = { kind: 'luce' };
    el.querySelector('.wbody').innerHTML = `<div class="wctl"><div class="wseg"></div></div>
      <div class="chart chart-d"></div><div class="chart chart-m"></div><p class="wtext"></p>`;
    const draw = () => {
      seg(el.querySelector('.wseg'), [['luce', 'Luce'], ['gas', 'Gas']], st.kind, (v) => { st.kind = v; draw(); });
      const xs = [];
      if (st.kind === 'luce') for (let x = 500; x <= 6000; x += 250) xs.push(x);
      else for (let x = 100; x <= 3000; x += 100) xs.push(x);
      const c = breakEvenCurve(D[st.kind], st.kind, xs);
      if (c.pts.length < 2) return;
      both(el, (W) => lineChart(c, st.kind, W));
      const u = st.kind === 'luce' ? 'kWh' : 'Smc';
      el.querySelector('.wtext').textContent = c.cross
        ? `Con le offerte di oggi, sotto circa ${it(Math.round(c.cross / 50) * 50)} ${u} l'anno vince un'offerta con quota fissa fino a 3 € al mese; sopra, una con quota più alta e prezzo più basso. A ${it(xs[0])} ${u} la migliore con quota bassa è ${c.pts[0].lowRow.o.n}.`
        : `Con le offerte di oggi non c'è un punto di pareggio tra ${it(xs[0])} e ${it(xs[xs.length - 1])} ${u}: vince sempre ${c.pts[0].low <= c.pts[0].high ? "un'offerta con quota fissa bassa" : "un'offerta con quota fissa alta"}.`;
    };
    draw();
  }

  // Widget 5: il grafico di PUN e PSV si ridisegna dai dati se c'è un mese chiuso più recente.
  function liveWholesale(D) {
    const fig = document.getElementById('prezzi');
    if (!fig || !D.market) return;
    const pun = closedSeries(D.market.pun_monthly || [], D.generated_at).filter(([m]) => m >= '2005-01');
    const psv = closedSeries(D.market.psv_monthly || [], D.generated_at).filter(([m]) => m >= '2020-01');
    if (pun.length < 24 || psv.length < 12) return;
    const staticLast = fig.dataset.last || '';
    const force = /[?&]live\b/.test(location.search);
    const last = pun[pun.length - 1][0];
    if (!force && last <= staticLast) return;
    both(fig, (W) => wholesaleChart(pun, psv, W));
    const cap = fig.querySelector('figcaption');
    const lp = pun[pun.length - 1], lg = psv[psv.length - 1];
    if (cap) cap.innerHTML = `Cosa guardare: il picco dell'agosto 2022 e la nuova salita del 2026 dopo due anni calmi. Ultimo mese chiuso: ${esc(monthName(lp[0]))}, ${it(lp[1], 3)} euro al kWh e ${it(lg[1], 3)} euro allo Smc. Grafico aggiornato dai dati del comparatore. Prezzi all'ingrosso, senza tasse né costi di rete.`;
  }

  function start() {
    if (!E) { unavailable('manca engine.js'); return; }
    for (const el of document.querySelectorAll('.widget .wbody')) el.innerHTML = '<p class="wnote">Caricamento dei dati del comparatore…</p>';
    fetch('offers.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((D) => {
        for (const [name, fn] of [['oggi', widgetToday], ['cercare', widgetShopping], ['mese', widgetMonth],
          ['pareggio', widgetBreakEven], ['prezzi', liveWholesale]]) {
          try { fn(D); } catch (e) {
            const el = document.getElementById('w-' + name);
            if (el) el.querySelector('.wbody').innerHTML = `<p class="wnote">Errore nel calcolo (${esc(e.message)}).</p>`;
          }
        }
      })
      .catch((e) => unavailable(e.message));
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return { it, rankOffers, shoppingGaps, todaySignal, monthOutcome, breakEvenCurve, closedSeries, wholesaleChart,
           Panel, LOW_FEE, STD };
});
