/* app.js — interfaccia del comparatore. Il calcolo dei costi è in engine.js. */
(function () {
  'use strict';
  const E = window.EnergyEngine;
  const $ = (s) => document.querySelector(s);
  const STORE = 'energy-offers-v1';
  const PAGE = 40;
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const MESI_LUNGHI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto',
    'settembre', 'ottobre', 'novembre', 'dicembre'];

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
    factsKind: 'luce', punRange: '5y', showDual: false,
  };
  let state = Object.assign({}, DEFAULTS);
  try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* stato corrotto: default */ }
  state.search = '';

  let DATA = null;
  let LIVE = null;               // offerte di oggi, da ripristinare uscendo dalla macchina del tempo
  // Macchina del tempo: DATA diventa lo snapshot history/YYYY-MM/offers.json, con
  // due set di parametri: params ("allora") e params_hindsight ("col senno di poi").
  const TM = { on: false, month: null, mode: 'then', index: null, cache: new Map(), showOdd: false };
  let shown = PAGE;
  let lastRows = [];
  const nodes = new Map();       // `${kind}-${id}` → <li>
  const detailCache = new Map(); // `${kind}-${shard}` → Promise<dict>

  /* ---------------- calcolo ---------------- */

  // Soglia delle fisse implausibili (studio 2022-2026, time_machine.drop_implausible):
  // materia sotto metà del minimo fra media 12 mesi e ultimo mese dell'indice
  // (luce × perdite). Gli snapshot storici la portano già calcolata.
  function oddFloor(kind, P) {
    if (P.implausible_floor) return P.implausible_floor * (P.implausible_ratio || 0.5);
    if (kind === 'luce') return 0.5 * Math.min(P.pun_12m.mono, P.pun_last.mono) * P.lambda;
    return 0.5 * Math.min(P.psv_12m, P.psv_last.value);
  }

  // Modo effettivo: "poi" solo se lo snapshot ha il senno di poi.
  const tmPoi = (kind) => TM.on && TM.mode === 'poi' && !!(DATA[kind] && DATA[kind].params_hindsight);
  const idxOf = (kind, P) => (kind === 'luce' ? E.punIndex(P, '12m') : E.psvIndex(P, '12m'));
  const costOf = (kind, o, P, pr, idx) => (kind === 'luce' ? E.costLuce(o, P, pr, idx) : E.costGas(o, P, pr, idx));

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

  // opts.market: per le curiosità del tab Mercato — solo regione e profilo,
  // senza i filtri di tipo/durata/ricerca della classifica.
  function compute(kindArg, opts) {
    const kind = kindArg || state.kind;
    const market = !!(opts && opts.market);
    const block = DATA[kind];
    const q = market ? '' : state.search.trim().toLowerCase();
    const rows = [];
    let pr, idx;
    const scen = opts && opts.scenario;
    let P = block.params, Palt = null, idxAlt = null;
    if (kind === 'luce') { pr = luceProfile(); idx = scen ? E.punIndex(block.params, scen, opts.custom) : E.punIndex(block.params, state.punScen, state.punCustom); }
    else { pr = gasProfile(); idx = scen ? E.psvIndex(block.params, scen, opts.custom) : E.psvIndex(block.params, state.psvScen, state.psvCustom); }
    if (TM.on) {
      // indice fissato dal modo: "allora" = media dei 12 mesi prima, "poi" = effettivo dopo
      const poi = tmPoi(kind);
      P = poi ? block.params_hindsight : block.params;
      Palt = poi ? block.params : block.params_hindsight;
      idx = idxOf(kind, P);
      if (Palt) idxAlt = idxOf(kind, Palt);
    }
    // Offerte vendibili solo insieme all'altra fornitura: fuori dalle classifiche
    // singole salvo richiesta; il tab Insieme le chiede esplicitamente.
    const withDual = !!(opts && opts.includeDual) || (!market && state.showDual);
    // Macchina del tempo: fisse con la materia sotto metà dell'ingrosso di allora
    // (una sola componente pubblicata come prezzo), come time_machine.py.
    const floor = oddFloor(kind, block.params);
    let hiddenOdd = 0, odd = 0;
    for (const o of block.offers) {
      if (o.so === 0 && !withDual) continue;
      if (!market && state.type !== 'all' && o.t !== state.type) continue;
      if (!market && state.durata > 0 && o.t === 'F' && o.d > state.durata) continue;
      if (state.regione && o.r.length && !o.r.includes(state.regione)) continue;
      if (state.eligible && !(kind === 'luce' ? eligibleLuce(o, pr) : eligibleGas(o, pr))) continue;
      if (q && !(o.n.toLowerCase().includes(q) || o.v.includes(q))) continue;
      const c = costOf(kind, o, P, pr, idx);
      const row = { o, c, total: c.total };
      if (floor && o.t === 'F' && c.energia / (kind === 'luce' ? pr.kwh : pr.smc) < floor) {
        // nella macchina del tempo nascoste (bottone "Mostra"), oggi solo marcate
        if (TM.on && !TM.showOdd) { hiddenOdd++; continue; }
        row.odd = true; odd++;
      }
      if (Palt) row.alt = costOf(kind, o, Palt, pr, idxAlt).total;   // l'altro modo, per il delta
      rows.push(row);
    }
    rows.sort((a, b) => a.total - b.total);
    return { rows, pr, idx, hiddenOdd, odd };
  }

  /* ---------------- render lista ---------------- */

  function badges(o, c, kind) {
    const b = [];
    b.push(o.t === 'F'
      ? `<span class="badge F" title="${esc(o.d > 12
          ? `Prezzo bloccato per ${o.d} mesi. Nei dati 2022-2026 i fissi oltre i 12 mesi hanno battuto il rinnovo annuale solo se firmati prima di un rialzo.`
          : 'Prezzo dell\'energia bloccato per la durata indicata. Oneri, rete e imposte cambiano comunque ogni trimestre.')}">Fissa${o.d > 0 ? ' ' + o.d + ' mesi' : ''}</span>`
      : `<span class="badge V" title="Prezzo legato all'indice all'ingrosso del mese (PUN o PSV) più uno spread fisso">Variabile</span>`);
    const left = daysLeft(o);
    if (left != null && left <= 7) b.push(`<span class="badge warn" title="Si può sottoscrivere fino al ${esc(o.al.split('-').reverse().join('/'))}. Nel 2026 più della metà dei prezzi fissi è cambiata entro il mese, quasi sempre al rialzo: confronta e firma lo stesso giorno.">⏳ ${left === 0 ? 'scade oggi' : left === 1 ? 'ancora 1 giorno' : `ancora ${left} giorni`}</span>`);
    if (kind === 'luce') b.push(`<span class="badge fasce">${o.m === 'mono' ? 'monoraria' : o.m === 'bi' ? 'bioraria' : 'multioraria'}</span>`);
    if (o.so === 0) b.push(`<span class="badge dual" title="Si sottoscrive solo insieme all'altra fornitura dello stesso venditore">🔗 solo con ${kind === 'luce' ? 'il gas' : 'la luce'}</span>`);
    if (o.r.length) b.push(`<span class="badge" title="Offerta con restrizione territoriale">📍 ${o.r.length > 10 ? 'quasi tutte' : o.r.length + (o.r.length === 1 ? ' regione' : ' regioni')}</span>`);
    // <PROVINCIA>/<COMUNE> restringono oltre la regione (o anche senza alcuna
    // <REGIONE>, il caso che il badge sopra non vedeva affatto): nessun
    // selettore per provincia/comune qui, solo l'avviso — stesso limite del
    // --regione lato CLI (apps/energy-monitor/AGENTS.md).
    else if ((o.pr && o.pr.length) || (o.cm && o.cm.length)) b.push(`<span class="badge" title="Offerta ristretta a provincia/comune specifici, non filtrabile qui">📍 zona ristretta</span>`);
    const fix = c.fissoVenditore;
    const susp = DATA[kind].params.suspicious_fix_annual;
    if (fix > 0 && fix < susp) b.push(`<span class="badge warn" title="Quota fissa sospetta: a volte è un errore di unità (€/mese scritto come €/anno)">⚠ quota fissa</span>`);
    if (o.t === 'F' && o.d > 0) b.push(`<span class="badge" title="Penale di recesso non pubblicata nei dati ARERA">❓ recesso</span>`);
    return b.join('');
  }

  // Giorni alla scadenza del listino (DATA_FINE): solo per le offerte di oggi.
  function daysLeft(o) {
    if (TM.on || !o.al) return null;
    const end = new Date(o.al + 'T23:59:59'), now = new Date();
    const d = Math.floor((end - now) / 86400000);
    return d >= 0 ? d : null;
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
        `<span class="price"><b>${eur(r.total)}</b>${TM.on ? tmAltLine(r, kind) : `<span>${eur(r.total / 12)}/mese</span>`}` +
        `<em>${i === 0 ? 'la più economica' : '+' + eur(delta)}</em></span>` +
        `<span class="meta">${esc(r.o.v || '—')} ${r.odd ? `<span class="badge bad" title="Il prezzo dell'energia è sotto metà del prezzo all'ingrosso: quasi sempre è una sola componente pubblicata come prezzo. Verifica la scheda del venditore.">⚠ prezzo implausibile</span>` : ''}${badges(r.o, r.c, kind)}</span>` +
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

  // Riga secondaria della macchina del tempo: il prezzo nell'altro modo e il delta poi − allora.
  function tmAltLine(r, kind) {
    if (r.alt == null) return `<span class="tm-alt">col senno di poi: non ancora</span>`;
    const poi = tmPoi(kind);
    const then = poi ? r.alt : r.total, after = poi ? r.total : r.alt, d = after - then;
    const cls = d > 0.5 ? 'up' : d < -0.5 ? 'down' : '';
    return `<span class="tm-alt ${cls}">${poi ? 'allora ' + eur(then) : 'poi ' + eur(after)} · ${d >= 0 ? '+' : '−'}${eur(Math.abs(d))}</span>`;
  }

  // Nella scheda: l'altro prezzo e il delta, sempre "poi − allora".
  function tmDetailLine(row, kind) {
    const poi = tmPoi(kind);
    const then = poi ? row.alt : row.total, after = poi ? row.total : row.alt, d = after - then;
    const dTxt = `${d >= 0 ? '+' : '−'}${eur(Math.abs(d))}`;
    return `<div class="d-rank">${poi ? `Allora, sulla carta: <b>${eur(then)}</b> · col senno di poi ${dTxt}`
      : `Col senno di poi: <b>${eur(after)}</b> (${dTxt})`}</div>`;
  }

  function renderVerdict(res) {
    const box = $('#tmVerdict');
    const rows = res.rows.filter((r) => !r.odd);
    if (!TM.on || !rows.length || state.kind === 'dual') { box.hidden = true; return; }
    box.hidden = false;
    const kind = state.kind;
    const nOdd = res.hiddenOdd || res.odd;
    const oddTxt = nOdd ? ` <span class="tm-odd">${nOdd === 1 ? 'Una fissa ha' : nOdd + ' fisse hanno'} un prezzo sotto metà dell'ingrosso di allora, quasi sempre una sola componente pubblicata come prezzo: ${res.hiddenOdd ? (nOdd === 1 ? 'è nascosta' : 'sono nascoste') : 'sono marcate ⚠ e fuori da questo confronto'}. <button type="button" id="tmOddBtn">${res.hiddenOdd ? 'Mostra' : 'Nascondi'}</button></span>` : '';
    const bindOdd = () => { const b = $('#tmOddBtn'); if (b) b.onclick = () => { TM.showOdd = !TM.showOdd; update({}); }; };
    if (rows[0].alt == null) {
      box.innerHTML = 'Col senno di poi non si può ancora dire: nessun mese di fornitura dopo questo snapshot è chiuso.' + oddTxt;
      bindOdd();
      return;
    }
    const poi = tmPoi(kind);
    const thenOf = (r) => (poi ? r.alt : r.total), poiOf = (r) => (poi ? r.total : r.alt);
    const first = rows.reduce((a, r) => (thenOf(r) < thenOf(a) ? r : a));
    const bestPoi = rows.reduce((a, r) => (poiOf(r) < poiOf(a) ? r : a));
    const tipo = (r) => (r.o.t === 'F' ? 'fissa' : 'variabile');
    const d = poiOf(first) - thenOf(first);
    let txt = `La prima di allora, <b>${esc(first.o.n)}</b> (${tipo(first)}), costava ${eur(thenOf(first))} sulla carta e <b>${eur(poiOf(first))}</b> col senno di poi (${d >= 0 ? '+' : '−'}${eur(Math.abs(d))}).`;
    if (bestPoi !== first) {
      const rankThen = rows.filter((r) => thenOf(r) < thenOf(bestPoi)).length + 1;
      txt += ` Col senno di poi la migliore era <b>${esc(bestPoi.o.n)}</b> (${tipo(bestPoi)}, ${rankThen}ª allora): ${eur(poiOf(bestPoi))}, ${eur(poiOf(first) - poiOf(bestPoi))} in meno.`;
    } else txt += ' Ed era anche la migliore col senno di poi.';
    box.innerHTML = txt + oddTxt;
    bindOdd();
  }

  // "Fisso o variabile?": la regola dei due controlli dello studio 2022-2026,
  // sulle offerte di oggi con regione e profilo scelti (non i filtri di tipo).
  function renderSignal() {
    const box = $('#fvSignal');
    const kind = state.kind;
    if (TM.on || (kind !== 'luce' && kind !== 'gas')) { box.hidden = true; return; }
    const P = DATA[kind].params;
    const ratio = kind === 'luce' ? P.pun_last.mono / P.pun_12m.mono : P.psv_last.value / P.psv_12m;
    // senza regione scelta solo offerte nazionali; mai quelle limitate a provincia/comune
    const plain = (rows) => rows.filter((r) => !r.odd && (state.regione || !r.o.r.length)
      && !(r.o.pr && r.o.pr.length) && !(r.o.cm && r.o.cm.length));
    const r12 = plain(compute(kind, { market: true, scenario: '12m' }).rows);
    const rLast = plain(compute(kind, { market: true, scenario: 'last' }).rows);
    const f = r12.find((r) => r.o.t === 'F'), v12 = r12.find((r) => r.o.t === 'V'), vl = rLast.find((r) => r.o.t === 'V');
    if (!f || !v12 || !vl) { box.hidden = true; return; }
    const s = E.fixVarSignal(ratio, f.total, v12.total, vl.total);
    const idx = kind === 'luce' ? 'PUN' : 'PSV';
    const last = monthLabel(kind === 'luce' ? P.pun_last.month : P.psv_last.month);
    const r = ratio.toLocaleString('it-IT', { maximumFractionDigits: 2 });
    let head, body;
    if (s.regime === 'calm') {
      head = 'Mercato calmo: fisso e variabile quasi si equivalgono';
      body = `Il ${idx} di ${last} è ${r} volte la media dei 12 mesi. In queste condizioni, nei dati 2022-2026, la scelta tra fisso e variabile valeva circa 20 € l'anno: decidi sulle condizioni del contratto.`;
    } else {
      const dir = s.regime === 'up' ? 'più economiche' : 'più care';
      head = s.choice === 'F' ? 'Il segnale indica il fisso' : 'Il segnale indica il variabile';
      body = `Il ${idx} di ${last} è ${r} volte la media dei 12 mesi su cui è calcolata la classifica, che quindi mostra le variabili ${dir} di quanto probabilmente saranno. Al ${idx} di ${last} la variabile migliore costerebbe ${eur(vl.total)} invece di ${eur(v12.total)}; la fissa migliore costa ${eur(f.total)}`
        + (s.premium > E.PREMIUM_CAP ? `, cioè il ${Math.round(s.premium * 100)}% in più della variabile in classifica: nel 2022 fissare con un premio così è costato caro.` : '.');
    }
    box.className = 'fv-signal ' + s.regime + ' ' + (s.regime === 'calm' ? '' : s.choice);
    const where = state.regione ? `in ${DATA.regioni[state.regione] || state.regione}` : 'in tutta Italia';
    box.innerHTML = `<b>${esc(head)}</b><span>${body} Offerte attivabili ${esc(where)}, al consumo scelto. <a href="analisi.html">Perché? L'analisi di 58 mesi di offerte</a></span>`;
    box.hidden = false;
  }

  function renderSummary(res) {
    const rows = res.rows;
    const st = $('#stats');
    renderVerdict(res);
    renderSignal();
    if (!rows.length) { st.innerHTML = ''; $('#histo').innerHTML = ''; return; }
    const totals = rows.map((r) => r.total);
    const med = totals[Math.floor(totals.length / 2)];
    const unit = state.kind === 'luce' ? state.kwh : state.smc;
    st.innerHTML =
      `<div class="stat best"><b>${eur(totals[0])}</b><span>${TM.on ? (tmPoi(state.kind) ? 'migliore, poi' : 'migliore, allora') : 'migliore'}</span></div>` +
      `<div class="stat"><b>${eur(med)}</b><span>mediana</span></div>` +
      `<div class="stat"><b>${nf0.format(rows.length)}</b><span>offerte</span></div>`;
    const nudge = $('#nudge');
    const top = rows[0].o;
    if (!state.regione && top.r.length) {
      const where = top.r.length === 1 ? (DATA.regioni[top.r[0]] || top.r[0]) : `${top.r.length} regioni`;
      nudge.innerHTML = `La prima è attivabile solo in ${esc(where)}. <button type="button" id="nudgeBtn">Scegli dove abiti</button> per vedere solo le offerte valide per te.`;
      nudge.hidden = false;
      $('#nudgeBtn').onclick = () => { const s = $('#regione'); s.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => s.focus(), 350); };
    } else if ((top.pr && top.pr.length) || (top.cm && top.cm.length)) {
      // Stesso avviso della regione, ma senza bottone: qui non c'è un
      // selettore provincia/comune da aprire, solo l'avviso che la prima
      // potrebbe non essere attivabile dove abiti.
      nudge.innerHTML = `La prima è limitata a una provincia/comune specifici (non filtrabile qui): verifica la scheda prima di attivarla.`;
      nudge.hidden = false;
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
      `<button type="button" role="radio" data-v="${it.v}" aria-checked="${it.v === current}"${it.title ? ` title="${esc(it.title)}"` : ''}>${esc(it.label)}${it.small ? `<small>${esc(it.small)}</small>` : ''}</button>`).join('');
    container.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
  }

  function syncControls() {
    document.body.dataset.kind = state.kind;
    for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t.dataset.kind === state.kind));
    const tabIdx = { luce: 0, gas: 1, dual: 2, mercato: 3 }[state.kind] || 0;
    document.querySelector('.tab-ink').style.transform = `translateX(${tabIdx * 100}%)`;

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
      { v: '33-31', label: 'Tipica' }, { v: '18-28', label: '☀️ Con fotovoltaico' },
      { v: '20-30', label: 'Fuori casa di giorno' }, { v: '40-30', label: 'Smart working' },
    ], `${f1}-${f2}`, (v) => { const [a, b] = v.split('-').map(Number); update({ f1: a, f2: b }); });
    // Profilo misurato su 11 bollette di una casa con 6,56 kWp senza batteria:
    // i pannelli coprono il giorno feriale, dalla rete si preleva sera e notte.
    const pv = f1 === 18 && f2 === 28;
    $('#pvNote').hidden = !pv;
    if (pv) $('#kwhHint').textContent = `≈ ${nf0.format(state.kwh / 12)} kWh al mese prelevati dalla rete`;

    if (DATA) syncTimeMachine();
    if (DATA) {
      const lp = DATA.luce.params;
      seg($('#punSeg'), [
        { v: '12m', label: 'Media 12 mesi', small: nf3(lp.pun_12m.mono) + ' €/kWh', title: "Media dei 12 mesi chiusi, il metodo del Portale ARERA. Quando i prezzi all'ingrosso salgono fa sembrare le variabili più economiche, quando scendono più care." },
        { v: 'last', label: 'Ultimo mese', small: `${monthLabel(lp.pun_last.month)} · ${nf3(lp.pun_last.mono)}`, title: "Prezzo dell'ultimo mese chiuso. Nei dati 2022-2026 ha previsto i 12 mesi successivi meglio della media: è il controllo da fare prima di scegliere tra fisso e variabile." },
        { v: 'custom', label: 'A scelta', small: nf3(state.punCustom) },
      ], state.punScen, (v) => update({ punScen: v }));
      const gp = DATA.gas.params;
      seg($('#psvSeg'), [
        { v: '12m', label: 'Media 12 mesi', small: nf3(gp.psv_12m) + ' €/Smc', title: "Media dei 12 mesi chiusi, il metodo del Portale ARERA. Quando i prezzi all'ingrosso salgono fa sembrare le variabili più economiche, quando scendono più care." },
        { v: 'last', label: 'Ultimo mese', small: `${monthLabel(gp.psv_last.month)} · ${nf3(gp.psv_last.value)}`, title: "Prezzo dell'ultimo mese chiuso. Nei dati 2022-2026 ha previsto i 12 mesi successivi meglio della media: è il controllo da fare prima di scegliere tra fisso e variabile." },
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
    const ms = $('#miniSlider'), src = state.kind === 'gas' ? smc : kwh;
    ms.min = src.min; ms.max = src.max; ms.step = src.step; ms.value = src.value; setPct(ms);
    $('#miniVal').textContent = state.kind === 'gas' ? `${nf0.format(state.smc)} Smc` : `${nf0.format(state.kwh)} kWh`;

    // riassunto del pannello impostazioni
    const typeTxt = { all: 'tutte', F: 'solo fisse', V: 'solo variabili' }[state.type];
    if (TM.on) {
      const lbl = TM.mode === 'poi' ? 'prezzi col senno di poi' : 'prezzi di allora';
      const typeTxt0 = { all: 'tutte', F: 'solo fisse', V: 'solo variabili' }[state.type];
      $('#settingsTxt').textContent = (state.kind === 'gas' ? [lbl, typeTxt0]
        : [`${String(state.kw).replace('.', ',')} kW`, state.residente ? 'residente' : 'non residente', lbl, typeTxt0]).join(' · ');
    }
    const parts = state.kind === 'dual'
      ? [`${String(state.kw).replace('.', ',')} kW`, state.residente ? 'residente' : 'non residente', `PUN ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.punCustom) }[state.punScen]}`, `PSV ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.psvCustom) }[state.psvScen]}`, typeTxt]
      : state.kind === 'luce'
      ? [`${String(state.kw).replace('.', ',')} kW`, state.residente ? 'residente' : 'non residente', `PUN ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.punCustom) }[state.punScen]}`, typeTxt]
      : [`PSV ${{ '12m': '12 mesi', last: 'ultimo mese', custom: nf3(state.psvCustom) }[state.psvScen]}`, typeTxt];
    if (state.durata) parts.push(`fisso ≤ ${state.durata} mesi`);
    if (!TM.on) $('#settingsTxt').textContent = parts.join(' · ');

    // filtri
    for (const b of document.querySelectorAll('#typeSeg button')) b.setAttribute('aria-checked', String(b.dataset.v === state.type));
    $('#regione').value = state.regione;
    $('#durata').value = String(state.durata);
    $('#eligible').checked = state.eligible;
    $('#showDual').checked = state.showDual;
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
      if (state.kind === 'mercato') {
        if (window.EnergyMarket) window.EnergyMarket.render();
        return;
      }
      if (state.kind === 'dual') { renderDual(); return; }
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
    $('#showDual').addEventListener('change', (e) => update({ showDual: e.target.checked }));
    $('#dualView').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]'); if (!b) return;
      const k = b.dataset.k, rows = k === 'luce' ? lastDual.L : lastDual.G;
      const pos = rows.findIndex((r) => r.o.id === +b.dataset.id);
      if (pos >= 0) openRow(k, rows[pos], pos, rows);
    });
    $('#sheetBody').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-twin]'); if (!b) return;
      const k = b.dataset.twin;
      const rows = compute(k, { market: true, includeDual: true }).rows;
      const pos = rows.findIndex((r) => r.o.id === +b.dataset.id);
      if (pos >= 0) openRow(k, rows[pos], pos, rows);
    });
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
      $('.top').classList.toggle('show-mini', state.kind !== 'mercato' && !!h && !mq.matches && h.getBoundingClientRect().bottom < 120);
    };
    window.addEventListener('scroll', miniToggle, { passive: true });
    window.addEventListener('resize', miniToggle);
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------------- tab Insieme (luce + gas) ---------------- */

  let lastDual = { L: [], G: [] };
  function renderDual() {
    const L = compute('luce', { includeDual: true }).rows;
    const G = compute('gas', { includeDual: true }).rows;
    lastDual = { L, G };
    const res = E.dualRanking(L, G);
    const box = $('#dualView');
    if (!res.separate || !res.vendors.length) {
      box.innerHTML = '<div class="card empty">Nessuna combinazione luce + gas con questi filtri.</div>';
      return;
    }
    const sep = res.separate, top = res.vendors[0];
    const pairBtn = (r, k) => `<button type="button" data-k="${k}" data-id="${r.o.id}"><span class="k">${k === 'luce' ? '⚡' : '🔥'}</span><span class="n">${esc(r.o.n)}</span><span class="s">${esc(r.o.v || '—')} · ${r.o.t === 'F' ? 'fissa' : 'variabile'}${r.o.so === 0 ? ' · solo in coppia' : ''}</span><span class="e">${eur(r.total)}</span></button>`;
    const tipoLabel = { dual: '<span class="badge dual">offerta luce+gas</span>', 'dual?': '<span class="badge warn">abbinamento da verificare</span>', separate: '<span class="badge">due offerte singole</span>' };
    const extra = top.total - sep.total;
    const sameAsSep = sep.l.o.pv && sep.l.o.pv === sep.g.o.pv;
    const vendWins = extra < -0.5;           // una coppia dello stesso venditore batte tutto
    const best = vendWins ? top : sep;
    let headline, extraTxt;
    if (vendWins) {
      headline = 'La combinazione migliore: un solo fornitore';
      extraTxt = `${top.tipo === 'dual' ? "Un'offerta luce+gas" : 'Un solo fornitore'} batte di <b>${eur(-extra)}</b> l'anno la migliore combinazione di offerte singole (${esc(sep.l.o.v)} + ${esc(sep.g.o.v)}, ${eur(sep.total)}).`;
    } else {
      headline = sameAsSep ? 'La combinazione migliore (stesso fornitore)' : 'La combinazione migliore: due fornitori';
      extraTxt = extra > 0.5
        ? `Con un solo fornitore la coppia migliore è <b>${esc(top.v)}</b> a ${eur(top.total)}: <b>${eur(extra)} in più all'anno</b>, il prezzo della comodità di avere un solo fornitore.`
        : `Il fornitore unico più conveniente, <b>${esc(top.v)}</b>, costa come la combinazione migliore: qui la comodità è gratis.`;
    }
    // Le coppie dual battono mai le offerte singole dello stesso venditore?
    const gById = new Map(G.map((r) => [r.o.id, r]));
    const bestSingle = (rows, pv) => rows.find((r) => r.o.pv === pv && r.o.so !== 0);
    let nDual = 0, nCheaper = 0, maxGap = 0;
    for (const l of L) {
      if (l.o.so !== 0 || l.o.tw == null || !gById.has(l.o.tw)) continue;
      const g = gById.get(l.o.tw), sl = bestSingle(L, l.o.pv), sg = bestSingle(G, l.o.pv);
      if (!sl || !sg) continue;
      nDual++;
      const gap = l.total + g.total - (sl.total + sg.total);
      if (gap < -0.5) nCheaper++; else maxGap = Math.max(maxGap, gap);
    }
    const dualVerdict = !nDual ? '' : nCheaper === 0
      ? `<p class="dual-note"><b>Le offerte vendute solo in coppia non convengono:</b> per nessuna delle ${nDual} coppie luce+gas attivabili il prezzo è più basso di quello delle offerte singole dello stesso venditore (fino a ${eur(maxGap)} l'anno in più). Unica eccezione possibile: bonus e sconti dual, che i dati ARERA non quantificano.</p>`
      : `<p class="dual-note">${nCheaper} delle ${nDual} coppie luce+gas costano meno delle offerte singole dello stesso venditore.</p>`;
    const vend = res.vendors.slice(0, shown);
    box.innerHTML =
      `<section class="card dual-best">
        <h2>${headline}</h2>
        <div class="big">${eur(best.total)}<small>all'anno · ${eur(best.total / 12)}/mese</small></div>
        <div class="pair">${pairBtn(best.l, 'luce')}${pairBtn(best.g, 'gas')}</div>
        <p>${extraTxt}</p>
      </section>
      ${dualVerdict}
      <p class="dual-note">Stesso fornitore per luce e gas: per ogni venditore la coppia più economica, fra le sue offerte singole e le offerte vendute solo in coppia. Sconti e bonus dual non sono inclusi.</p>
      <ol class="vendor-list">${vend.map((v, i) => `<li class="vendor">
        <div class="vendor-head"><span class="rank">${i + 1}</span><span class="vn">${esc(v.v || '—')}</span>
          <span class="vt"><b>${eur(v.total)}</b><span>${v.total - best.total > 0.5 ? '+' + eur(v.total - best.total) : 'la migliore'}</span></span>
          <span class="vm">${tipoLabel[v.tipo] || ''}</span></div>
        <div class="pair">${pairBtn(v.l, 'luce')}${pairBtn(v.g, 'gas')}</div>
      </li>`).join('')}</ol>` +
      (res.vendors.length > shown ? `<button class="more" id="moreDual">Mostra altri venditori (${nf0.format(res.vendors.length - shown)})</button>` : '');
    const md = $('#moreDual');
    if (md) md.onclick = () => { shown += PAGE; update({}, { keepPage: true }); };
  }

  /* ---------------- dettaglio ---------------- */

  function loadDetails(kind, id) {
    if (!DATA.detail_shards) return Promise.resolve(null);   // snapshot storico: schede non archiviate
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
    const pos = lastRows.findIndex((r) => r.o.id === id);
    if (pos >= 0) openRow(state.kind, lastRows[pos], pos, lastRows);
  }

  function openRow(kind, row, pos, rows) {
    const id = row.o.id;
    const sheet = $('#sheet'), bd = $('#backdrop');
    sheet.dataset.kind = kind;   // palette di luce/gas anche se aperto dal tab Mercato
    $('#sheetBody').innerHTML = detailHead(row, pos, kind, rows) + `<div id="dRest" class="loading">Carico i dettagli…</div>`;
    sheet.hidden = false; bd.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('on'); bd.classList.add('on'); });
    $('#sheetBody').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    history.pushState({ sheet: id }, '');
    $('#sheetClose').focus({ preventScroll: true });
    loadDetails(kind, id).then((d) => {
      const rest = $('#dRest'); if (!rest) return;
      rest.className = '';
      rest.innerHTML = d ? detailRest(row, d, kind)
        : TM.on ? detailRest(row, {}, kind) + '<p class="note">Per i mesi passati la scheda completa del venditore (voci, sconti, condizioni) non è archiviata: restano prezzi e totali.</p>'
        : '<p class="note">Dettagli non disponibili.</p>';
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
      [TM.on ? 'IVA' : 'IVA (10% / 22%)', c.iva, 'var(--c-iva)'],
    ];
  }

  function detailHead(row, pos, kind, rows) {
    const { o, c } = row;
    const parts = breakdown(c, kind).filter((p) => Math.abs(p[1]) > 0.005);
    const pos_ = parts.filter((p) => p[1] > 0);
    const sumPos = pos_.reduce((a, p) => a + p[1], 0) || 1;
    return `<header class="d-head">
        <div class="badges">${badges(o, c, kind)}</div>
        <h2 id="sheetTitle">${esc(o.n)}</h2>
        <div class="vendor">${esc(o.v || 'venditore non indicato')}</div>
      </header>
      <div class="d-total"><b>${eur(row.total)}</b><span>all'anno · ${eur(row.total / 12)}/mese${TM.on ? (tmPoi(kind) ? ' · col senno di poi' : ' · allora') : ''}</span></div>
      ${TM.on && row.alt != null ? tmDetailLine(row, kind) : ''}
      <div class="d-rank">${pos + 1}° su ${nf0.format(rows.length)} con i filtri attuali${pos > 0 ? ` · +${eur(row.total - rows[0].total)} rispetto alla prima` : ''}</div>
      <div class="stack">${pos_.map((p) => `<i style="width:${(100 * p[1] / sumPos).toFixed(2)}%;background:${p[2]}" title="${esc(p[0])}"></i>`).join('')}</div>
      <div class="legend">${parts.map((p) => `<span class="k" style="--c:${p[2]}">${esc(p[0])}</span><span class="v">${eur2(p[1])}</span>`).join('')}
        <span class="k tot" style="--c:transparent">Totale annuo</span><span class="v tot">${eur2(row.total)}</span></div>`;
  }

  function priceRows(o, kind) {
    const P = tmPoi(kind) ? DATA[kind].params_hindsight : DATA[kind].params;
    if (kind === 'gas') {
      if (o.t === 'F') return [['Prezzo gas fisso', nf4(o.p) + ' €/Smc']].concat(o.sb ? [['Oneri di bilanciamento', nf4(o.sb) + ' €/Smc']] : []);
      const psv = TM.on ? idxOf('gas', P) : E.psvIndex(P, state.psvScen, state.psvCustom);
      return [['Spread sul PSV', '+' + nf4(o.p) + ' €/Smc'], ['PSV usato', nf4(psv) + ' €/Smc'],
        ['Prezzo risultante', nf4(psv + o.p + (o.sb || 0)) + ' €/Smc']].concat(o.sb ? [['di cui bilanciamento', nf4(o.sb) + ' €/Smc']] : []);
    }
    const idx = TM.on ? idxOf('luce', P) : E.punIndex(P, state.punScen, state.punCustom);
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
    if ((o.pr && o.pr.length) || (o.cm && o.cm.length)) notes.push('Offerta ristretta a una provincia/comune specifici (vedi "Dove" sotto): nessun filtro qui, verifica che il tuo comune sia incluso prima di attivarla.');
    if (notes.length) out.push(notes.map((n) => `<p class="note warn">${esc(n)}</p>`).join(''));
    if (o.so === 0) {
      const other = kind === 'luce' ? 'gas' : 'luce';
      const twin = o.tw != null ? DATA[other].offers[o.tw] : null;
      out.push(`<p class="note warn">Si sottoscrive solo insieme ${other === 'gas' ? 'al gas' : 'alla luce'} dello stesso venditore: da sola non è attivabile. ${twin ? `L'offerta gemella è <b>${esc(twin.n)}</b>.` : 'Nei dati ARERA la gemella non è indicata: chiedila al venditore.'} Il confronto della coppia è nel tab Insieme.</p>`
        + (twin ? `<div class="actions"><button type="button" class="btn" data-twin="${other}" data-id="${twin.id}">Apri l'offerta ${other} gemella</button></div>` : ''));
    }

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
    let regs = o.r.length ? o.r.map((r) => DATA.regioni[r] || r).join(', ') : 'tutta Italia';
    // <PROVINCIA>/<COMUNE> (cod. ISTAT, nessuna tabella nomi qui) si sommano
    // alla regione: codici grezzi, come per --scheda in offer_search.py.
    if (o.pr && o.pr.length) regs += ` · solo provincia ${o.pr.join(', ')}`;
    if (o.cm && o.cm.length) regs += ` · solo comune ${o.cm.join(', ')}`;
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
    if (TM.on) { footerTM(); return; }
    const gen = new Date(DATA.generated_at);
    const genTxt = isNaN(gen) ? DATA.generated_at : gen.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
    $('#dataInfo').textContent = `${nf0.format(L.offers.length)} offerte luce · ${nf0.format(G.offers.length)} gas · aggiornato ${genTxt}`;
    const ser = L.params.pun_series;
    $('#foot').innerHTML =
      (DATA.warnings && DATA.warnings.length ? `<div class="warnbox">Dati non del tutto aggiornati: ${DATA.warnings.map(esc).join(' · ')}</div>` : '') +
      `<p><a href="analisi.html">Fisso o variabile: cosa insegnano 58 mesi di offerte luce e gas</a>, l'analisi del mercato 2022-2026 fatta con questi dati.</p>` +
      `<p>Costo annuo IVA inclusa, calcolato con lo stesso modello di <code>check_offers.py</code>: energia, quota fissa del venditore, dispacciamento, rete, oneri di sistema, accise, IVA e, per i residenti, canone RAI. Le variabili usano il PUN o il PSV scelto sopra. Non sono inclusi sconti, bonus e penali di recesso.</p>` +
      `<p>Fonti: offerte <a href="https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page" target="_blank" rel="noopener">Portale Offerte ARERA</a> (${esc(L.source_xml)}, ${esc(G.source_xml)}); PUN GME, media ${ser.length > 1 ? `${monthLabel(ser[ser.length - 12] ? ser[ser.length - 12][0] : ser[0][0])} – ${monthLabel(ser[ser.length - 1][0])}` : ''}; PSV: ${esc(G.params.psv_sources)}; parametri regolati ${esc(L.params.params_source)}. I costi di rete del gas sono medie nazionali, modificabili.</p>`;
    // regioni
    const sel = $('#regione');
    sel.innerHTML = `<option value="">Tutta Italia</option>` + Object.entries(DATA.regioni)
      .sort((a, b) => a[1].localeCompare(b[1], 'it')).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    sel.value = state.regione;
  }

  /* ---------------- macchina del tempo ---------------- */

  const monthName = (m) => { const [y, mm] = m.split('-'); return `${MESI_LUNGHI[+mm - 1]} ${y}`; };
  const winLabel = (w) => (w ? `${monthLabel(w[0].split('-').reverse().map(Number).join('/'))} – ${monthLabel(w[1].split('-').reverse().map(Number).join('/'))}` : '');
  const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

  function syncTimeMachine() {
    document.body.classList.toggle('tm-on', TM.on);
    if (!TM.on || !TM.index) return;
    const months = TM.index.months, i = months.findIndex((x) => x.m === TM.month);
    const meta = DATA.time_machine;
    $('#tmTitle').textContent = `Le offerte del ${dayLabel(meta.day)}`;
    $('#tmMonth').value = TM.month;
    $('#tmPrev').disabled = i <= 0;
    $('#tmNext').disabled = i < 0 || i >= months.length - 1;
    const k = state.kind === 'gas' ? 'gas' : 'luce';
    const B = DATA[k], H = B.params_hindsight;
    const ix = (P) => (k === 'luce' ? `PUN ${nf3(P.pun_12m.mono)}` : `PSV ${nf3(P.psv_12m)}`);
    seg($('#tmMode'), [
      { v: 'then', label: 'Allora', small: ix(B.params) },
      { v: 'poi', label: 'Col senno di poi', small: H ? ix(H) + (H.months < 12 ? ` · ${H.months}/12` : '') : 'non ancora' },
    ], tmPoi(k) ? 'poi' : 'then', (v) => { if (v === 'poi' && !H) return; TM.mode = v; update({}); });
    const poiBtn = $('#tmMode').querySelector('[data-v="poi"]');
    if (!H) poiBtn.setAttribute('aria-disabled', 'true');
    const parts = [`<b>Allora</b>: la classifica di quel giorno, con l'indice medio dei 12 mesi prima (${esc(winLabel(B.params.window))}) e gli oneri di allora.`];
    if (H) {
      parts.push(`<b>Col senno di poi</b>: quanto sarebbe costata davvero, con l'indice effettivo dei mesi di fornitura (${esc(winLabel(H.window))}) e i loro oneri e IVA.`);
      if (H.months < 12) parts.push(`<span class="tm-warn">Parziale: solo ${H.months} mesi su 12 sono già chiusi.</span>`);
    } else parts.push('Col senno di poi non è ancora calcolabile: nessun mese di fornitura è chiuso.');
    $('#tmNote').innerHTML = parts.join(' ');
    $('#tmNoteM').innerHTML = parts.join(' ');   // su telefono la spiegazione sta nel riepilogo
  }

  function footerTM() {
    const L = DATA.luce, G = DATA.gas, meta = DATA.time_machine;
    $('#dataInfo').textContent = `🕰️ ${nf0.format(L.offers.length)} offerte luce · ${nf0.format(G.offers.length)} gas · Portale Offerte del ${dayLabel(meta.day)}`;
    $('#foot').innerHTML =
      `<p>Macchina del tempo: le offerte pubblicate sul Portale Offerte ARERA il ${esc(dayLabel(meta.day))}, con lo stesso modello di costo di oggi. <b>Allora</b> usa il PUN/PSV medio dei 12 mesi chiusi prima e i parametri regolati di quel mese. <b>Col senno di poi</b> usa il PUN/PSV effettivo dei 12 mesi di fornitura e la media dei loro parametri regolati e dell'IVA (gas al 5% fino a dicembre 2023). Sconti, bonus e penali non sono inclusi.</p>` +
      `<p>Fonti: ${esc(L.source_xml)}, ${esc(G.source_xml)}; PUN GME; PSV: ${esc(G.params.psv_sources)}; parametri luce: ${esc(L.params.params_source)}; gas: CSV parametri ARERA del periodo sul forfait nazionale di oggi.</p>`;
  }

  function setData(d) {
    DATA = d;
    nodes.clear();
    detailCache.clear();
    $('#ranking').innerHTML = '';
    shown = PAGE;
    footer();
  }

  function loadSnapshot(m) {
    if (!TM.cache.has(m)) {
      TM.cache.set(m, fetch(`history/${m}/offers.json?v=${encodeURIComponent(TM.index.generated_at)}`)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch((e) => { TM.cache.delete(m); throw e; }));
    }
    return TM.cache.get(m);
  }

  function enterTM(m) {
    $('#dataInfo').textContent = `Carico le offerte di ${monthName(m)}…`;
    return loadSnapshot(m).then((d) => {
      TM.on = true; TM.month = m;
      if (state.kind === 'mercato') state.kind = 'luce';
      setData(d);
      history.replaceState(history.state, '', '#tm=' + m);
      update({});
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch((e) => { $('#dataInfo').textContent = `Non riesco a caricare ${monthName(m)} (${e.message}).`; });
  }

  function exitTM() {
    TM.on = false; TM.month = null;
    setData(LIVE);
    history.replaceState(history.state, '', location.pathname + location.search);
    update({});
  }

  function initTimeMachine(ix) {
    if (!ix || !Array.isArray(ix.months) || !ix.months.length) return;
    TM.index = ix;
    const byYear = new Map();
    for (const x of ix.months) { const y = x.m.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(x); }
    $('#tmMonth').innerHTML = [...byYear].map(([y, ms]) => `<optgroup label="${y}">${ms.map((x) =>
      `<option value="${x.m}">${monthName(x.m)}${x.hl < 12 ? ' · senno di poi parziale' : ''}</option>`).join('')}</optgroup>`).join('');
    const step = (k) => { const i = ix.months.findIndex((x) => x.m === TM.month) + k; if (i >= 0 && i < ix.months.length) enterTM(ix.months[i].m); };
    $('#tmMonth').addEventListener('change', (e) => enterTM(e.target.value));
    $('#tmPrev').onclick = () => step(-1);
    $('#tmNext').onclick = () => step(1);
    $('#tmExit').onclick = exitTM;
    // di partenza: il mese più recente con il senno di poi completo
    const start = (ix.months.filter((x) => x.hl === 12 && x.hg === 12).pop() || ix.months[ix.months.length - 1]).m;
    const btn = $('#tmBtn');
    btn.hidden = false;
    btn.onclick = () => enterTM(start);
    const m = (location.hash.match(/^#tm=(\d{4}-\d{2})$/) || [])[1];
    if (m && ix.months.some((x) => x.m === m)) enterTM(m);
  }

  window.EnergyApp = {
    data: () => DATA, state: () => state, update, compute, openRow, badges,
    fmt: { nf0, nf2, nf3, nf4, eur, eur2, esc, monthLabel },
  };

  bind();
  syncControls();
  fetch('offers.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      LIVE = d;
      footer();
      update({});
      if (window.EnergyMarket) window.EnergyMarket.ready();
      // Macchina del tempo: c'è solo se è stato pubblicato l'indice degli snapshot.
      fetch('history/index.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null)).then(initTimeMachine).catch(() => {});
    })
    .catch((e) => {
      $('#dataInfo').textContent = 'Non riesco a caricare le offerte.';
      $('#ranking').innerHTML = `<li class="empty">Errore nel caricamento di offers.json (${esc(e.message)}).</li>`;
    });
})();
