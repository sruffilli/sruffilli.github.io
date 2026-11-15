/*
 * tm-link.js — indirizzo (hash) della macchina del tempo: mese, fornitura e modo.
 *
 * Forma: #tm=2022-08&k=gas&v=poi. Il mese deve essere fra quelli pubblicati; k
 * (luce, gas, dual) e v (then, poi) fuori schema vengono scartati, come fa
 * EnergySim.parseHash. Un link con il solo mese (#tm=2022-08) resta valido.
 * #tm senza mese (la voce "Macchina del tempo" della barra di navigazione)
 * apre il mese di partenza.
 *
 * Funzioni pure: gira anche in node, dove un test le esegue.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnergyTmLink = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = ['luce', 'gas', 'dual'];
  const MODES = ['then', 'poi'];
  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  const query = (hash) => new URLSearchParams(String(hash || '').replace(/^#/, ''));

  // L'hash contiene la chiave tm (valida o no)?
  const isTmHash = (hash) => query(hash).has('tm');

  // months: i mesi pubblicati ('YYYY-MM'); start: il mese di partenza, usato
  // quando tm è vuoto (#tm). Ritorna { m, k, v } con k e v a null se assenti o
  // fuori schema, oppure null se il mese manca o non è pubblicato.
  function parse(hash, months, start) {
    const q = query(hash);
    let m = q.get('tm');
    if (m === '' && start) m = start;
    if (m == null || !MONTH.test(m) || !months.includes(m)) return null;
    const k = q.get('k'), v = q.get('v');
    return { m, k: KINDS.includes(k) ? k : null, v: MODES.includes(v) ? v : null };
  }

  const build = (m, k, v) => `#tm=${m}&k=${k}&v=${v}`;

  // Etichetta del modo nel riassunto di "Profilo e filtri": corta, per stare in una riga.
  const settingsLabel = (poi) => (poi ? 'poi' : 'allora');

  return { KINDS, MODES, isTmHash, parse, build, settingsLabel };
});
