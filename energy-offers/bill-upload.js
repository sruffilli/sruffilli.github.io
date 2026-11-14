/*
 * bill-upload.js — "Leggi la bolletta (PDF)": il PDF si legge nel browser con
 * pdf.js (vendor/pdfjs-<versione>/, caricato solo alla scelta del file), il testo va a
 * EnergyBill.parseBill (bill.js), l'utente conferma e il form si precompila.
 * Nessun byte della bolletta lascia il dispositivo.
 *
 * OCR (beta): un PDF senza testo (scansione) o 1-4 foto della bolletta si possono
 * leggere con l'OCR, solo su richiesta dell'utente. ocr.js gira in un Web Worker e
 * scarica una volta gli asset da vendor/<OCR_DIR>/ (stesso sito, ~25 MB). Le pagine
 * si rendono qui (pdf.js su canvas, o la foto ridotta) e passano al worker come
 * pixel; tornano righe di testo per parseBill(…, {ocr: true}).
 *
 * Funziona nel browser e, per fieldsToPatch, in node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.EnergyBillUpload = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {
  'use strict';

  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_PAGES = 30;
  // La versione sta nel percorso: GitHub Pages tiene in cache i file 10 minuti,
  // e un pdf.min.mjs vecchio con un worker nuovo (o viceversa) pdf.js lo rifiuta.
  // Aggiornando pdf.js si rinomina la cartella e si cambia solo questa riga.
  const PDFJS_DIR = 'vendor/pdfjs-4.10.38/';
  const PDFJS = './' + PDFJS_DIR + 'pdf.min.mjs';
  const PDFJS_WORKER = PDFJS_DIR + 'pdf.worker.min.mjs';
  // Asset dell'OCR: li scrive web_export.py (OCR_VERSION), non stanno nel repo.
  const OCR_DIR = 'vendor/ocr-v1/';
  const OCR_PDF_PAGES = 3;          // il riepilogo ARERA sta nelle prime pagine
  const OCR_MAX_IMAGES = 4;
  const OCR_LONG_SIDE = 2000;       // px: come le foto della prova (150-300 dpi danno lo stesso)

  const FIELD_ORDER = ['kwh', 'smc', 'kw', 'residente', 'regione'];
  const FIELD_LABEL = { kwh: 'Consumo luce', smc: 'Consumo gas', kw: 'Potenza impegnata', residente: 'Residenza', regione: 'Regione' };
  const RELEVANT = { luce: ['kwh', 'kw', 'residente', 'regione'], gas: ['smc', 'regione'], dual: FIELD_ORDER, null: FIELD_ORDER };

  const nf = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  // Campi selezionati → patch per EnergyApp.update. Valori fuori scala vengono
  // riportati nei limiti dei controlli; una regione sconosciuta si scarta. La scheda
  // (luce/gas/insieme) segue i campi spuntati, non il tipo di bolletta: con la sola
  // regione spuntata la scheda corrente non cambia.
  function fieldsToPatch(result, selected, regioni) {
    const f = result.fields, patch = {};
    for (const k of selected) {
      if (!f[k]) continue;
      const v = f[k].value;
      if (k === 'kwh') patch.kwh = clamp(Math.round(v), 100, 20000);
      else if (k === 'smc') patch.smc = clamp(Math.round(v), 10, 10000);
      else if (k === 'kw') patch.kw = clamp(Math.round(v * 100) / 100, 0.5, 30);
      else if (k === 'residente') patch.residente = !!v;
      else if (k === 'regione' && regioni && Object.prototype.hasOwnProperty.call(regioni, v)) patch.regione = v;
    }
    if (result.kind) {
      const luce = ['kwh', 'kw', 'residente'].some((k) => k in patch), gas = 'smc' in patch;
      const kind = luce && gas ? 'dual' : luce ? 'luce' : gas ? 'gas' : null;
      if (kind) patch.kind = kind;
    }
    return patch;
  }

  function valueText(k, v, regioni) {
    if (k === 'kwh') return `${nf.format(v)} kWh/anno`;
    if (k === 'smc') return `${nf.format(v)} Smc/anno`;
    if (k === 'kw') return `${nf.format(v)} kW`;
    if (k === 'residente') return v ? 'residente' : 'non residente';
    return (regioni && regioni[v]) || String(v);
  }

  const KIND_TXT = { luce: 'una bolletta della luce', gas: 'una bolletta del gas', dual: 'una bolletta di luce e gas' };

  function errorMessage(e) {
    const name = e && e.name;
    if (name === 'PasswordException') return 'Il PDF è protetto da password: toglila e riprova.';
    if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'MissingPDFException') return 'Il file è danneggiato o non è un PDF leggibile.';
    return 'Non riesco a leggere questo PDF. Il file resta sul tuo dispositivo: puoi inserire i dati a mano.';
  }

  const api = { fieldsToPatch, valueText, errorMessage };
  if (!win) return api;

  const doc = win.document;
  const $ = (s) => doc.querySelector(s);
  const pick = $('#billPick'), input = $('#billFile'), statusEl = $('#billStatus'), panel = $('#billPanel');
  if (!pick || !input) return api;
  // stesso timbro di versione di questo script (web_export.py aggiunge ?v=…): il
  // worker ocr.js e questa pagina restano della stessa versione
  const STAMP = (() => {
    try { return new URL(doc.currentScript.src).searchParams.get('v') || 'dev'; } catch (e) { return 'dev'; }
  })();

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS).then((m) => {
        m.GlobalWorkerOptions.workerSrc = new URL(PDFJS_WORKER, doc.baseURI).href;
        return m;
      }).catch((e) => { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  function status(msg, isErr) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isErr);
  }
  function clearPanel() { panel.hidden = true; panel.textContent = ''; }

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(text, cls, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  async function isPdf(file) {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    return String.fromCharCode(...head).indexOf('%PDF-') >= 0;
  }

  async function openPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await loadPdfjs();
    return pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
  }

  async function readPdf(file) {
    const pdf = await openPdf(file);
    try {
      const pages = [];
      for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
        const page = await pdf.getPage(i);
        pages.push(win.EnergyBill.linesFromTextContent(await page.getTextContent()));
      }
      return { pages, truncated: pdf.numPages > MAX_PAGES };
    } finally { pdf.destroy(); }
  }

  /* ---------- risultato ---------- */

  function showResult(res) {
    const regioni = (win.EnergyApp.data() || {}).regioni || {};
    // Una regione che la pagina non conosce (dati non ancora caricati) non si
    // propone: Applica la scarterebbe in silenzio.
    const found = FIELD_ORDER.filter((k) => res.fields[k] && (k !== 'regione' || regioni[res.fields[k].value]));
    panel.textContent = '';
    if (!found.length) {
      status(res.ocr
        ? 'L’OCR non ha trovato dati utili. Prova con una foto più nitida, dritta e ben illuminata, oppure inserisci i dati a mano.'
        : 'Non ho trovato nessun dato utile in questo PDF. Sicuro che sia una bolletta di luce o gas? Puoi inserire i dati a mano.', true);
      // gli avvisi (valori scartati, PDF troncato) spiegano perché
      for (const w of res.warnings || []) panel.appendChild(el('p', 'bill-warn', w));
      panel.hidden = !(res.warnings || []).length;
      return;
    }
    status('');
    panel.appendChild(el('h3', null, `Ho letto ${KIND_TXT[res.kind] || 'la bolletta'}. Cosa uso?`));
    if (res.ocr) {
      panel.appendChild(el('p', 'bill-ocr-note',
        'Letti con l’OCR (beta): può sbagliare una cifra. Confronta ogni valore con la bolletta prima di applicarlo.'));
    }
    const list = el('ul', 'bill-rows');
    const boxes = [];
    for (const k of found) {
      const f = res.fields[k];
      const li = el('li', 'bill-row');
      const lab = el('label');
      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.k = k;
      boxes.push(cb);
      lab.append(cb, el('b', null, `${FIELD_LABEL[k]}: ${valueText(k, f.value, regioni)}`),
        el('span', 'bill-src', `a pag. ${f.page}: «${f.line}»` + (f.note ? ` — ${f.note}` : '')));
      li.appendChild(lab);
      list.appendChild(li);
    }
    for (const k of (RELEVANT[res.kind] || FIELD_ORDER).filter((x) => !res.fields[x])) {
      list.appendChild(el('li', 'bill-row missing', `${FIELD_LABEL[k]}: non trovato: inseriscilo tu`));
    }
    panel.appendChild(list);
    for (const w of res.warnings || []) panel.appendChild(el('p', 'bill-warn', w));
    const actions = el('div', 'bill-actions');
    const ok = button('Applica', 'primary', () => {
      const patch = fieldsToPatch(res, boxes.filter((b) => b.checked).map((b) => b.dataset.k), regioni);
      win.EnergyApp.update(patch);
      clearPanel();
      status('Fatto: ho precompilato il profilo con i dati della bolletta. Controllali e correggi quello che serve.');
      pick.focus({ preventScroll: true });   // il bottone che aveva il focus non c'è più
      win.scrollTo({ top: 0, behavior: 'smooth' });
    });
    const no = button('Annulla', null, () => { clearPanel(); status(''); pick.focus(); });
    const sync = () => { ok.disabled = !boxes.some((b) => b.checked); };
    boxes.forEach((b) => b.addEventListener('change', sync));
    actions.append(ok, no);
    panel.appendChild(actions);
    panel.hidden = false;
    ok.focus();
  }

  /* ---------- OCR (beta) ---------- */

  let ocrManifest = null;
  async function loadOcrManifest() {
    if (!ocrManifest) {
      const r = await fetch(OCR_DIR + 'manifest.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ocrManifest = await r.json();
    }
    return ocrManifest;
  }

  // Offerta dell'OCR: mai automatica, perché scarica ~25 MB e sul telefono è lenta.
  async function offerOcr(source, intro) {
    clearPanel();
    let manifest;
    try { manifest = await loadOcrManifest(); } catch (e) {
      status(intro + ' La lettura OCR non è disponibile in questo momento: inserisci i dati a mano.', true);
      return;
    }
    status('');
    const mb = Math.round(manifest.total_bytes / 1e6);
    panel.appendChild(el('p', null, intro));
    if (source.kind === 'images' && source.files.length === 1) {
      panel.appendChild(el('p', 'bill-warn', 'Con una sola foto alcuni controlli non si possono fare (per esempio se il consumo annuo è aggiornato): se puoi, scegli le foto delle prime 2 o 3 pagine insieme.'));
    }
    panel.appendChild(el('p', 'bill-ocr-note',
      `Posso provare a leggerla con l’OCR (beta), qui sul tuo dispositivo: la bolletta non viene inviata. ` +
      `La prima volta scarica circa ${mb} MB; sul telefono può servire un minuto per pagina. ` +
      `L’OCR può sbagliare una cifra: ti mostrerò cosa ha letto prima di usarlo.`));
    const actions = el('div', 'bill-actions');
    actions.append(
      button('Leggi con l’OCR (beta)', 'primary', () => runOcr(source)),
      button('No, inserisco a mano', null, () => { clearPanel(); status(''); pick.focus(); }));
    panel.appendChild(actions);
    panel.hidden = false;
    actions.firstChild.focus();
  }

  // Pagina → pixel RGBA, lato lungo OCR_LONG_SIDE (un A4 si rende a circa 2,4×; mai oltre 4×).
  function canvasOf(w, h) {
    const c = doc.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  async function pdfPageImage(pdf, n) {
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, OCR_LONG_SIDE / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale });
    const c = canvasOf(Math.round(vp.width), Math.round(vp.height));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return ctx.getImageData(0, 0, c.width, c.height);
  }
  // La foto del telefono si raddrizza secondo l'EXIF; i motori che non conoscono
  // imageOrientation 'from-image' lanciano TypeError: si riprova senza opzioni.
  async function decodePhoto(file) {
    try { return await win.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      return win.createImageBitmap(file);
    }
  }
  async function photoImage(file) {
    const bmp = await decodePhoto(file);
    const r = Math.min(1, OCR_LONG_SIDE / Math.max(bmp.width, bmp.height));
    const c = canvasOf(Math.round(bmp.width * r), Math.round(bmp.height * r));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function runOcr(source) {
    clearPanel();
    let worker = null, cancelled = false, pdf = null;
    const bar = el('progress', 'bill-progress');
    bar.max = 1; bar.value = 0;
    const cancel = button('Interrompi', null, () => {
      cancelled = true;
      if (worker) worker.terminate();
      if (pdf) pdf.destroy();
      clearPanel(); status('Lettura OCR interrotta.'); pick.disabled = false; pick.focus();
    });
    panel.append(bar, el('div', 'bill-actions'));
    panel.lastChild.appendChild(cancel);
    panel.hidden = false;
    pick.disabled = true;
    const say = (msg, frac) => { status(msg); if (frac != null) bar.value = frac; else bar.removeAttribute('value'); };

    const call = (msg, transfer, onProgress) => new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress && onProgress(m);
        else if (m.type === 'error') reject(new Error(m.message));
        else resolve(m);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'errore del worker OCR'));
      worker.postMessage(msg, transfer || []);
    });

    (async () => {
      try {
        const total = source.kind === 'pdf' ? null : source.files.length;
        worker = new win.Worker('ocr.js?v=' + encodeURIComponent(STAMP));
        say('OCR (beta): preparo il motore di lettura…', 0);
        await call({ type: 'init', base: new URL(OCR_DIR, doc.baseURI).href }, null, (m) => {
          say(`OCR (beta): scarico il motore di lettura, ${nf.format(Math.round(m.loaded / 1e5) / 10)} di ${nf.format(Math.round(m.total / 1e5) / 10)} MB…`, m.loaded / m.total);
        });
        if (cancelled) return;
        if (source.kind === 'pdf') {
          const opened = await openPdf(source.file);
          if (cancelled) { opened.destroy(); return; }   // annullato mentre si apriva
          pdf = opened;
        }
        const n = source.kind === 'pdf' ? Math.min(pdf.numPages, OCR_PDF_PAGES) : total;
        const pages = [];
        let res = null;
        for (let i = 0; i < n && !cancelled; i++) {
          say(`OCR (beta): pagina ${i + 1} di ${n}, preparo l’immagine…`, null);
          const img = source.kind === 'pdf' ? await pdfPageImage(pdf, i + 1) : await photoImage(source.files[i]);
          if (cancelled) return;
          const out = await call({ type: 'page', id: i, width: img.width, height: img.height, buffer: img.data.buffer },
            [img.data.buffer], (m) => say(`OCR (beta): pagina ${i + 1} di ${n}, leggo il testo (${m.done} di ${m.total} riquadri)…`, m.done / m.total));
          if (cancelled) return;
          pages.push(out.lines);
        }
        // Tutte le pagine, sempre: niente stop anticipato quando i campi ci sono già.
        // I controlli che scartano un valore stanno spesso più avanti (A2A gas: la
        // casella annua a pag. 1 non ha date, il suo periodo del 2022 è a pag. 3).
        res = win.EnergyBill.parseBill(pages, { ocr: true });
        if (cancelled) return;
        worker.terminate(); worker = null;
        if (pdf) { pdf.destroy(); pdf = null; }
        pick.disabled = false;
        showResult(res || win.EnergyBill.parseBill([], { ocr: true }));
      } catch (e) {
        if (cancelled) return;
        if (worker) worker.terminate();
        if (pdf) pdf.destroy();
        pick.disabled = false;
        clearPanel();
        status('La lettura OCR non è riuscita (' + ((e && e.message) || e) + '). Puoi inserire i dati a mano.', true);
      }
    })();
  }

  /* ---------- scelta del file ---------- */

  async function onFiles(files) {
    clearPanel();
    if (files.some((f) => f.size > MAX_BYTES)) { status('Il file è troppo grande per una bolletta (oltre 30 MB).', true); return; }
    const images = files.filter((f) => /^image\//.test(f.type));
    if (images.length && images.length === files.length) {
      if (images.length > OCR_MAX_IMAGES) { status(`Scegli al massimo ${OCR_MAX_IMAGES} foto: le prime pagine della bolletta.`, true); return; }
      // la foto si deve poter decodificare PRIMA di proporre un download da 25 MB
      // (HEIC dell'iPhone: Safari lo legge, Chrome e Firefox no)
      try {
        for (const f of images) { const b = await decodePhoto(f); if (b.close) b.close(); }
      } catch (e) {
        status('Non riesco ad aprire questa foto in questo browser. Usa una foto JPEG o PNG (o uno screenshot), oppure il PDF della bolletta.', true);
        return;
      }
      offerOcr({ kind: 'images', files: images },
        images.length === 1 ? 'Hai scelto una foto della bolletta.' : `Hai scelto ${images.length} foto della bolletta.`);
      return;
    }
    if (files.length > 1) { status('Scegli un solo PDF, oppure da 1 a 4 foto della bolletta.', true); return; }
    const file = files[0];
    pick.disabled = true;
    status('Leggo la bolletta qui sul tuo dispositivo…');
    try {
      if (!(await isPdf(file))) { status('Questo file non è un PDF né una foto. Scegli la bolletta in PDF, o una sua foto.', true); return; }
      const { pages, truncated } = await readPdf(file);
      const res = win.EnergyBill.parseBill(pages);
      if (res.scanned) {
        pick.disabled = false;
        offerOcr({ kind: 'pdf', file }, 'Questo PDF non contiene testo: sembra una bolletta scansionata o fotografata.');
        return;
      }
      if (truncated) (res.warnings = res.warnings || []).push(`Il PDF ha molte pagine: ho letto solo le prime ${MAX_PAGES}.`);
      showResult(res);
    } catch (e) {
      status(errorMessage(e), true);
    } finally { pick.disabled = false; }
  }

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';                       // permette di riscegliere lo stesso file
    if (files.length) onFiles(files);
  });

  return api;
});
