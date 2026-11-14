/*
 * engine.js — costo annuo delle offerte luce e gas, IVA inclusa.
 *
 * Replica 1:1 le formule del motore Python del comparatore (voci regolate luce,
 * esenzione accisa, offerte luce, IVA gas, offerte gas). Un test esegue questo
 * file con node e confronta i totali col motore Python: se cambi una formula
 * qui, cambiala anche là (o il test fallisce).
 *
 * Funziona sia nel browser (window.EnergyEngine) sia in node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnergyEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // kWh esenti al mese per i residenti con P ≤ 3 kW (CIP 15/1993).
  function exciseExemptionKwh(monthlyKwh, kw) {
    if (kw > 3.0) return 0;
    if (kw <= 1.5) {
      if (monthlyKwh <= 150) return 150;
      if (monthlyKwh < 300) return 300 - monthlyKwh;
      return 0;
    }
    if (monthlyKwh <= 220) return 150;
    if (monthlyKwh < 370) return 370 - monthlyKwh;
    return 0;
  }

  // Voci regolate luce (identiche per ogni venditore), IVA esclusa.
  // fixAnnual è la somma di trasportoFix + potenza + oneriFix: le tre parti
  // servono al simulatore (simulatore.html) per mostrare ogni voce da sola.
  function systemLuce(sys, kw, kwh, residente) {
    const fix = sys.fix_components;
    const trasportoFix = fix[0] * 12;
    const potenza = (fix[1] + fix[2]) * kw * 12;
    let oneriFix = fix[3] * 12;
    if (!residente) oneriFix += sys.non_resident_fix_annual;
    const fixAnnual = trasportoFix + potenza + oneriFix;
    const varAnnual = sys.var_per_kwh * kwh;
    let excise, exemptKwh = 0;
    if (residente) {
      exemptKwh = Math.min(kwh, exciseExemptionKwh(kwh / 12, kw) * 12);
      excise = sys.excise.resident * (kwh - exemptKwh);
    } else {
      excise = sys.excise.non_resident * kwh;
    }
    const dispbt = sys.dispbt_annual;
    return { fixAnnual, trasportoFix, potenza, oneriFix, varAnnual, excise, exemptKwh, dispbt,
             total: fixAnnual + varAnnual + excise + dispbt };
  }

  // Indici PUN per fascia da usare per le variabili: media 12 mesi, ultimo
  // mese, o un valore mono personalizzato (fasce scalate in proporzione).
  function punIndex(params, scenario, customMono) {
    const base = params.pun_12m;
    if (scenario === 'last') return params.pun_last;
    if (scenario === 'custom' && customMono > 0) {
      const k = customMono / base.mono;
      return { mono: customMono, f1: base.f1 * k, f2: base.f2 * k, f3: base.f3 * k, f23: base.f23 * k };
    }
    return base;
  }

  /*
   * profile: { kwh, kw, residente, f1, f2, f3 }
   * pun: oggetto {mono,f1,f2,f3,f23} (vedi punIndex)
   * Ritorna { total, energia, fissoVenditore, dispacciamento, sistema, iva, rai }.
   */
  function costLuce(offer, params, profile, pun) {
    const kwh = profile.kwh, kw = profile.kw, L = params.lambda;
    const f1 = profile.f1, f2 = profile.f2, f3 = profile.f3;
    const p = offer.p;
    const fixed = offer.t === 'F';
    let energia;
    if (offer.m === 'mono') {
      energia = fixed ? p[0] * kwh : (pun.mono * L + p[0]) * kwh;
    } else if (offer.m === 'bi') {
      energia = fixed
        ? p[0] * kwh * f1 + p[1] * kwh * (f2 + f3)
        : ((pun.f1 * L + p[0]) * f1 + (pun.f23 * L + p[1]) * (f2 + f3)) * kwh;
    } else {
      energia = fixed
        ? (p[0] * f1 + p[1] * f2 + p[2] * f3) * kwh
        : ((pun.f1 * L + p[0]) * f1 + (pun.f2 * L + p[1]) * f2 + (pun.f3 * L + p[2]) * f3) * kwh;
    }
    const fissoVenditore = offer.fx + offer.fk * kw;
    const dispacciamento = params.system.cdispd_per_kwh * kwh;
    const sys = systemLuce(params.system, kw, kwh, profile.residente);
    const preIva = energia + fissoVenditore + dispacciamento + sys.total;
    const rai = profile.residente ? params.rai_annual : 0;
    const total = preIva * params.iva + rai;
    return { total, energia, fissoVenditore, dispacciamento, sistema: sys,
             iva: preIva * (params.iva - 1), rai, preIva };
  }

  // IVA gas a scaglioni: 10% sui primi 480 Smc, 22% sul resto e sulle quote fisse.
  function gasWithIva(params, variableCost, smc, fixedAnnual) {
    const T = params.iva_threshold_smc;
    if (smc <= T) return variableCost * params.iva_low + fixedAnnual * params.iva_high;
    const low = (T / smc) * variableCost;
    const high = variableCost - low;
    return low * params.iva_low + high * params.iva_high + fixedAnnual * params.iva_high;
  }

  function psvIndex(params, scenario, custom) {
    if (scenario === 'last') return params.psv_last.value;
    if (scenario === 'custom' && custom > 0) return custom;
    return params.psv_12m;
  }

  /*
   * profile: { smc, reteFix (€/mese), reteVar (€/Smc) }
   * params.reg_delta (solo snapshot storici): correzione delle regolate del periodo.
   * Ritorna { total, energia, fissoVenditore, rete, iva }.
   */
  // Scaglioni annui (Smc) delle componenti tariffarie gas UG2 e τ3 (ARERA).
  const GAS_BANDS_SMC = [120, 480, 1560, 5000, 80000, 200000];

  // Variazione €/anno delle regolate gas di un periodo passato rispetto al
  // forfait di oggi (macchina del tempo): quota fissa + quota variabile, con la
  // parte per scaglione ripartita sul consumo. Assente (offerte di oggi) = 0.
  function regDeltaAnnual(delta, smc) {
    if (!delta) return 0;
    let v = delta.var_flat * smc, lo = 0;
    GAS_BANDS_SMC.forEach((hi, i) => { v += delta.var_bands[i] * Math.max(0, Math.min(smc, hi) - lo); lo = hi; });
    return delta.fix_annual + v;
  }

  function costGas(offer, params, profile, psv) {
    const smc = profile.smc;
    let energia = offer.t === 'F' ? offer.p * smc : (psv + offer.p) * smc;
    if (offer.sb > 0) energia += offer.sb * smc;
    const rete = profile.reteFix * 12 + profile.reteVar * smc + regDeltaAnnual(params.reg_delta, smc);
    const variable = energia + rete;
    const total = gasWithIva(params, variable, smc, offer.fx);
    return { total, energia, fissoVenditore: offer.fx, rete, iva: total - variable - offer.fx };
  }

  /*
   * Confronto luce+gas. lRows/gRows: righe {o, total} già filtrate e ordinate per
   * total crescente, comprese le offerte vendibili solo in coppia (o.so === 0,
   * con o.tw = id della gemella nell'altra fornitura, se individuata).
   * Ritorna:
   *  - separate: migliore luce + miglior gas sottoscrivibili da soli, anche da
   *    venditori diversi (null se manca una delle due);
   *  - vendors: per ogni venditore (o.pv) la coppia più economica, fra
   *    'separate' (sua luce + suo gas venduti singolarmente), 'dual' (coppia
   *    gemella) e 'dual?' (offerta solo in coppia senza gemella individuata,
   *    abbinata alla migliore dell'altra fornitura dello stesso venditore).
   */
  function dualRanking(lRows, gRows) {
    const firstSingle = (rows) => rows.find((r) => r.o.so !== 0) || null;
    const bl = firstSingle(lRows), bg = firstSingle(gRows);
    const separate = bl && bg ? { l: bl, g: bg, total: bl.total + bg.total } : null;
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) { const k = r.o.pv || r.o.v; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    const gl = group(lRows), gg = group(gRows);
    const lById = new Map(lRows.map((r) => [r.o.id, r]));
    const gById = new Map(gRows.map((r) => [r.o.id, r]));
    const vendors = [];
    for (const [pv, lv] of gl) {
      const gv = gg.get(pv);
      if (!gv) continue;
      const cands = [];
      const sl = firstSingle(lv), sg = firstSingle(gv);
      if (sl && sg) cands.push({ l: sl, g: sg, tipo: 'separate' });
      for (const l of lv) {
        if (l.o.so !== 0) continue;
        const twin = l.o.tw != null ? gById.get(l.o.tw) : null;
        if (twin) cands.push({ l, g: twin, tipo: 'dual' });
        else if (l.o.tw == null) cands.push({ l, g: gv[0], tipo: 'dual?' });
      }
      for (const g of gv) {
        if (g.o.so !== 0) continue;
        const twin = g.o.tw != null ? lById.get(g.o.tw) : null;
        if (twin) cands.push({ l: twin, g, tipo: 'dual' });
        else if (g.o.tw == null) cands.push({ l: lv[0], g, tipo: 'dual?' });
      }
      if (!cands.length) continue;
      for (const c of cands) c.total = c.l.total + c.g.total;
      cands.sort((a, b) => a.total - b.total);
      vendors.push(Object.assign({ pv, v: cands[0].l.o.v || cands[0].g.o.v }, cands[0]));
    }
    vendors.sort((a, b) => a.total - b.total);
    return { separate, vendors };
  }

  /*
   * Segnale fisso/variabile dello studio di mercato 2022-2026 (analisi.html).
   * ratio = indice dell'ultimo mese / media 12 mesi. bestF = totale della fissa
   * migliore; bestV12 / bestVLast = totale della variabile migliore all'indice
   * medio 12 mesi (quello della classifica) e a quello dell'ultimo mese.
   * Regola dei due controlli, backtest 2022-01 -> 2025-10: fisso se batte la
   * variabile all'indice dell'ultimo mese E costa al massimo il 10% in più
   * della variabile in classifica. Soglie di regime 1,2 e 0,83: oltre 1,2 i 12
   * mesi successivi sono stati più cari della media nell'81% dei casi (PUN 2006-2025).
   * Ritorna { regime: 'up'|'down'|'calm', choice: 'F'|'V', premium, bias }.
   */
  const SIGNAL_UP = 1.2, SIGNAL_DOWN = 0.83, PREMIUM_CAP = 0.10;
  function fixVarSignal(ratio, bestF, bestV12, bestVLast) {
    const regime = ratio > SIGNAL_UP ? 'up' : ratio < SIGNAL_DOWN ? 'down' : 'calm';
    const premium = bestV12 > 0 ? (bestF - bestV12) / bestV12 : 0;
    const choice = bestF < bestVLast && premium <= PREMIUM_CAP ? 'F' : 'V';
    return { regime, choice, premium, bias: bestVLast - bestV12 };
  }

  return { exciseExemptionKwh, systemLuce, punIndex, costLuce, gasWithIva, psvIndex, regDeltaAnnual, costGas, dualRanking,
           fixVarSignal, SIGNAL_UP, SIGNAL_DOWN, PREMIUM_CAP };
});
