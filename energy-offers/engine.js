/*
 * engine.js — costo annuo delle offerte luce e gas, IVA inclusa.
 *
 * Replica 1:1 le formule di check_offers.py (calc_system_annual_luce,
 * _excise_exemption_kwh, parse_offers, _calc_gas_iva, parse_gas_offers).
 * La parità è verificata da tests/test_web_export.py, che esegue questo file
 * con node e confronta i totali col motore Python: se cambi una formula qui,
 * cambiala anche là (o il test fallisce).
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
  function systemLuce(sys, kw, kwh, residente) {
    const fix = sys.fix_components;
    let fixAnnual = (fix[0] + fix[1] * kw + fix[2] * kw + fix[3]) * 12;
    if (!residente) fixAnnual += sys.non_resident_fix_annual;
    const varAnnual = sys.var_per_kwh * kwh;
    let excise;
    if (residente) {
      const exempt = exciseExemptionKwh(kwh / 12, kw);
      excise = sys.excise.resident * Math.max(0, kwh - exempt * 12);
    } else {
      excise = sys.excise.non_resident * kwh;
    }
    const dispbt = sys.dispbt_annual;
    return { fixAnnual, varAnnual, excise, dispbt, total: fixAnnual + varAnnual + excise + dispbt };
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
   * Ritorna { total, energia, fissoVenditore, rete, iva }.
   */
  function costGas(offer, params, profile, psv) {
    const smc = profile.smc;
    let energia = offer.t === 'F' ? offer.p * smc : (psv + offer.p) * smc;
    if (offer.sb > 0) energia += offer.sb * smc;
    const rete = profile.reteFix * 12 + profile.reteVar * smc;
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

  return { exciseExemptionKwh, systemLuce, punIndex, costLuce, gasWithIva, psvIndex, costGas, dualRanking };
});
