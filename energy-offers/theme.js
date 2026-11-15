/*
 * theme.js — scelta del tema (automatico, chiaro, scuro), condivisa dalle tre pagine.
 *
 * Va caricato nell'<head>, sincrono e dopo i <meta name="theme-color">: applica la
 * scelta salvata prima del primo disegno, così non c'è lampo del tema sbagliato.
 * Nel file e non inline perché la logica è una sola (la usa anche il pulsante di
 * nav.js), si prova in node e non va ripetuta in ogni pagina.
 *
 * Il tema esplicito sta in <html data-theme="light|dark">. In automatico
 * l'attributo manca e decidono le regole @media (prefers-color-scheme) dei CSS,
 * come se questo script non ci fosse. La scelta sta in localStorage con una chiave
 * propria; un valore fuori dai tre ammessi vale «automatico», e se localStorage non
 * è disponibile il sito segue il dispositivo.
 *
 * In node esporta le funzioni pure per i test.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EnergyTheme = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const KEY = 'energy-theme';
  const STATES = ['auto', 'light', 'dark'];
  const LABELS = { auto: 'automatico', light: 'chiaro', dark: 'scuro' };

  const normalize = (value) => (STATES.includes(value) ? value : 'auto');

  // Il giro del pulsante: automatico → chiaro → scuro → automatico.
  const next = (state) => STATES[(STATES.indexOf(normalize(state)) + 1) % STATES.length];

  // Testi del pulsante: etichetta corta visibile e nome accessibile (stato attivo e passo successivo).
  function describe(state) {
    const now = normalize(state);
    const label = LABELS[now];
    const name = `Tema: ${label}. Cambia in ${LABELS[next(now)]}`;
    return { state: now, label, name };
  }

  function read(storage) {
    try { return normalize(storage.getItem(KEY)); } catch (e) { return 'auto'; }
  }

  // Automatico = nessun valore salvato, come per chi non ha mai scelto. Ritorna false se non si può salvare.
  function write(storage, state) {
    try {
      if (normalize(state) === 'auto') storage.removeItem(KEY);
      else storage.setItem(KEY, normalize(state));
      return true;
    } catch (e) { return false; }
  }

  // Colore di ogni <meta name="theme-color">. `metas` = [{ media, auto }], dove `auto` è il
  // contenuto scritto nella pagina. In automatico restano quelli della pagina (li sceglie il
  // browser dal `media`); in esplicito tutti prendono il colore del meta scritto per quel tema.
  function metaColors(metas, state) {
    const now = normalize(state);
    if (now === 'auto') return metas.map((m) => m.auto);
    const own = metas.find((m) => new RegExp(`prefers-color-scheme:\\s*${now}`).test(m.media || ''));
    return metas.map((m) => (own ? own.auto : m.auto));
  }

  // Applica lo stato a un documento (o a un finto documento nei test).
  function apply(doc, state) {
    const now = normalize(state);
    const html = doc.documentElement;
    if (now === 'auto') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', now);
    const nodes = Array.from(doc.querySelectorAll('meta[name="theme-color"]'));
    // il colore scritto nella pagina si conserva al primo passaggio, per tornare in automatico
    for (const n of nodes) if (!n.getAttribute('data-auto')) n.setAttribute('data-auto', n.getAttribute('content'));
    const colors = metaColors(nodes.map((n) => ({ media: n.getAttribute('media'), auto: n.getAttribute('data-auto') })), now);
    nodes.forEach((n, i) => n.setAttribute('content', colors[i]));
    return now;
  }

  function storageOf(win) {
    try { return win.localStorage || null; } catch (e) { return null; }   // accesso negato: SecurityError
  }

  // Esegue nel browser: applica la scelta salvata. Ritorna lo stato applicato.
  function init(win) {
    const storage = storageOf(win);
    return apply(win.document, storage ? read(storage) : 'auto');
  }

  if (root && root.document) init(root);

  return { KEY, STATES, LABELS, normalize, next, describe, read, write, metaColors, apply, storageOf, init };
});
