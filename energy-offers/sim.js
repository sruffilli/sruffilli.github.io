/*
 * sim.js — simulatore bolletta (simulatore.html): ogni voce del costo annuo,
 * con tutte le leve modificabili.
 *
 * Nessuna formula qui: il costo lo calcola engine.js (costLuce / costGas). Il
 * simulatore costruisce solo gli input — offerta, profilo e una copia dei
 * parametri con le voci regolate sostituite dalle leve — e mostra le voci che
 * l'engine restituisce.
 *
 * Il core (parseHash, buildHash, offerHash, evalLuce, evalGas, sweep) è puro e
 * gira anche in node: tests/test_web_export.py::TestSimulator lo confronta con
 * engine.js. app.js usa offerHash per il link "Simula la bolletta" della scheda.
 *
 * Stato nell'hash dell'URL: le chiavi semplici sono il punto di partenza (l'offerta
 * e il profilo con cui si è aperto il simulatore), quelle con prefisso "e." le
 * modifiche dell'utente. Es. #k=luce&t=V&m=mono&p=0.01&fx=96&kwh=2700&e.pun=0.2
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.EnergySim = factory(root.EnergyEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  /* ---------------- schema delle leve ---------------- */

  // t: tipo (int, num, bool, enum, arr3). min/max: limiti di validità (non realismo).
  const SCHEMA = {
    luce: {
      kwh: { t: 'int', min: 1, max: 100000 }, kw: { t: 'num', min: 0.5, max: 100 },
      r: { t: 'bool' }, f1: { t: 'int', min: 0, max: 100 }, f2: { t: 'int', min: 0, max: 100 },
      t: { t: 'enum', v: ['F', 'V'] }, m: { t: 'enum', v: ['mono', 'bi', 'tri'] },
      p: { t: 'arr3', min: -1, max: 5 }, fx: { t: 'num', min: 0, max: 5000 }, fk: { t: 'num', min: 0, max: 500 },
      net: { t: 'bool' },
      ix: { t: 'enum', v: ['12m', 'last', 'custom'] }, pun: { t: 'num', min: 0.001, max: 5 },
      cd: { t: 'num', min: -1, max: 1 }, tf: { t: 'num', min: 0, max: 100 }, qp: { t: 'num', min: 0, max: 100 },
      ov: { t: 'num', min: -1, max: 1 }, nr: { t: 'num', min: 0, max: 2000 }, db: { t: 'num', min: -100, max: 100 },
      la: { t: 'num', min: 1, max: 1.5 }, iva: { t: 'num', min: 0, max: 50 }, ac: { t: 'num', min: 0, max: 1 },
      rai: { t: 'num', min: 0, max: 500 },
    },
    gas: {
      smc: { t: 'int', min: 1, max: 100000 },
      t: { t: 'enum', v: ['F', 'V'] }, p: { t: 'num', min: -1, max: 10 }, sb: { t: 'num', min: 0, max: 1 },
      fx: { t: 'num', min: 0, max: 5000 },
      ix: { t: 'enum', v: ['12m', 'last', 'custom'] }, psv: { t: 'num', min: 0.01, max: 10 },
      rf: { t: 'num', min: 0, max: 100 }, rv: { t: 'num', min: 0, max: 5 },
      il: { t: 'num', min: 0, max: 50 }, ih: { t: 'num', min: 0, max: 50 }, th: { t: 'int', min: 0, max: 100000 },
    },
  };
  // Chiavi del punto di partenza che finiscono sempre nel link (offerta + profilo).
  const ALWAYS = {
    luce: ['t', 'm', 'p', 'fx', 'fk', 'kwh', 'kw', 'r', 'f1', 'f2', 'ix'],
    gas: ['t', 'p', 'sb', 'fx', 'smc', 'ix'],
  };
  const PROFILE_DEFAULTS = { kwh: 2700, kw: 3, residente: true, f1: 33, f2: 31, smc: 1000 };

  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const pct = (mult) => Math.round((mult - 1) * 10000) / 100;   // 1.1 → 10

  // Valori di partenza: voci regolate dai parametri del giorno, profilo dal
  // comparatore (o di default), "offerta personalizzata" variabile.
  function defaults(kind, params, prof) {
    const p = Object.assign({}, PROFILE_DEFAULTS, prof || {});
    if (kind === 'luce') {
      const s = params.system, fix = s.fix_components;
      return {
        kwh: p.kwh, kw: p.kw, r: !!p.residente, f1: p.f1, f2: p.f2,
        t: 'V', m: 'mono', p: [0.01, 0.01, 0.01], fx: 96, fk: 0, net: false,
        ix: '12m', pun: params.pun_12m.mono,
        cd: s.cdispd_per_kwh, tf: fix[0], qp: fix[1] + fix[2], ov: s.var_per_kwh,
        nr: s.non_resident_fix_annual, db: s.dispbt_annual, la: params.lambda, iva: pct(params.iva),
        ac: s.excise.resident, rai: params.rai_annual,
      };
    }
    return {
      smc: p.smc, t: 'V', p: 0.1, sb: 0, fx: 96, ix: '12m', psv: params.psv_12m,
      rf: params.rete_fix_monthly, rv: params.rete_var_per_smc,
      il: pct(params.iva_low), ih: pct(params.iva_high), th: params.iva_threshold_smc,
    };
  }

  /* ---------------- hash ---------------- */

  function parseVal(sch, raw) {
    if (raw == null) return undefined;
    if (sch.t === 'bool') return raw === '1' ? true : raw === '0' ? false : undefined;
    if (sch.t === 'enum') return sch.v.includes(raw) ? raw : undefined;
    if (sch.t === 'arr3') {
      const xs = raw.split(',').slice(0, 3).map(Number);
      if (!xs.length || xs.some((x) => !Number.isFinite(x) || x < sch.min || x > sch.max)) return undefined;
      while (xs.length < 3) xs.push(xs[xs.length - 1]);
      return xs;
    }
    const x = Number(raw);
    if (raw === '' || !Number.isFinite(x) || x < sch.min || x > sch.max) return undefined;
    return sch.t === 'int' ? Math.round(x) : x;
  }

  function fmtVal(v) {
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (Array.isArray(v)) return v.map(fmtVal).join(',');
    if (typeof v === 'number') return String(r6(v));
    return String(v);
  }
  const same = (a, b) => fmtVal(a) === fmtVal(b);
  const clip = (s) => String(s || '').slice(0, 80);

  /*
   * str: hash senza '#'. Ritorna { kind, base, cur, n, v, d } con base/cur
   * completi (defaults + chiavi del link), oppure null se params manca.
   * Chiavi sconosciute o valori fuori schema sono ignorati.
   */
  function parseHash(str, paramsByKind, prof) {
    const q = new URLSearchParams(str || '');
    const kind = q.get('k') === 'gas' ? 'gas' : 'luce';
    const sch = SCHEMA[kind];
    const base = defaults(kind, paramsByKind[kind], prof);
    const edits = {};
    for (const key of Object.keys(sch)) {
      const b = parseVal(sch[key], q.get(key));
      if (b !== undefined) base[key] = b;
      const e = parseVal(sch[key], q.get('e.' + key));
      if (e !== undefined) edits[key] = e;
    }
    if (kind === 'luce') fixFasce(base);
    const cur = Object.assign(clone(base), edits);
    if (kind === 'luce') fixFasce(cur);
    return { kind, base, cur, n: clip(q.get('n')), v: clip(q.get('v')), d: (q.get('d') || '').slice(0, 10) };
  }

  function fixFasce(s) { if (s.f1 + s.f2 > 100) s.f2 = 100 - s.f1; }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Inverso di parseHash: partenza (solo quello che differisce dai default, più
  // offerta e profilo) e modifiche con prefisso "e.".
  function buildHash(kind, base, cur, meta, paramsByKind, prof) {
    const def = defaults(kind, paramsByKind[kind], prof);
    const q = new URLSearchParams();
    q.set('k', kind);
    if (meta && meta.n) q.set('n', clip(meta.n));
    if (meta && meta.v) q.set('v', clip(meta.v));
    if (meta && meta.d) q.set('d', meta.d);
    for (const key of Object.keys(SCHEMA[kind])) {
      if (ALWAYS[kind].includes(key) || !same(base[key], def[key])) q.set(key, fmtVal(base[key]));
    }
    for (const key of Object.keys(SCHEMA[kind])) {
      if (!same(cur[key], base[key])) q.set('e.' + key, fmtVal(cur[key]));
    }
    return q.toString();
  }

  /*
   * Hash del link "Simula la bolletta" per un'offerta del comparatore.
   * o: riga di offers.json; st: stato del comparatore (kwh, kw, residente, f1,
   * f2, punScen, punCustom | smc, psvScen, psvCustom, reteFix, reteVar);
   * d: data dei valori (YYYY-MM-DD).
   */
  function offerHash(kind, o, st, d) {
    const q = new URLSearchParams();
    q.set('k', kind);
    q.set('n', clip(o.n));
    if (o.v) q.set('v', clip(o.v));
    if (d) q.set('d', d);
    q.set('t', o.t);
    if (kind === 'luce') {
      q.set('m', o.m);
      q.set('p', fmtVal(o.p));
      q.set('fx', fmtVal(o.fx));
      q.set('fk', fmtVal(o.fk || 0));
      q.set('kwh', fmtVal(st.kwh)); q.set('kw', fmtVal(st.kw)); q.set('r', st.residente ? '1' : '0');
      q.set('f1', fmtVal(st.f1)); q.set('f2', fmtVal(st.f2));
      q.set('ix', st.punScen || '12m');
      if (st.punScen === 'custom') q.set('pun', fmtVal(st.punCustom));
    } else {
      q.set('p', fmtVal(o.p));
      q.set('sb', fmtVal(o.sb || 0));
      q.set('fx', fmtVal(o.fx));
      q.set('smc', fmtVal(st.smc));
      q.set('ix', st.psvScen || '12m');
      if (st.psvScen === 'custom') q.set('psv', fmtVal(st.psvCustom));
      if (st.reteFix != null) q.set('rf', fmtVal(st.reteFix));
      if (st.reteVar != null) q.set('rv', fmtVal(st.reteVar));
    }
    return q.toString();
  }

  /* ---------------- calcolo (tutto in engine.js) ---------------- */

  const nP = (m) => (m === 'mono' ? 1 : m === 'bi' ? 2 : 3);

  // s: leve luce. params: offers.json → luce.params (non modificato).
  function evalLuce(s, params) {
    const P = clone(params);
    const sys = P.system, e0 = params.system.excise;
    sys.cdispd_per_kwh = s.cd;
    sys.fix_components = [s.tf, s.qp, 0, params.system.fix_components[3]];
    sys.var_per_kwh = s.ov;
    sys.non_resident_fix_annual = s.nr;
    sys.dispbt_annual = s.db;
    // una sola leva per l'accisa: il non residente segue in proporzione (oggi uguali)
    sys.excise = { resident: s.ac, non_resident: e0.resident > 0 ? e0.non_resident * s.ac / e0.resident : s.ac };
    P.lambda = s.la;
    P.iva = 1 + s.iva / 100;
    P.rai_annual = s.rai;
    const f1 = s.f1 / 100, f2 = s.f2 / 100;
    const profile = { kwh: s.kwh, kw: s.kw, residente: !!s.r, f1, f2, f3: Math.max(0, 1 - f1 - f2) };
    // Prezzo letto in bolletta: al netto delle perdite, che l'XML include già.
    const p = s.p.slice(0, nP(s.m)).map((x) => (s.t === 'F' && s.net ? x * s.la : x));
    const offer = { t: s.t, m: s.m, p, fx: s.fx, fk: s.fk };
    const idx = E.punIndex(P, s.ix, s.pun);
    return { c: E.costLuce(offer, P, profile, idx), offer, P, profile, idx };
  }

  function evalGas(s, params) {
    const P = clone(params);
    P.iva_low = 1 + s.il / 100;
    P.iva_high = 1 + s.ih / 100;
    P.iva_threshold_smc = s.th;
    const profile = { smc: s.smc, reteFix: s.rf, reteVar: s.rv };
    const offer = { t: s.t, p: s.p, sb: s.sb, fx: s.fx };
    const psv = E.psvIndex(P, s.ix, s.psv);
    return { c: E.costGas(offer, P, profile, psv), offer, P, profile, idx: psv };
  }

  const evalKind = (kind, s, params) => (kind === 'luce' ? evalLuce(s, params) : evalGas(s, params));

  // Assi del grafico di sensibilità: [chiave, min, max].
  const AXES = {
    luce: { pun: [0.05, 0.40], kwh: [300, 8000] },
    gas: { psv: [0.20, 1.20], smc: [50, 3000] },
  };

  // Totale al variare di una leva (n punti), il resto fermo.
  function sweep(kind, s, params, axis, n) {
    const [lo, hi] = AXES[kind][axis];
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = lo + (hi - lo) * i / (n - 1);
      const t = Object.assign({}, s);
      if (axis === 'pun' || axis === 'psv') { t.ix = 'custom'; t[axis] = x; } else t[axis] = Math.round(x);
      pts.push([x, evalKind(kind, t, params).c.total]);
    }
    return pts;
  }

  // Cambio fisso ↔ variabile a parità di costo all'indice corrente: lo spread
  // equivalente di un fisso (o viceversa), così il totale non salta.
  function convertType(kind, s, params, toType) {
    const out = Object.assign({}, s, { t: toType });
    if (s.t === toType) return out;
    const r = evalKind(kind, s, params);
    if (kind === 'gas') {
      out.p = r6(toType === 'V' ? s.p - r.idx : s.p + r.idx);
      return out;
    }
    const keys = s.m === 'mono' ? ['mono'] : s.m === 'bi' ? ['f1', 'f23'] : ['f1', 'f2', 'f3'];
    const L = s.la;
    const k = toType === 'V' ? -1 : 1;
    out.p = s.p.map((x, i) => {
      const net = s.t === 'F' && s.net ? x * L : x;   // prezzo con perdite
      return r6(net + k * r.idx[keys[Math.min(i, keys.length - 1)]] * L);
    });
    out.net = false;
    return out;
  }

  const core = { SCHEMA, AXES, defaults, parseHash, buildHash, offerHash, evalLuce, evalGas, evalKind,
                 sweep, convertType, fmtVal };
  if (typeof document !== 'undefined') core.mount = mount;
  return core;

  /* ================= interfaccia (solo browser) ================= */

  function mount() {
    const $ = (s) => document.querySelector(s);
    const STORE = 'energy-offers-v1';
    const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
    const nf0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
    const nf2 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nfd = (x, d) => x.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
    const eur = (x) => nf0.format(Math.round(x)) + ' €';
    const eur2 = (x) => nf2.format(x) + ' €';
    const sgn = (d, f) => (d >= 0 ? '+' : '−') + f(Math.abs(d));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const monthLabel = (k) => { const [m, y] = String(k).split('/'); return `${MESI[+m - 1] || m} ${y}`; };
    const dayLabel = (d) => { const x = new Date(d + 'T12:00:00'); return isNaN(x) ? d : x.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }); };

    let DATA = null;
    let kind = 'luce';
    let axis = { luce: 'pun', gas: 'psv' };
    const S = {};          // kind → { base, cur, n, v, d }
    const openBoxes = new Set(['profilo', 'offerta', 'mercato']);
    let prof = {};
    try {
      const st = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const k of ['kwh', 'kw', 'residente', 'f1', 'f2', 'smc']) if (st[k] != null) prof[k] = st[k];
    } catch (e) { prof = {}; }

    const params = () => ({ luce: DATA.luce.params, gas: DATA.gas.params });

    /* ----- metadati delle leve: etichetta, unità, decimali, slider ----- */
    const priceLab = (s, i) => {
      const f = s.m === 'mono' ? '' : s.m === 'bi' ? [' F1', ' F2 e F3'][i] : [' F1', ' F2', ' F3'][i];
      return s.t === 'F' ? `Prezzo energia${f}` : `Spread sul PUN${f}`;
    };
    function meta(k, key) {
      const s = S[k].cur;
      const L = {
        kwh: ['Consumo annuo', 'kWh/anno', 0, [300, 8000, 50]],
        smc: ['Consumo annuo', 'Smc/anno', 0, [50, 3000, 10]],
        fx: ['Quota fissa (commercializzazione)', '€/anno', 2, [0, 300, 1], 'Il costo fisso del venditore, una tantum comprese'],
        fk: ['Quota potenza del venditore', '€/kW/anno', 2, null, 'Rara: la applicano poche offerte'],
        sb: ['Oneri di bilanciamento', '€/Smc', 4, null, 'Voce a consumo che alcune offerte gas aggiungono al prezzo'],
        pun: ['PUN ipotizzato (media annua)', '€/kWh', 3, [0.05, 0.40, 0.001], 'Le fasce F1/F2/F3 seguono in proporzione alla media 12 mesi'],
        psv: ['PSV ipotizzato (media annua)', '€/Smc', 3, [0.20, 1.20, 0.005]],
        cd: ['Dispacciamento (CdispD)', '€/kWh', 6, null],
        tf: ['Trasporto, quota fissa', '€/mese', 2, null],
        qp: ['Trasporto, quota potenza', '€/kW/mese', 4, null],
        ov: ['Trasporto e oneri di sistema, quota variabile', '€/kWh', 6, null, 'Comprende ASOS e ARIM a consumo'],
        nr: ['Oneri di sistema, quota fissa', '€/anno', 2, null, 'Solo non residenti: per i residenti è zero'],
        db: ['Dispacciamento BT (DispBT)', '€/anno', 3, null],
        la: ['Perdite di rete (fattore λ)', '×', 2, null, 'Moltiplica il PUN delle variabili: 1,10 = +10%'],
        ac: ['Accisa', '€/kWh', 4, null, 'Residenti fino a 3 kW: esenzione sui primi kWh'],
        rai: ['Canone RAI', '€/anno', 2, null, 'In bolletta solo per i residenti'],
        rf: ['Rete, oneri e accise: quota fissa', '€/mese', 2, null],
        rv: ['Rete, oneri e accise: quota variabile', '€/Smc', 3, null, 'Dipende da zona climatica e ambito tariffario: il valore di partenza è una media nazionale'],
        th: ['Soglia IVA agevolata', 'Smc/anno', 0, null, 'IVA ridotta sui consumi fino a questa soglia'],
        ih: ['IVA ordinaria', '%', 0, null, 'Sui consumi oltre soglia e sulle quote fisse'],
      };
      if (key === 'p' || /^p\d$/.test(key)) {
        const i = key === 'p' ? 0 : +key.slice(1);
        if (k === 'gas') {
          return s.t === 'F' ? ['Prezzo gas', '€/Smc', 4, [0.20, 1.50, 0.005]]
            : ['Spread sul PSV', '€/Smc', 4, [-0.05, 0.40, 0.005], "Quanto il venditore aggiunge al prezzo all'ingrosso"];
        }
        return s.t === 'F'
          ? [priceLab(s, i), '€/kWh', 4, [0.03, 0.40, 0.001], s.net ? 'Netto delle perdite: le aggiungo io' : 'Come nel Portale Offerte, perdite di rete incluse']
          : [priceLab(s, i), '€/kWh', 4, [-0.02, 0.10, 0.001], "Quanto il venditore aggiunge al PUN × perdite"];
      }
      return L[key];
    }

    const getVal = (s, key) => (key[0] === 'p' && key.length === 2 ? s.p[+key[1]] : s[key]);
    function setVal(s, key, v) {
      if (key[0] === 'p' && key.length === 2) { s.p = s.p.slice(); s.p[+key[1]] = v; } else s[key] = v;
    }
    const isEdited = (key) => {
      const st = S[kind];
      if (key[0] === 'p' && key.length === 2) return !same(st.cur.p[+key[1]], st.base.p[+key[1]]);
      return !same(st.cur[key], st.base[key]);
    };
    const fmtIn = (x, d) => x.toLocaleString('it-IT', { maximumFractionDigits: Math.max(d, 0), useGrouping: false });
    const parseIn = (str) => {
      const t = String(str).trim().replace(/\s/g, '').replace(',', '.');
      if (!/^-?\d*\.?\d*$/.test(t) || t === '' || t === '-' || t === '.') return NaN;
      return Number(t);
    };

    /* ----- componenti di input ----- */
    function lever(key) {
      const [lab, unit, dec, sl, hint] = meta(kind, key);
      const v = getVal(S[kind].cur, key);
      const id = 'lv-' + key;
      return `<div class="lever" data-key="${key}">
        <div class="lev-row">
          <label for="${id}">${esc(lab)}${hint ? `<small>${esc(hint)}</small>` : ''}</label>
          <span class="lev-in"><input id="${id}" class="lev-num" data-key="${key}" type="text" inputmode="decimal" autocomplete="off" value="${esc(fmtIn(v, dec))}"><span class="unit">${esc(unit)}</span></span>
          <button type="button" class="lev-reset" data-reset="${key}" aria-label="Ripristina ${esc(lab)}" title="Ripristina il valore di partenza">↺</button>
        </div>
        ${sl ? `<input class="slider small" type="range" data-key="${key}" min="${sl[0]}" max="${sl[1]}" step="${sl[2]}" value="${v}" aria-label="${esc(lab)}">` : ''}
      </div>`;
    }
    function segHtml(key, items, cur, label) {
      return `<div class="seg" role="radiogroup" aria-label="${esc(label)}" data-seg="${key}">${items.map((it) =>
        `<button type="button" role="radio" data-v="${it.v}" aria-checked="${String(it.v) === String(cur)}"${it.title ? ` title="${esc(it.title)}"` : ''}>${esc(it.label)}${it.small ? `<small>${esc(it.small)}</small>` : ''}</button>`).join('')}</div>`;
    }
    const box = (id, title, body, opts) => {
      const o = opts || {};
      return `<details class="card sim-box ${o.cls || ''}" data-box="${id}"${openBoxes.has(id) ? ' open' : ''}>
        <summary><span class="eyebrow">${title}</span>${o.badge ? `<span class="badge">${esc(o.badge)}</span>` : ''}<span class="summary-val" data-sum="${id}"></span></summary>
        <div class="sim-box-body">${body}</div></details>`;
    };

    function renderControls() {
      const st = S[kind], s = st.cur;
      const P = DATA[kind].params;
      let html = '';
      if (kind === 'luce') {
        const kwChips = [1.5, 3, 4.5, 6, 10].map((k) =>
          `<button type="button" class="chip" data-kw="${k}" aria-pressed="${s.kw === k}">${String(k).replace('.', ',')} kW</button>`).join('');
        const f3 = Math.max(0, 100 - s.f1 - s.f2);
        html += box('profilo', 'Il tuo profilo', lever('kwh') +
          `<div class="row-between sim-gap"><span class="mini-label">Potenza impegnata</span>
            <label class="switch"><input type="checkbox" id="simRes"${s.r ? ' checked' : ''}><span class="track" aria-hidden="true"></span><span>Residente</span></label></div>
           <div class="chips">${kwChips}</div>
           <div class="sim-fasce${s.m === 'mono' ? ' off' : ''}">
             <p class="mini-label">Fasce orarie <b>${s.f1} / ${s.f2} / ${f3}</b></p>
             ${s.m === 'mono' ? '<p class="hint">Contano solo per le offerte bi e multiorarie.</p>' : ''}
             <div class="fasce-bar" aria-hidden="true"><span class="f1" style="flex-basis:${s.f1}%"></span><span class="f2" style="flex-basis:${s.f2}%"></span><span class="f3" style="flex-basis:${f3}%"></span></div>
             <label class="mini-label" for="simF1">F1 · lun-ven 8-19 <b>${s.f1}%</b></label>
             <input id="simF1" class="slider small" type="range" min="0" max="100" step="1" value="${s.f1}" data-f="f1">
             <label class="mini-label" for="simF2">F2 · lun-ven 7-8 e 19-23, sabato <b>${s.f2}%</b></label>
             <input id="simF2" class="slider small" type="range" min="0" max="100" step="1" value="${s.f2}" data-f="f2">
           </div>`);
        const prices = [0, 1, 2].slice(0, nP(s.m)).map((i) => lever('p' + i)).join('');
        html += box('offerta', "L'offerta", `<p class="hint">Le voci che decide il venditore: qui si fa la differenza fra un'offerta e l'altra.</p>` +
          segHtml('t', [{ v: 'F', label: 'Prezzo fisso' }, { v: 'V', label: 'Variabile (PUN + spread)' }], s.t, 'Tipo di prezzo') +
          segHtml('m', [{ v: 'mono', label: 'Monoraria' }, { v: 'bi', label: 'Bioraria' }, { v: 'tri', label: 'Multioraria' }], s.m, 'Fasce di prezzo') +
          prices +
          (s.t === 'F' ? `<label class="switch sim-gap"><input type="checkbox" id="simNet"${s.net ? ' checked' : ''}><span class="track" aria-hidden="true"></span><span>Prezzo letto in bolletta (perdite di rete a parte)</span></label>` : '') +
          lever('fx') + (s.fk || st.base.fk ? lever('fk') : ''), { cls: 'seller' });
        html += box('mercato', "Prezzo all'ingrosso (PUN)",
          (s.t === 'F' ? `<p class="hint">Con un prezzo fisso il PUN non cambia il totale: prova a muoverlo.</p>` : `<p class="hint">Il prezzo dell'energia delle variabili è PUN × perdite + spread.</p>`) +
          segHtml('ix', [
            { v: '12m', label: 'Media 12 mesi', small: nfd(P.pun_12m.mono, 3) },
            { v: 'last', label: 'Ultimo mese', small: `${monthLabel(P.pun_last.month)} · ${nfd(P.pun_last.mono, 3)}` },
            { v: 'custom', label: 'A scelta', small: nfd(s.pun, 3) },
          ], s.ix, 'PUN') + (s.ix === 'custom' ? lever('pun') : ''));
        html += box('regolate', 'Voci regolate ARERA', `<p class="hint">Le stabilisce ARERA ogni trimestre e sono uguali per ogni venditore: cambiano il totale, non la classifica. Valori di partenza dal ${esc(P.params_source || 'CSV parametri ARERA')}.</p>` +
          ['cd', 'tf', 'qp', 'ov', 'nr', 'db', 'la'].map(lever).join(''), { badge: 'uguali per tutti', cls: 'reg' });
        html += box('imposte', 'Imposte', segHtml('iva', [{ v: 10, label: 'IVA 10%', small: 'uso domestico' }, { v: 22, label: 'IVA 22%', small: 'altri usi' }], s.iva, 'IVA') +
          ['ac', 'rai'].map(lever).join(''), { badge: 'uguali per tutti', cls: 'reg' });
      } else {
        html += box('profilo', 'Il tuo profilo', lever('smc'));
        html += box('offerta', "L'offerta", `<p class="hint">Le voci che decide il venditore: qui si fa la differenza fra un'offerta e l'altra.</p>` +
          segHtml('t', [{ v: 'F', label: 'Prezzo fisso' }, { v: 'V', label: 'Variabile (PSV + spread)' }], s.t, 'Tipo di prezzo') +
          lever('p') + lever('fx') + (s.sb || st.base.sb ? lever('sb') : ''), { cls: 'seller' });
        html += box('mercato', "Prezzo all'ingrosso (PSV)",
          (s.t === 'F' ? `<p class="hint">Con un prezzo fisso il PSV non cambia il totale: prova a muoverlo.</p>` : `<p class="hint">Il prezzo del gas delle variabili è PSV + spread.</p>`) +
          segHtml('ix', [
            { v: '12m', label: 'Media 12 mesi', small: nfd(P.psv_12m, 3) },
            { v: 'last', label: 'Ultimo mese', small: `${monthLabel(P.psv_last.month)} · ${nfd(P.psv_last.value, 3)}` },
            { v: 'custom', label: 'A scelta', small: nfd(s.psv, 3) },
          ], s.ix, 'PSV') + (s.ix === 'custom' ? lever('psv') : ''));
        html += box('regolate', 'Rete, oneri e accise', `<p class="hint">Uguali per ogni venditore: cambiano il totale, non la classifica. Per un totale preciso prendili dalla tua bolletta.</p>` +
          ['rf', 'rv'].map(lever).join(''), { badge: 'uguali per tutti', cls: 'reg' });
        html += box('imposte', 'IVA', segHtml('il', [{ v: 10, label: 'Agevolata 10%' }, { v: 5, label: '5%', small: 'come nel 2022-23' }], s.il, 'IVA agevolata') +
          ['th', 'ih'].map(lever).join(''), { badge: 'uguali per tutti', cls: 'reg' });
      }
      $('#simControls').innerHTML = html;
      syncLevers();
    }

    // Aggiorna i valori mostrati (senza ricostruire) e i segni di modifica.
    function syncLevers(skip) {
      const s = S[kind].cur;
      for (const el of document.querySelectorAll('#simControls .lever')) {
        const key = el.dataset.key, ed = isEdited(key);
        el.classList.toggle('edited', ed);
        const v = getVal(s, key), dec = meta(kind, key)[2];
        const num = el.querySelector('.lev-num');
        if (num !== skip) num.value = fmtIn(v, dec);
        const sl = el.querySelector('.slider');
        if (sl && sl !== skip) { sl.value = v; setPct(sl); }
      }
      for (const sl of document.querySelectorAll('#simControls .slider[data-f]')) setPct(sl);
      const cs = document.querySelector('[data-seg="ix"] [data-v="custom"] small');
      if (cs) cs.textContent = nfd(kind === 'luce' ? s.pun : s.psv, 3);
      const sums = {
        regolate: kind === 'luce' ? ['cd', 'tf', 'qp', 'ov', 'nr', 'db', 'la'] : ['rf', 'rv'],
        imposte: kind === 'luce' ? ['iva', 'ac', 'rai'] : ['il', 'ih', 'th'],
        offerta: kind === 'luce' ? ['t', 'm', 'p', 'fx', 'fk', 'net'] : ['t', 'p', 'fx', 'sb'],
        mercato: kind === 'luce' ? ['ix', 'pun'] : ['ix', 'psv'],
        profilo: kind === 'luce' ? ['kwh', 'kw', 'r', 'f1', 'f2'] : ['smc'],
      };
      for (const [id, keys] of Object.entries(sums)) {
        const n = keys.filter((k) => !same(s[k], S[kind].base[k])).length;
        const el = document.querySelector(`[data-sum="${id}"]`);
        if (el) el.textContent = n ? `${n} ${n === 1 ? 'modifica' : 'modifiche'}` : '';
        const bx = document.querySelector(`[data-box="${id}"]`);
        if (bx) bx.classList.toggle('edited', n > 0);
      }
    }

    function setPct(slider) {
      const min = +slider.min, max = +slider.max, v = Math.min(max, Math.max(min, +slider.value));
      slider.style.setProperty('--pct', ((v - min) / (max - min) * 100) + '%');
    }

    /* ----- ricevuta: una riga per voce ----- */
    function rows(k, r, s) {
      const c = r.c;
      const nf4 = (x) => nfd(x, 4), nf6 = (x) => x.toLocaleString('it-IT', { maximumFractionDigits: 6 });
      if (k === 'luce') {
        const sys = c.sistema, kwh = s.kwh, L = s.la;
        const keys = s.m === 'mono' ? ['mono'] : s.m === 'bi' ? ['f1', 'f23'] : ['f1', 'f2', 'f3'];
        const shares = s.m === 'mono' ? [1] : s.m === 'bi' ? [r.profile.f1, r.profile.f2 + r.profile.f3] : [r.profile.f1, r.profile.f2, r.profile.f3];
        const flab = s.m === 'mono' ? [''] : s.m === 'bi' ? ['F1', 'F2+F3'] : ['F1', 'F2', 'F3'];
        const unitPrice = (i) => (s.t === 'F' ? r.offer.p[i] : r.idx[keys[i]] * L + r.offer.p[i]);
        const priceTxt = (i) => (s.t === 'F' ? `${nf4(r.offer.p[i])}${s.net ? ` (${nf4(s.p[i])} × ${nfd(L, 2)})` : ''}`
          : `(PUN ${nf4(r.idx[keys[i]])} × ${nfd(L, 2)} ${s.p[i] < 0 ? '−' : '+'} ${nf4(Math.abs(r.offer.p[i]))})`);
        const energia = s.m === 'mono'
          ? `${nf0.format(kwh)} kWh × ${priceTxt(0)} €/kWh`
          : flab.map((f, i) => `${f}: ${nf0.format(kwh * shares[i])} kWh × ${priceTxt(i)}`).join('<br>');
        const ex = sys.exemptKwh;
        return [
          { g: 'Venditore' },
          { id: 'energia', lab: s.t === 'F' ? 'Energia (prezzo fisso)' : 'Energia (PUN + spread)', c: 'var(--c-energia)', v: c.energia, f: energia,
            note: `media ${nf4(c.energia / kwh)} €/kWh` + (s.t === 'V' ? ', perdite di rete incluse' : '') },
          { id: 'fisso', lab: 'Quota fissa venditore', c: 'var(--c-fisso)', v: c.fissoVenditore,
            f: `${eur2(s.fx)}/anno${s.fk ? ` + ${String(s.kw).replace('.', ',')} kW × ${eur2(s.fk)}/kW` : ''} = ${eur2(s.fx / 12 + s.fk * s.kw / 12)}/mese` },
          { g: 'Uguali per tutti i venditori' },
          { id: 'disp', lab: 'Dispacciamento', c: 'var(--c-disp)', v: c.dispacciamento, f: `${nf0.format(kwh)} kWh × ${nf6(s.cd)} €/kWh` },
          { id: 'tf', lab: 'Trasporto, quota fissa', c: 'var(--c-rete)', v: sys.trasportoFix, f: `12 mesi × ${eur2(s.tf)}` },
          { id: 'qp', lab: 'Trasporto, quota potenza', c: 'var(--c-rete)', v: sys.potenza, f: `12 mesi × ${String(s.kw).replace('.', ',')} kW × ${nf4(s.qp)} €/kW` },
          { id: 'ov', lab: 'Trasporto e oneri, quota variabile', c: 'var(--c-rete)', v: sys.varAnnual, f: `${nf0.format(kwh)} kWh × ${nf6(s.ov)} €/kWh` },
          { id: 'nr', lab: 'Oneri di sistema, quota fissa', c: 'var(--c-rete)', v: sys.oneriFix, f: s.r ? 'zero per i residenti' : `${eur2(s.nr)}/anno, non residenti` },
          { id: 'db', lab: 'Dispacciamento BT', c: 'var(--c-rete)', v: sys.dispbt, f: `${nf6(s.db)} €/anno` },
          { g: 'Imposte' },
          { id: 'acc', lab: 'Accise', c: 'var(--c-accise)', v: sys.excise,
            f: s.r && ex > 0 ? `(${nf0.format(kwh)} − ${nf0.format(ex)} esenti) kWh × ${nf4(s.ac)} €/kWh`
              : `${nf0.format(kwh)} kWh × ${nf4(s.ac)} €/kWh`,
            note: s.r ? (ex > 0 ? 'esenzione residenti fino a 3 kW, si riduce sopra 150 kWh al mese' : (s.kw > 3 ? 'nessuna esenzione sopra i 3 kW' : 'nessuna esenzione: consumo mensile troppo alto')) : '' },
          { id: 'iva', lab: `IVA ${nfd(s.iva, 0)}%`, c: 'var(--c-iva)', v: c.iva, f: `${nfd(s.iva, 0)}% di ${eur2(c.preIva)}` },
          { id: 'rai', lab: 'Canone RAI', c: 'var(--c-rai)', v: c.rai, f: s.r ? `${eur2(s.rai)}/anno, senza IVA` : 'solo per i residenti' },
        ];
      }
      const smc = s.smc;
      const mat = s.t === 'F' ? `${nf0.format(smc)} Smc × ${nf4(s.p)} €/Smc`
        : `${nf0.format(smc)} Smc × (PSV ${nf4(r.idx)} ${s.p < 0 ? '−' : '+'} ${nf4(Math.abs(s.p))}) €/Smc`;
      const T = s.th;
      const ivaF = smc <= T ? `${nfd(s.il, 0)}% sui consumi, ${nfd(s.ih, 0)}% sulla quota fissa`
        : `${nfd(s.il, 0)}% sui primi ${nf0.format(T)} Smc, ${nfd(s.ih, 0)}% sul resto e sulla quota fissa`;
      return [
        { g: 'Venditore' },
        { id: 'energia', lab: s.t === 'F' ? 'Materia gas (prezzo fisso)' : 'Materia gas (PSV + spread)', c: 'var(--c-energia)', v: c.energia,
          f: mat + (s.sb ? ` + ${nf4(s.sb)} bilanciamento` : ''), note: `media ${nf4(c.energia / smc)} €/Smc` },
        { id: 'fisso', lab: 'Quota fissa venditore', c: 'var(--c-fisso)', v: c.fissoVenditore, f: `${eur2(s.fx)}/anno = ${eur2(s.fx / 12)}/mese` },
        { g: 'Uguali per tutti i venditori' },
        { id: 'rete', lab: 'Rete, oneri e accise', c: 'var(--c-rete)', v: c.rete, f: `12 × ${eur2(s.rf)} + ${nf0.format(smc)} Smc × ${nfd(s.rv, 3)} €/Smc` },
        { g: 'Imposte' },
        { id: 'iva', lab: 'IVA', c: 'var(--c-iva)', v: c.iva, f: ivaF },
      ];
    }

    let liveTimer = 0, hashTimer = 0;
    function recompute() {
      const st = S[kind], P = DATA[kind].params;
      const r = evalKind(kind, st.cur, P), r0 = evalKind(kind, st.base, P);
      const R = rows(kind, r, st.cur), R0 = new Map(rows(kind, r0, st.base).filter((x) => x.id).map((x) => [x.id, x.v]));
      const total = r.c.total, base = r0.c.total, d = total - base;
      const unit = kind === 'luce' ? st.cur.kwh : st.cur.smc;
      const dTxt = Math.abs(d) < 0.5 ? 'come il punto di partenza'
        : `<b class="${d > 0 ? 'up' : 'down'}">${sgn(d, eur)}</b> all'anno rispetto al punto di partenza (${eur(base)})`;
      // barra: 100% = il maggiore fra totale e partenza, con la tacca della partenza
      const scale = Math.max(total, base) || 1;
      const parts = R.filter((x) => x.id && x.v > 0.005);
      $('#simTotal').innerHTML =
        `<div class="d-total"><b>${eur(total)}</b><span>all'anno · ${eur(total / 12)}/mese</span></div>
         <p class="sim-delta">${dTxt}</p>
         <div class="stack sim-stack">${parts.map((x) => `<i style="width:${(100 * x.v / scale).toFixed(2)}%;background:${x.c}" title="${esc(x.lab)}"></i>`).join('')}
           <span class="sim-mark" style="left:${(100 * base / scale).toFixed(2)}%" title="Punto di partenza"></span></div>
         <p class="hint">${nfd(total / unit, 3)} €/${kind === 'luce' ? 'kWh' : 'Smc'} tutto compreso${kind === 'luce' ? ` · energia e quota fissa del venditore: ${Math.round(100 * (r.c.energia + r.c.fissoVenditore) * (r.P.iva) / total)}% del totale` : ` · materia e quota fissa del venditore: ${Math.round(100 * (r.c.energia + r.c.fissoVenditore) / (r.c.energia + r.c.fissoVenditore + r.c.rete))}% dell'imponibile`}</p>`;
      $('#simReceipt').innerHTML = R.map((x) => {
        if (x.g) return `<tr class="grp"><th colspan="3">${esc(x.g)}</th></tr>`;
        const dd = x.v - (R0.get(x.id) || 0);
        return `<tr><td><span class="dot" style="--c:${x.c}"></span>${esc(x.lab)}<small>${x.f}</small>${x.note ? `<small>${esc(x.note)}</small>` : ''}</td>
          <td class="dl">${Math.abs(dd) >= 0.5 ? `<span class="chg ${dd > 0 ? 'up' : 'down'}">${sgn(dd, eur)}</span>` : ''}</td><td>${eur2(x.v)}</td></tr>`;
      }).join('') + `<tr class="tot"><td>Totale annuo</td><td class="dl">${Math.abs(d) >= 0.5 ? `<span class="chg ${d > 0 ? 'up' : 'down'}">${sgn(d, eur)}</span>` : ''}</td><td>${eur2(total)}</td></tr>`;
      $('#simBar').innerHTML = `<span><b>${eur(total)}</b>/anno</span><span class="${Math.abs(d) < 0.5 ? '' : d > 0 ? 'up' : 'down'}">${Math.abs(d) < 0.5 ? 'come la partenza' : sgn(d, eur)}</span>`;
      renderChart(r, base);
      syncLevers(document.activeElement);
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { $('#simLive').textContent = `Totale ${eur(total)} all'anno${Math.abs(d) >= 0.5 ? ', ' + sgn(d, eur) + ' rispetto alla partenza' : ''}`; }, 600);
      clearTimeout(hashTimer);
      hashTimer = setTimeout(() => {
        const h = buildHash(kind, st.base, st.cur, st, params(), prof);
        history.replaceState(null, '', '#' + h);
      }, 250);
    }

    /* ----- grafico di sensibilità ----- */
    function renderChart(r, baseTotal) {
      const st = S[kind], P = DATA[kind].params, ax = axis[kind];
      const cur = sweep(kind, st.cur, P, ax, 41), bas = sweep(kind, st.base, P, ax, 41);
      const W = 640, H = 220, ml = 54, mr = 14, mt = 12, mb = 30;
      const [x0, x1] = AXES[kind][ax];
      const ys = cur.concat(bas).map((p) => p[1]);
      let y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (y1 - y0 < 20) { const m = (y0 + y1) / 2; y0 = m - 10; y1 = m + 10; }
      const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
      const X = (x) => ml + (W - ml - mr) * (x - x0) / (x1 - x0);
      const Y = (y) => mt + (H - mt - mb) * (1 - (y - y0) / (y1 - y0));
      const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
      const isIdx = ax === 'pun' || ax === 'psv';
      const xNow = isIdx ? (kind === 'luce' ? r.idx.mono : r.idx) : (kind === 'luce' ? st.cur.kwh : st.cur.smc);
      const inside = xNow >= x0 && xNow <= x1;
      const fx = (x) => (isIdx ? nfd(x, 2) : nf0.format(x));
      const ticksX = [0, 0.25, 0.5, 0.75, 1].map((t) => x0 + (x1 - x0) * t);
      const ticksY = [0, 0.5, 1].map((t) => y0 + (y1 - y0) * t);
      const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Totale annuo al variare di ${isIdx ? (kind === 'luce' ? 'PUN' : 'PSV') : 'consumo'}">
        ${ticksY.map((y) => `<line class="gl" x1="${ml}" x2="${W - mr}" y1="${Y(y)}" y2="${Y(y)}"/><text class="ty" x="${ml - 6}" y="${Y(y) + 4}">${nf0.format(Math.round(y))} €</text>`).join('')}
        ${ticksX.map((x) => `<text class="tx" x="${X(x)}" y="${H - 8}">${fx(x)}</text>`).join('')}
        <path class="base" d="${path(bas)}"/><path class="cur" d="${path(cur)}"/>
        ${inside ? `<line class="now" x1="${X(xNow)}" x2="${X(xNow)}" y1="${mt}" y2="${H - mb}"/><circle class="pt" cx="${X(xNow)}" cy="${Y(r.c.total)}" r="5.5"/>` : ''}
      </svg>`;
      // pendenza attorno al punto corrente, per la frase sotto
      const step = isIdx ? 0.01 : 100;
      const t2 = Object.assign({}, st.cur);
      if (isIdx) { t2.ix = 'custom'; t2[ax] = (xNow || 0) + step; } else t2[ax] = Math.round(xNow + step);
      const slope = evalKind(kind, t2, P).c.total - r.c.total;
      let cap;
      if (isIdx) {
        const ix = kind === 'luce' ? 'PUN' : 'PSV', u = kind === 'luce' ? 'kWh' : 'Smc';
        cap = st.cur.t === 'F' ? `Prezzo fisso: il ${ix} non cambia il totale. La linea tratteggiata è il punto di partenza.`
          : `Ogni centesimo di ${ix} in più (0,01 €/${u}) costa <b>${eur2(slope)}</b> all'anno.`;
      } else {
        const u = kind === 'luce' ? 'kWh' : 'Smc';
        const ex = st.cur.kw <= 1.5 ? ['1.800', '3.600'] : ['2.640', '4.440'];
        cap = `Ogni 100 ${u} in più costano <b>${eur2(slope)}</b> all'anno.` + (kind === 'luce' && st.cur.r && st.cur.kw <= 3
          ? ` Tra ${ex[0]} e ${ex[1]} kWh la curva è più ripida: l'esenzione dalle accise dei residenti si riduce fino a sparire.` : '');
      }
      $('#simChart').innerHTML = svg;
      $('#simChartCap').innerHTML = cap + ` <span class="leg"><i class="lc"></i> ora <i class="lb"></i> partenza</span>`;
    }

    /* ----- eventi ----- */
    function onNum(e) {
      const el = e.target;
      const key = el.dataset.key;
      if (!key) return;
      let v = parseIn(el.value);
      if (!Number.isFinite(v)) { el.classList.add('bad'); return; }
      el.classList.remove('bad');
      const sch = SCHEMA[kind][key[0] === 'p' && key.length === 2 ? 'p' : key];
      if (sch) v = Math.min(sch.max, Math.max(sch.min, sch.t === 'int' ? Math.round(v) : v));
      setVal(S[kind].cur, key, v);
      if (key === 'pun' || key === 'psv') S[kind].cur.ix = 'custom';
      recompute();
    }
    function onSlider(e) {
      const el = e.target;
      if (el.dataset.f) {
        const s = S[kind].cur, v = +el.value;
        if (el.dataset.f === 'f1') { s.f1 = v; s.f2 = Math.min(s.f2, 100 - v); } else { s.f2 = v; s.f1 = Math.min(s.f1, 100 - v); }
        updateFasce();
        recompute();
        return;
      }
      const key = el.dataset.key;
      setVal(S[kind].cur, key, +el.value);
      setPct(el);
      recompute();
    }
    function updateFasce() {
      const s = S[kind].cur, f3 = Math.max(0, 100 - s.f1 - s.f2);
      const box = document.querySelector('.sim-fasce');
      if (!box) return;
      box.querySelector('p.mini-label b').textContent = `${s.f1} / ${s.f2} / ${f3}`;
      const sp = box.querySelectorAll('.fasce-bar span');
      sp[0].style.flexBasis = s.f1 + '%'; sp[1].style.flexBasis = s.f2 + '%'; sp[2].style.flexBasis = f3 + '%';
      const lb = box.querySelectorAll('label.mini-label b');
      lb[0].textContent = s.f1 + '%'; lb[1].textContent = s.f2 + '%';
      $('#simF1').value = s.f1; $('#simF2').value = s.f2;
    }

    function bind() {
      const c = $('#simControls');
      c.addEventListener('input', (e) => {
        if (e.target.classList.contains('lev-num')) onNum(e);
        else if (e.target.type === 'range') onSlider(e);
      });
      c.addEventListener('change', (e) => {
        const t = e.target;
        if (t.classList.contains('lev-num')) {   // a fine digitazione riscrive il numero pulito
          t.classList.remove('bad');
          const key = t.dataset.key;
          t.value = fmtIn(getVal(S[kind].cur, key), meta(kind, key)[2]);
        } else if (t.id === 'simRes') { S[kind].cur.r = t.checked; recompute(); } else if (t.id === 'simNet') {
          S[kind].cur.net = t.checked; renderControls(); recompute();
        }
      });
      c.addEventListener('click', (e) => {
        const rs = e.target.closest('[data-reset]');
        if (rs) {
          const key = rs.dataset.reset, st = S[kind];
          setVal(st.cur, key, getVal(st.base, key));
          if ((key === 'pun' || key === 'psv') && st.base.ix !== 'custom') st.cur.ix = st.base.ix;
          renderControls(); recompute();
          return;
        }
        const kwb = e.target.closest('[data-kw]');
        if (kwb) { S[kind].cur.kw = +kwb.dataset.kw; renderControls(); recompute(); return; }
        const b = e.target.closest('[data-seg] button');
        if (!b) return;
        const key = b.closest('[data-seg]').dataset.seg, st = S[kind];
        let v = b.dataset.v;
        if (key === 'iva' || key === 'il') v = +v;
        if (key === 't') st.cur = convertType(kind, st.cur, DATA[kind].params, v);
        else if (key === 'm') {
          const s = st.cur, n = nP(s.m);
          s.p = [0, 1, 2].map((i) => s.p[Math.min(i, n - 1)]);   // espande il prezzo alle nuove fasce
          if (v === 'mono' && n > 1) {                           // monoraria: media pesata sulle fasce
            const f = [s.f1 / 100, s.f2 / 100, Math.max(0, 1 - (s.f1 + s.f2) / 100)];
            const w = n === 2 ? s.p[0] * f[0] + s.p[1] * (f[1] + f[2]) : s.p[0] * f[0] + s.p[1] * f[1] + s.p[2] * f[2];
            s.p = [r6(w), r6(w), r6(w)];
          } else if (v === 'bi' && n === 3) {
            const f2 = s.f2 / 100, f3 = Math.max(0, 1 - (s.f1 + s.f2) / 100);
            const w = f2 + f3 > 0 ? (s.p[1] * f2 + s.p[2] * f3) / (f2 + f3) : s.p[1];
            s.p = [s.p[0], r6(w), r6(w)];
          }
          s.m = v;
        } else st.cur[key] = v;
        renderControls(); recompute();
      });
      c.addEventListener('toggle', (e) => {
        const id = e.target.dataset && e.target.dataset.box;
        if (!id) return;
        if (e.target.open) openBoxes.add(id); else openBoxes.delete(id);
      }, true);
      $('#simResetAll').onclick = () => { const st = S[kind]; st.cur = clone(st.base); renderControls(); recompute(); };
      $('#simCopy').onclick = () => {
        const done = (ok) => { const b = $('#simCopy'); b.textContent = ok ? 'Link copiato' : 'Copia dalla barra degli indirizzi'; setTimeout(() => { b.textContent = 'Copia link'; }, 1800); };
        clearTimeout(hashTimer);
        const st = S[kind];
        history.replaceState(null, '', '#' + buildHash(kind, st.base, st.cur, st, params(), prof));
        if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(() => done(true), () => done(false));
        else done(false);
      };
      $('#simAxis').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        axis[kind] = b.dataset.v; renderAxis(); recompute();
      };
      for (const t of document.querySelectorAll('.tabs button')) {
        t.onclick = () => { if (t.dataset.kind !== kind) { kind = t.dataset.kind; ensure(kind); renderAll(); } };
      }
      // telefono: la barra col totale compare quando il riepilogo esce dallo schermo
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((es) => { document.body.classList.toggle('sim-bar-on', !es[0].isIntersecting); })
          .observe($('#simTotal'));
      }
      $('#simBar').onclick = () => $('#simTotal').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function renderAxis() {
      const items = kind === 'luce' ? [{ v: 'pun', label: 'Al variare del PUN' }, { v: 'kwh', label: 'Al variare del consumo' }]
        : [{ v: 'psv', label: 'Al variare del PSV' }, { v: 'smc', label: 'Al variare del consumo' }];
      $('#simAxis').innerHTML = items.map((it) => `<button type="button" role="radio" data-v="${it.v}" aria-checked="${it.v === axis[kind]}">${esc(it.label)}</button>`).join('');
    }

    function ensure(k) {
      if (S[k]) return;
      const b = defaults(k, DATA[k].params, prof);
      S[k] = { base: b, cur: clone(b), n: '', v: '', d: '' };
    }

    function renderHead() {
      const st = S[kind];
      const gen = String(DATA.generated_at || '').slice(0, 10);
      const title = st.n ? esc(st.n) : 'Offerta personalizzata';
      const sub = st.n ? (st.v ? esc(st.v) : 'venditore non indicato') : 'Parti da questi valori o apri il simulatore dalla scheda di un\'offerta del comparatore';
      let note = '';
      if (st.n && st.d && st.d !== gen) note = `<p class="note warn">Prezzi dell'offerta come pubblicati il ${esc(dayLabel(st.d))}: potrebbe essere cambiata o non più sottoscrivibile. PUN, PSV e voci regolate sono quelli di oggi.</p>`;
      $('#simOffer').innerHTML = `<span class="eyebrow">Punto di partenza</span><h2>${title}</h2><div class="sim-vend">${sub}</div>${note}`;
    }

    function renderAll() {
      document.body.dataset.kind = kind;
      for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t.dataset.kind === kind));
      document.querySelector('.tab-ink').style.transform = `translateX(${kind === 'gas' ? 100 : 0}%)`;
      renderHead();
      renderAxis();
      renderControls();
      recompute();
    }

    function footer() {
      const L = DATA.luce, G = DATA.gas;
      const gen = new Date(DATA.generated_at);
      $('#dataInfo').textContent = `Ogni voce del costo annuo · dati del ${isNaN(gen) ? DATA.generated_at : gen.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}`;
      $('#simFoot').innerHTML =
        `<p>Il calcolo è lo stesso del <a href="index.html">comparatore</a>: costo annuo IVA inclusa, con consumi distribuiti in modo uniforme sui 12 mesi. Il PUN e il PSV sono medie annue: in bolletta ogni mese ha il suo. Non sono inclusi sconti, bonus e penali di recesso.</p>` +
        `<p>Fonti: offerte <a href="https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page" target="_blank" rel="noopener">Portale Offerte ARERA</a> (${esc(L.source_xml)}, ${esc(G.source_xml)}); PUN GME; PSV: ${esc(G.params.psv_sources)}; voci regolate luce: ${esc(L.params.params_source)}. Rete, oneri e accise del gas sono medie nazionali.</p>`;
    }

    bind();
    fetch('offers.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => {
        DATA = d;
        const h = location.hash.slice(1);
        if (h) {
          const x = parseHash(h, params(), prof);
          kind = x.kind;
          S[kind] = { base: x.base, cur: x.cur, n: x.n, v: x.v, d: x.d };
        }
        ensure(kind);
        footer();
        renderAll();
      })
      .catch((e) => {
        $('#dataInfo').textContent = 'Non riesco a caricare i dati.';
        $('#simControls').innerHTML = `<p class="card empty">Errore nel caricamento di offers.json (${esc(e.message)}).</p>`;
      });
  }
});

if (typeof document !== 'undefined' && document.getElementById('sim') && window.EnergySim && window.EnergySim.mount) {
  window.EnergySim.mount();
}
