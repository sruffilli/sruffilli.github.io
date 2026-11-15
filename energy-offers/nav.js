/*
 * nav.js — barra di navigazione comune (nav.css): Offerte, Simulatore,
 * Macchina del tempo, Analisi.
 *
 * La macchina del tempo è un modo di index.html: la sua voce porta a
 * index.html#tm, che la apre sul mese di partenza. Esiste solo se è pubblicato
 * history/index.json: qui lo si scarica una volta e, se manca o è vuoto, la
 * voce sparisce. index.html usa la stessa richiesta (EnergyNav.history).
 *
 * In node esporta le funzioni pure per i test.
 */
(function (root, factory) {
  const api = factory(typeof document !== 'undefined' ? document : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EnergyNav = api;
})(typeof self !== 'undefined' ? self : this, function (doc) {
  'use strict';

  const ENTRIES = ['offerte', 'simulatore', 'tm', 'analisi'];

  // Un indice della macchina del tempo utilizzabile: almeno un mese pubblicato.
  const hasMonths = (ix) => !!(ix && Array.isArray(ix.months) && ix.months.length);

  // Segna la voce corrente (aria-current="page"); una chiave fuori elenco non segna nulla.
  function setCurrent(key) {
    if (!doc) return;
    for (const a of doc.querySelectorAll('.site-nav a[data-nav]')) {
      if (a.dataset.nav === key && ENTRIES.includes(key)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  let history = Promise.resolve(null);
  if (doc) {
    history = fetch('history/index.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((ix) => (hasMonths(ix) ? ix : null))
      .catch(() => null);
    history.then((ix) => {
      if (ix) return;
      for (const a of doc.querySelectorAll('.site-nav a[data-nav="tm"]')) a.hidden = true;
    });
  }

  return { ENTRIES, hasMonths, setCurrent, history };
});
