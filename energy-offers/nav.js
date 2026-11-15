/*
 * nav.js — barra di navigazione comune (nav.css): Offerte, Simulatore,
 * Macchina del tempo, Analisi.
 *
 * La macchina del tempo è un modo di index.html: la sua voce porta a
 * index.html#tm, che la apre sul mese di partenza. Esiste solo se è pubblicato
 * history/index.json: qui lo si scarica una volta e, se manca o è vuoto, la
 * voce sparisce. index.html usa la stessa richiesta (EnergyNav.history).
 *
 * Il pulsante del tema (theme.js: automatico, chiaro, scuro) sta nella stessa
 * barra. Il markup è statico e nascosto: si mostra solo quando qui lo si collega,
 * così senza script non c'è un pulsante che non fa nulla.
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

  // Collega il pulsante del tema: nome accessibile e testo seguono lo stato, il clic lo fa girare.
  function bindThemeToggle(button) {
    const T = doc.defaultView && doc.defaultView.EnergyTheme;
    if (!button || !T) return;
    const win = doc.defaultView;
    const storage = T.storageOf(win);
    const text = button.querySelector('.theme-text');
    const live = doc.querySelector('.theme-live');
    let state = storage ? T.read(storage) : 'auto';
    const show = (announce) => {
      const d = T.describe(state);
      button.dataset.state = d.state;
      button.setAttribute('aria-label', d.name);
      button.title = d.name;
      text.textContent = `Tema: ${d.label}`;
      if (announce && live) live.textContent = `Tema: ${d.label}`;
    };
    button.addEventListener('click', () => {
      state = T.next(state);
      T.apply(doc, state);
      if (storage) T.write(storage, state);
      show(true);
    });
    // un'altra scheda del sito ha cambiato scelta
    win.addEventListener('storage', (e) => {
      if (!storage || (e.key !== null && e.key !== T.KEY)) return;
      state = T.read(storage);
      T.apply(doc, state);
      show(false);
    });
    show(false);
    button.hidden = false;
  }

  let history = Promise.resolve(null);
  if (doc) {
    bindThemeToggle(doc.querySelector('.site-nav [data-theme-toggle]'));
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
