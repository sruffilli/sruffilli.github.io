/*
 * bill.js — da testo di bolletta (estratto da pdf.js) a valori del form.
 *
 * Funziona sia nel browser (window.EnergyBill) sia in node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EnergyBill = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- testo: page.getTextContent() -> righe ---------- */

  function linesFromTextContent(textContent) {
    // Il testo ruotato di una pagina diritta (strisce legali verticali a margine)
    // si scarta: la sua "larghezza" è un'altezza e verrebbe incollato alle righe
    // orizzontali, magari con CAP e provincia della sede del venditore. Su una
    // pagina con /Rotate 90 il testo "ruotato" è quasi tutto: lo si tiene tutto
    // (le righe si formano sull'asse sbagliato e non danno campi, ma la pagina non
    // passa per una falsa "scansione").
    const upright = (t) => Math.abs(t[1]) <= Math.abs(t[0]) && Math.abs(t[2]) <= Math.abs(t[3]);
    const all = ((textContent && textContent.items) || []).filter(
      (it) => it && typeof it.str === 'string' && it.transform);
    const straight = all.filter((it) => upright(it.transform));
    const items = straight.length * 2 >= all.length ? straight : all;
    const rows = [];
    // y decrescente (dall'alto), a parità x crescente.
    const sorted = items.slice().sort((a, b) => b.transform[5] - a.transform[5]
      || a.transform[4] - b.transform[4]);
    for (const it of sorted) {
      const y = it.transform[5];
      const h = Math.abs(it.height || it.transform[3]) || 8;
      let row = null;
      for (let i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
        if (Math.abs(rows[i].y - y) <= rows[i].h * 0.4) { row = rows[i]; break; }
      }
      if (!row) { row = { y: y, h: h, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    const lines = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = '';
      let prevEnd = null;
      for (const it of row.items) {
        if (it.str === '') continue;
        const x = it.transform[4];
        const size = Math.abs(it.transform[0]) || row.h;
        if (text && prevEnd !== null) {
          const gap = x - prevEnd;
          const spaced = /\s$/.test(text) || /^\s/.test(it.str);
          if (gap > size * 0.12 && !spaced) text += ' ';
        }
        text += it.str;
        prevEnd = x + (it.width || 0);
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    return lines;
  }

  /* ---------- numeri italiani ---------- */

  const NUM = '\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?';

  // '1.840' -> 1840, '3,0' -> 3, '6.00' -> 6, '1.840,5' -> 1840.5
  function parseItalianNumber(s) {
    s = String(s).trim();
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (/^\d+([.,]\d+)?$/.test(s)) return parseFloat(s.replace(',', '.'));
    return NaN;
  }

  const BOUNDS = {
    kwh: { min: 100, max: 20000, label: 'consumo annuo (kWh)' },
    smc: { min: 10, max: 10000, label: 'consumo annuo (Smc)' },
    kw: { min: 0.5, max: 30, label: 'potenza impegnata (kW)' },
  };

  /* ---------- provincia -> regione ISTAT (codici di offers.json 'regioni') ---------- */

  const REGION_PROVINCES = {
    '01': 'AL AT BI CN NO TO VB VC',
    '02': 'AO',
    '03': 'BG BS CO CR LC LO MB MI MN PV SO VA',
    '04': 'BZ TN',
    '05': 'BL PD RO TV VE VI VR',
    '06': 'GO PN TS UD',
    '07': 'GE IM SP SV',
    '08': 'BO FC FE MO PC PR RA RE RN',
    '09': 'AR FI GR LI LU MS PI PT PO SI',
    '10': 'PG TR',
    '11': 'AN AP FM MC PU',
    '12': 'FR LT RI RM VT',
    '13': 'AQ CH PE TE',
    '14': 'CB IS',
    '15': 'AV BN CE NA SA',
    '16': 'BA BT BR FG LE TA',
    '17': 'MT PZ',
    '18': 'CZ CS KR RC VV',
    '19': 'AG CL CT EN ME PA RG SR TP',
    // SU = Sud Sardegna (2016); CI VS OG OT sono le vecchie province, ancora su bollette datate.
    '20': 'CA NU OR SS SU CI VS OG OT',
  };
  const PROVINCE_TO_REGION = {};
  Object.keys(REGION_PROVINCES).forEach((code) => {
    REGION_PROVINCES[code].split(' ').forEach((sigla) => { PROVINCE_TO_REGION[sigla] = code; });
  });

  /* ---------- helpers ---------- */

  const DATE = '(\\d{2})[./](\\d{2})[./](\\d{4})';
  const RANGE_RE = new RegExp(DATE + '\\s*(?:al|a|-|–)\\s*' + DATE, 'g');

  function dayNumber(d, m, y) { return Date.UTC(+y, +m - 1, +d) / 86400000; }

  // Intervalli di date "dd.mm.yyyy al dd.mm.yyyy" (o "a", "-") in una riga.
  function rangesIn(line) {
    const out = [];
    let m;
    RANGE_RE.lastIndex = 0;
    while ((m = RANGE_RE.exec(line))) {
      out.push({ start: dayNumber(m[1], m[2], m[3]), end: dayNumber(m[4], m[5], m[6]) });
    }
    return out;
  }

  function flatten(pages) {
    const all = [];
    pages.forEach((lines, p) => (lines || []).forEach((line, i) => all.push({ page: p + 1, i: i, line: line, lines: lines })));
    return all;
  }

  // "2 700 kWh": spazio come separatore delle migliaia. Il numero letto sarebbe 700,
  // quindi è ambiguo: gruppo di 1-3 cifre, spazio, e un numero di esattamente 3
  // cifre intere. "803500 3727 kWh" (telefono accanto al valore) o un POD che
  // finisce in cifre prima di "6.00 kW" non lo sono.
  // (Niente lookbehind nelle regex: Safari < 16.4 non lo compila e il file non caricherebbe.)
  const GROUP_SPACE_BEFORE = /(?:^|[^\d.,])\d{1,3}[\s\u00a0\u202f]$/;
  const THREE_DIGITS = /^\d{3}(?:,\d+)?$/;
  const spaceThousands = (before, num) => THREE_DIGITS.test(num) && GROUP_SPACE_BEFORE.test(before);

  // Valori con unità in una riga; null al posto di un valore ambiguo, perché il
  // chiamante si fermi invece di saltarlo e cercare oltre.
  function unitTokens(line, unitRe) {
    const re = new RegExp('(?:^|[^\\d.,])(' + NUM + ')\\s*(?:' + unitRe + ')', 'gi');
    const out = [];
    let m;
    while ((m = re.exec(line))) {
      const start = m.index + m[0].indexOf(m[1]);
      out.push(spaceThousands(line.slice(0, start), m[1]) ? null : parseItalianNumber(m[1]));
    }
    return out;
  }
  const ambiguous = (toks) => toks.some((v) => v === null);

  const KWH_UNIT = 'kWh\\b(?:\\/anno)?';
  // (?![A-Za-z0-9]) e non \b: dopo "³" (non alfanumerico) \b non scatta mai.
  const SMC_UNIT = '(?:Smc|Sm3|Sm³|m3|m³|mc)(?![A-Za-z0-9])(?:\\/anno)?';
  // Righe dell'altra fornitura: in una bolletta dual il gas può riportare anche
  // l'equivalente in kWh ("1.100 Smc (11.583 kWh)"), che non è il consumo luce.
  const OTHER_COMMODITY = {
    kwh: /\bgas\b|\bS?m(?:c|3|³)(?![A-Za-z0-9])/i,
    smc: /\bluce\b|elettric|\bkWh\b/i,
  };
  // Una riga di fascia (F1, "Fascia 2", picco) porta un consumo parziale, mai l'annuo.
  const FASCIA_HINT = /\bF[0-3]\b|\bfasc|\bpicco\b/i;

  // Parole che, prima di una frase come "potenza impegnata", indicano testo
  // discorsivo (contratti, schede offerta, note ARERA) e non una voce di bolletta.
  const PROSE_BEFORE = /(?:\b(?:con|una|un|la|le|ogni|della|dalla|alla|dell|dall|all|pari a|se diverso)|['’])\s*$/i;

  function labelIsProse(line, index) {
    return PROSE_BEFORE.test(line.slice(Math.max(0, index - 20), index));
  }

  // Raggruppa i candidati: valori concordi -> il primo; discordi -> nessuno + avviso.
  function resolve(key, cands, warnings) {
    if (!cands.length) return null;
    const bound = BOUNDS[key];
    const distinct = [];
    cands.forEach((c) => { if (!distinct.some((v) => Math.abs(v - c.value) < 1e-9)) distinct.push(c.value); });
    if (distinct.length > 1) {
      warnings.push('Valori discordanti per ' + bound.label + ' (' + distinct.join(' / ') + '): inseriscilo a mano.');
      return null;
    }
    const first = cands[0];
    if (bound && (first.value < bound.min || first.value > bound.max)) {
      warnings.push('Valore fuori scala per ' + bound.label + ' (' + first.value + '): ignorato, inseriscilo a mano.');
      return null;
    }
    return first;
  }

  /* ---------- consumo annuo (kWh / Smc) ---------- */

  const ANNUAL_LABEL = /\bconsum[oi]\s+(?:annu[oi]|annuale)\b|\bannuo\s+in\s+kWh\b/gi;
  const ANNUAL_PROSE_AFTER = /^[^\d]{0,12}(?:pari|massim|fino|inferior|superior|medi|stimat|di\b)/i;
  const WINDOW = 3;
  // "Fascia F1: 209 kWh" (A2A), "Fascia F1 209 kWh", o "F1 209 kWh" a inizio riga.
  const FASCIA_LINE = /(?:\bFascia\s+|^\s*)F([123])\s*:?\s*(\d[\d.,]*)\s*kWh\b/i;

  // Contesto di un candidato: da 2 righe sopra l'etichetta a 2 righe sotto il valore.
  // Qui si cercano i periodi che dicono se l'annuo è vecchio (dropStale) e se è
  // recente (ocrAnnual): l'etichetta stessa può portare il periodo
  // ("Consumo annuo dal gg.mm.aaaa al gg.mm.aaaa").
  const context = (lines, label, value) => lines.slice(Math.max(0, label - 2), value + 3);

  // Cerca il consumo annuo con unità `unitRe` (KWH_UNIT / SMC_UNIT).
  // Ritorna i candidati; ognuno porta in `rangeLines` le righe dove cercarne il periodo.
  function annualCandidates(entries, unitRe) {
    const cands = [];
    entries.forEach((e, idx) => {
      const lines = e.lines;
      let m;
      ANNUAL_LABEL.lastIndex = 0;
      while ((m = ANNUAL_LABEL.exec(e.line))) {
        const after = e.line.slice(m.index + m[0].length);
        if (ANNUAL_PROSE_AFTER.test(after)) continue;
        if (labelIsProse(e.line, m.index)) continue;
        if (OTHER_COMMODITY[unitRe === KWH_UNIT ? 'kwh' : 'smc'].test(e.line)) continue;
        // Enel: "annuo in kWh ........ 563" (somma ultimi 12 mesi, non "da inizio fornitura").
        if (/annuo\s+in\s+kWh/i.test(m[0])) {
          const mm = new RegExp('^\\.*\\s*(' + NUM + ')\\b').exec(after.replace(/^[\s.]+/, '')) ;
          const nextTwo = [lines[e.i + 1], lines[e.i + 2]].join(' ');
          if (unitRe === KWH_UNIT && mm && /ultimi\s+12\s+mesi/i.test(nextTwo) && !/inizio\s+fornitura/i.test(nextTwo)) {
            cands.push({ value: parseItalianNumber(mm[1]), page: e.page, line: e.line, rangeLines: [], ctx: context(lines, e.i, e.i) });
          }
          continue;
        }
        // A2A (vecchio formato luce): "Consumo annuo" seguito da "Fascia F1/F2/F3: N kWh".
        // Il totale annuo è la somma delle tre fasce; mai un singolo valore di fascia.
        if (unitRe === KWH_UNIT && lines.slice(e.i + 1, e.i + 4).some((l) => FASCIA_LINE.test(l))) {
          const fasce = {};
          const used = [];
          for (let k = 1; k <= 10 && e.i + k < lines.length; k++) {
            const fm = FASCIA_LINE.exec(lines[e.i + k]);
            if (fm) { (fasce[fm[1]] = fasce[fm[1]] || []).push(parseItalianNumber(fm[2])); used.push(fm[0]); }
          }
          if (['1', '2', '3'].every((f) => fasce[f] && fasce[f].length === 1)) {
            // `line` resta una riga verbatim (l'etichetta); la somma si spiega in `note`.
            cands.push({ value: fasce['1'][0] + fasce['2'][0] + fasce['3'][0], page: e.page,
              line: e.line, note: 'somma delle fasce: ' + used.join(', '), rangeLines: lines.slice(e.i + 1, e.i + 14),
              ctx: context(lines, e.i, e.i + 4) });
          }
          continue;
        }
        // Stessa riga: "Consumo annuo: 841 kWh" (esclude le righe con più valori).
        const sameLine = unitTokens(after, unitRe);
        if (ambiguous(sameLine) || (sameLine.length && FASCIA_HINT.test(after))) continue;
        if (sameLine.length === 1) {
          cands.push({ value: sameLine[0], page: e.page, line: e.line, rangeLines: [e.line], ctx: context(lines, e.i, e.i) });
          continue;
        }
        if (sameLine.length > 1) continue;
        // Righe successive: la prima che porta un'unità deve portarne una sola.
        for (let k = 1; k <= WINDOW && e.i + k < lines.length; k++) {
          const l = lines[e.i + k];
          // "Spesa annua …" chiude la ricerca, tranne dentro una tabella "Tot. consumo":
          // due colonne fuse la mettono fra l'intestazione e i valori.
          if (/spesa\s+annu/i.test(l) && k > 1) {
            if (/tot(?:ale|\.)\s*consumo/i.test(lines[e.i + k - 1] || '') && !unitTokens(l, unitRe).length) continue;
            break;
          }
          // "Consumo fatturato: 348 kWh" è il consumo del periodo, non l'annuo. Qui ci
          // si ferma senza valore: saltare la riga e cercare oltre prenderebbe il
          // consumo del periodo quando due colonne si fondono in una riga (OCR di una
          // A2A: "666 kWh Consumo totale fatturato del periodo" e sotto "160 kWh").
          if (/fatturat|del\s+periodo|mensil/i.test(l)) break;
          const toks = unitTokens(l, unitRe);
          const otherUnit = unitRe === KWH_UNIT ? SMC_UNIT : KWH_UNIT;
          if (ambiguous(toks) || (toks.length && unitTokens(l, otherUnit).length)) break;
          if (!toks.length) continue;
          if (toks.length === 1) {
            if (FASCIA_HINT.test(l)) break;   // "F1 900 kWh": una fascia, non l'annuo
            cands.push({ value: toks[0], page: e.page, line: l, rangeLines: lines.slice(e.i + k, e.i + k + 3),
              ctx: context(lines, e.i, e.i + k) });
          } else if (unitRe === KWH_UNIT && toks.length >= 4 &&
                     Math.abs(toks[0] + toks[1] + toks[2] - toks[3]) <= 1 &&
                     /tot(?:ale|\.)\s*consumo/i.test((lines[e.i + k - 1] || '') + ' ' + (lines[e.i + k - 2] || '')) &&
                     (/ultimi\s+12\s+mesi/i.test((lines[e.i + k + 1] || '') + ' ' + (lines[e.i + k + 2] || '')) ||
                      rangesIn(e.line).some((r) => r.end - r.start >= 300 && r.end - r.start <= 400))) {
            // Enel: tabella "F1 F2 F3 Totale consumo" (o "Tot. consumo") sotto "Consumo annuo",
            // con F1+F2+F3 = totale; vale se la tabella dice "ultimi 12 mesi" o se l'etichetta
            // porta un periodo di un anno ("Consumo annuo (dal 01/09/2023 al 31/08/2024)").
            cands.push({ value: toks[3], page: e.page, line: l, rangeLines: [], ctx: context(lines, e.i, e.i + k) });
          }
          break;
        }
      }
    });
    return cands;
  }

  // Octopus (formato pre-2025): "Grafico consumi (ultimi 12 mesi): 952 kWh." accanto a un
  // "Consumo annuo: 841 kWh" fisso. Quella somma è parziale finché lo storico è più corto di
  // 12 mesi, quindi serve solo a far discordare i candidati: meglio nessun valore che uno sbagliato.
  function twelveMonthChartCandidates(entries) {
    const out = [];
    entries.forEach((e) => {
      const m = new RegExp('ultimi\\s+12\\s+mesi\\)?:\\s*(' + NUM + ')\\s*kWh\\b', 'i').exec(e.line);
      if (m) out.push({ value: parseItalianNumber(m[1]), page: e.page, line: e.line, rangeLines: [] });
    });
    return out;
  }

  // Data più recente tra i periodi "dal .. al .." del documento (durata <= 400 giorni).
  function documentLatestPeriodEnd(entries) {
    let latest = null;
    entries.forEach((e) => rangesIn(e.line).forEach((r) => {
      if (r.end - r.start <= 400 && r.end >= r.start && (latest === null || r.end > latest)) latest = r.end;
    }));
    return latest;
  }

  const STALE_DAYS = 100;

  // Un consumo annuo il cui periodo finisce molto prima dell'ultimo periodo del
  // documento è vecchio: una casella "Consumo annuo" può restare ferma su un periodo
  // di anni prima (layout A2A gas).
  function dropStale(cands, entries, warnings, key) {
    const latest = documentLatestPeriodEnd(entries);
    if (latest === null) return cands;
    const staleValues = [];
    cands.forEach((c) => {
      const lines = (c.rangeLines || []).concat(c.ctx || []);
      // Tutti i periodi plausibili (<= 400 giorni) delle righe del candidato: basta
      // che UNO sia vecchio. Il periodo dell'annuo non è sempre il primo: con le
      // colonne invertite viene prima quello della spesa annua: l'OCR può dare
      // "N Smc determinata dal … al …" (periodo della spesa) e sotto
      // "determinato dal … al …" (periodo del consumo).
      const rs = [];
      lines.forEach((l) => rangesIn(l).forEach((r) => { if (r.end >= r.start && r.end - r.start <= 400) rs.push(r); }));
      if (rs.some((r) => latest - r.end > STALE_DAYS)) staleValues.push(c.value);
    });
    if (!staleValues.length) return cands;
    warnings.push('Il ' + BOUNDS[key].label + ' in bolletta è vecchio (periodo concluso da oltre 3 mesi rispetto al resto del documento): ignorato.');
    return cands.filter((c) => staleValues.indexOf(c.value) === -1);
  }

  /* ---------- potenza impegnata ---------- */

  const POWER_LABEL = /potenza\s+(?:contrattualmente\s+)?impegnata/gi;
  const KW_AT_END = new RegExp('(' + NUM + ')\\s*kW(?![hH])(?:\\s*\\([^)]*\\))?\\s*$', 'i');

  function powerCandidates(entries) {
    const cands = [];
    entries.forEach((e) => {
      const lines = e.lines;
      const handle = (labelEnd, line) => {
        const after = line.slice(labelEnd);
        // Stessa riga: "Potenza impegnata: 6,00 kW", "Potenza impegnata (kW) 6".
        const same = new RegExp('^\\s*[:.]?\\s*(?:\\(kW\\)\\s*)?(' + NUM + ')\\s*(?:kW(?![hH])|$)', 'i').exec(after);
        if (same && (/kW/i.test(after.slice(0, same[0].length)) || /^\s*[:.]?\s*\(kW\)/i.test(after))) {
          cands.push({ value: parseItalianNumber(same[1]), page: e.page, line: line });
          return;
        }
        // Etichetta a fine riga: il valore chiude una delle righe successive. Una riga
        // che nomina un'altra potenza (disponibile, prelevata, massima, di picco)
        // chiude la ricerca PRIMA di leggerne il valore.
        // Riga di intestazioni ("POD: POTENZA IMPEGNATA: INDIRIZZO DI FORNITURA:") con i
        // valori nella riga sotto, nello stesso ordine: il kW può stare a metà riga. Vale
        // solo se quella riga porta un unico valore in kW; con più valori non si sceglie.
        if (/^\s*:\s*(?:[^\d:]{2,40}:\s*)+$/.test(after)) {
          for (let k = 1; k <= 2 && e.i + k < lines.length; k++) {
            const l = lines[e.i + k];
            if (/disponibil|prelevat|massim|potenza\s+(?:di\s+)?picco/i.test(l)) return;
            const re = new RegExp('(?:^|[^\\d.,])(' + NUM + ')\\s*kW(?![hH])', 'gi');
            const found = [];
            let t;
            while ((t = re.exec(l))) found.push(t);
            if (found.length > 1) return;
            if (found.length === 1) {
              const v = found[0];
              if (spaceThousands(l.slice(0, v.index + v[0].indexOf(v[1])), v[1])) return;
              cands.push({ value: parseItalianNumber(v[1]), page: e.page, line: l });
              return;
            }
          }
          return;
        }
        if (/^\s*:?\s*$/.test(after)) {
          for (let k = 1; k <= 3 && e.i + k < lines.length; k++) {
            const l = lines[e.i + k];
            if (/disponibil|prelevat|massim|potenza\s+(?:di\s+)?picco/i.test(l)) return;
            const v = KW_AT_END.exec(l);
            if (v) {
              if (spaceThousands(l.slice(0, v.index + v[0].indexOf(v[1])), v[1])) return;
              cands.push({ value: parseItalianNumber(v[1]), page: e.page, line: l });
              return;
            }
          }
        }
      };
      let m;
      POWER_LABEL.lastIndex = 0;
      while ((m = POWER_LABEL.exec(e.line))) {
        if (labelIsProse(e.line, m.index)) continue;
        handle(m.index + m[0].length, e.line);
      }
      // Enel: "Potenza contrattualmente" / "... impegnata" spezzato su due righe.
      if (/^(?:.*\s)?impegnata\s*:?\s*$/i.test(e.line) && !/potenza/i.test(e.line) &&
          /potenza\s+contrattualmente/i.test(e.lines[e.i - 1] || '')) {
        handle(e.line.length, e.line);
      }
    });
    return cands;
  }

  /* ---------- residente ---------- */

  const RESIDENCE_VALUE = /domestic[oa]\s+(non\s+)?residente\b/i;
  const CLIENT_LABEL = /tipologia\s+(?:di\s+)?cliente\b/gi;

  function residenceCandidates(entries) {
    const cands = [];
    entries.forEach((e) => {
      let m;
      CLIENT_LABEL.lastIndex = 0;
      while ((m = CLIENT_LABEL.exec(e.line))) {
        if (labelIsProse(e.line, m.index)) continue;
        const after = e.line.slice(m.index + m[0].length);
        const sameLine = RESIDENCE_VALUE.exec(after);
        if (sameLine && /^\s*:?\s*$/.test(after.slice(0, sameLine.index))) {
          cands.push({ value: !sameLine[1], page: e.page, line: e.line });
          continue;
        }
        for (let k = 1; k <= 4 && e.i + k < e.lines.length; k++) {
          const l = e.lines[e.i + k];
          // Valore spezzato su due righe da una colonna stretta: "DOMESTICO NON" e sotto
          // "RESIDENTE" (a inizio o a fine riga, se due colonne si fondono). Senza questo il
          // "NON" si perde e resta solo un eventuale "domestico residente" altrove.
          const split = /\bdomestic[oa](\s+non)?\s*$/i.exec(l);
          const next = e.lines[e.i + k + 1] || '';
          const rest = split && (/^\s*(non\s+)?residente\b/i.exec(next) || /\b(non\s+)?residente\s*$/i.exec(next));
          if (rest) {
            cands.push({ value: !(split[1] || rest[1]), page: e.page, line: l, note: 'continua nella riga dopo: «' + next + '»' });
            break;
          }
          const v = RESIDENCE_VALUE.exec(l);
          if (v && (v.index === 0 || /domestic[oa]\s+(non\s+)?residente\s*$/i.test(l))) {
            cands.push({ value: !v[1], page: e.page, line: l });
            break;
          }
        }
      }
    });
    return cands;
  }

  /* ---------- regione (dall'indirizzo di FORNITURA) ---------- */

  const SUPPLY_LABEL = /(?:indirizzo|punto|luogo|sito|ubicazione)\s+(?:di\s+|della\s+|del\s+)?fornitura|dati\s+(?:della\s+)?fornitura|forniamo\s+energia\s+in|la\s+fornitura\s+di\s+[^:]{0,40}\s+è\s+in/gi;
  const COMPANY_LINE = /sede\s+legale|società/i;
  // Prime due cifre del CAP → province possibili. Generata da comuni-json
  // (github.com/matteocontrini/comuni-json, dati ISTAT, 7904 comuni),
  // più le vecchie sarde (OT OG CI VS). Una sigla che il CAP non ammette è una
  // lettura sbagliata (OCR) o una sigla presa dalla riga sbagliata: nessun valore.
  const CAP_PROVINCES = {
    '00': 'RM', '01': 'VT', '02': 'RI', '03': 'FR', '04': 'LT', '05': 'TR', '06': 'PG',
    '07': 'OT SS', '08': 'NU OG', '09': 'CA CI OR SU VS', '10': 'TO', '11': 'AO', '12': 'CN SV',
    '13': 'BI VC', '14': 'AT', '15': 'AL', '16': 'GE', '17': 'SV', '18': 'CN IM', '19': 'SP',
    '20': 'MB MI', '21': 'VA', '22': 'CO', '23': 'BG LC SO', '24': 'BG', '25': 'BS', '26': 'CR LO',
    '27': 'PV', '28': 'NO VB', '29': 'PC', '30': 'VE', '31': 'TV', '32': 'BL', '33': 'PN UD',
    '34': 'GO TS', '35': 'PD', '36': 'VI', '37': 'VR', '38': 'TN', '39': 'BZ', '40': 'BO',
    '41': 'MO', '42': 'RE', '43': 'PR', '44': 'FE', '45': 'RO', '46': 'MN', '47': 'FC RN',
    '48': 'RA', '50': 'FI', '51': 'PT', '52': 'AR', '53': 'SI', '54': 'MS', '55': 'LU', '56': 'PI',
    '57': 'LI', '58': 'GR', '59': 'PO', '60': 'AN', '61': 'PU', '62': 'MC', '63': 'AP FM',
    '64': 'TE', '65': 'PE', '66': 'CH', '67': 'AQ', '70': 'BA', '71': 'FG', '72': 'BR', '73': 'LE',
    '74': 'TA', '75': 'MT', '76': 'BT', '80': 'NA', '81': 'CE', '82': 'BN', '83': 'AV', '84': 'SA',
    '85': 'PZ', '86': 'CB IS', '87': 'CS', '88': 'CZ KR', '89': 'RC VV', '90': 'PA', '91': 'TP',
    '92': 'AG', '93': 'CL', '94': 'EN', '95': 'CT', '96': 'SR', '97': 'RG', '98': 'ME',
  };
  const capAllows = (cap, sigla) => (' ' + (CAP_PROVINCES[cap.slice(0, 2)] || '') + ' ').indexOf(' ' + sigla + ' ') >= 0;

  // "(FC)" dopo il nome di un comune. Le righe tecniche si saltano: "230 V (BT)"
  // è la bassa tensione, ma BT/MT/AT sono anche sigle di provincia.
  const PAREN_PROVINCE = /[A-Za-zÀ-ÿ'.]\s*\(([A-Z]{2})\)/g;
  const NOT_ADDRESS = /tension|alimentazion|\d\s*k?V\b/i;
  const CAP = /\b\d{5}\b[\s\-–,]+/g;
  const CITY_WORDS = 6;

  // Sigla dopo il CAP: tra le prime parole (fino a una con cifre) cerca i token di
  // due maiuscole che siano province. Se ce n'è più d'uno ("46027 SAN BENEDETTO PO
  // MN", "28856 RE VB") il comune contiene una sigla: ambiguo, nessun valore.
  function capProvinces(line) {
    const out = [];
    let m;
    CAP.lastIndex = 0;
    while ((m = CAP.exec(line))) {
      const words = line.slice(m.index + m[0].length).split(/\s+/);
      const found = [];
      for (const w of words.slice(0, CITY_WORDS)) {
        if (/\d/.test(w)) break;
        const t = w.replace(/[,;:.]+$/, '');   // "CA'" resta con l'apostrofo: non è una sigla
        if (/^[A-Z]{2}$/.test(t) && PROVINCE_TO_REGION[t] && found.indexOf(t) === -1) found.push(t);
      }
      out.push({ cap: m[0].match(/\d{5}/)[0], found });
    }
    return out;
  }

  // undefined: nessuna sigla nella riga; null: sigla ambigua o in conflitto col CAP
  // (ci si ferma); altrimenti {sigla, cap} (cap null se la riga non ne ha uno).
  function provinceInLine(line) {
    if (NOT_ADDRESS.test(line)) return undefined;
    let m;
    PAREN_PROVINCE.lastIndex = 0;
    while ((m = PAREN_PROVINCE.exec(line))) {
      if (!PROVINCE_TO_REGION[m[1]]) continue;
      const caps = line.slice(0, m.index).match(/\b\d{5}\b/g);
      const cap = caps ? caps[caps.length - 1] : null;
      return cap && !capAllows(cap, m[1]) ? null : { sigla: m[1], cap };
    }
    const caps = capProvinces(line);
    for (let i = 0; i < caps.length; i++) {
      const found = caps[i].found;
      if (found.length > 1) return null;
      if (found.length === 1) return capAllows(caps[i].cap, found[0]) ? { sigla: found[0], cap: caps[i].cap } : null;
    }
    return undefined;
  }

  function regionCandidates(entries) {
    const cands = [];
    entries.forEach((e) => {
      let m;
      SUPPLY_LABEL.lastIndex = 0;
      while ((m = SUPPLY_LABEL.exec(e.line))) {
        if (labelIsProse(e.line, m.index)) continue;
        // La ricerca parte dopo l'etichetta e si ferma al primo indirizzo trovato.
        for (let k = 0; k <= 4 && e.i + k < e.lines.length; k++) {
          let l = e.lines[e.i + k];
          if (k > 0 && (COMPANY_LINE.test(l) || /indirizzo\s+di\s+(?:fatturazione|recapito)/i.test(l))) break;
          const text = k === 0 ? l.slice(m.index + m[0].length) : l;
          const found = provinceInLine(text);
          if (found === null) break;            // sigla ambigua: meglio nessun valore
          // La prima riga con un CAP è l'indirizzo di fornitura: senza sigla lì, la regione
          // manca. Cercare oltre prenderebbe la sigla di un altro indirizzo (destinatario,
          // recapito) che due colonne fuse mettono nella riga sotto.
          if (!found && /\b\d{5}\b/.test(text)) {
            // ...salvo la riga dopo, se continua lo stesso indirizzo: lo STESSO CAP con la
            // sigla (lo stesso CAP vale la stessa provincia, qualunque blocco la porti), o
            // comune e sigla senza alcun CAP ("… - 47034 -" e sotto "COMUNE (XX)"), purché
            // il CAP ammetta quella sigla.
            const cap = text.match(/\b\d{5}\b/)[0];
            const nextLine = e.lines[e.i + k + 1] || '';
            const again = provinceInLine(nextLine);
            const caps = nextLine.match(/\b\d{5}\b/g) || [];
            const continues = again && capAllows(cap, again.sigla) &&
              (again.cap === cap || (!caps.length && again.cap === null));
            if (continues) cands.push({ sigla: again.sigla, cap, value: PROVINCE_TO_REGION[again.sigla], page: e.page, line: nextLine });
            break;
          }
          if (found) { cands.push({ sigla: found.sigla, cap: found.cap, value: PROVINCE_TO_REGION[found.sigla], page: e.page, line: l }); break; }
        }
      }
    });
    return cands;
  }

  /* ---------- classificazione e scansioni ---------- */

  function detectKind(entries) {
    let kwh = 0, smc = 0;
    entries.forEach((e) => {
      kwh += unitTokens(e.line, KWH_UNIT).length;
      smc += unitTokens(e.line, SMC_UNIT).length;
    });
    if (kwh >= 3 && smc >= 3) return 'dual';
    if (kwh >= 3 && smc < 3) return 'luce';
    if (smc >= 3 && kwh < 3) return 'gas';
    // Poche quantità con unità (es. E.ON scrive "3,913" senza kWh): contiamo POD e PDR.
    let pod = 0, pdr = 0;
    entries.forEach((e) => {
      if (/\bPOD\b/.test(e.line)) pod++;
      if (/\bPDR\b/.test(e.line)) pdr++;
    });
    if (pod > pdr) return 'luce';
    if (pdr > pod) return 'gas';
    return null;
  }

  function looksScanned(pages) {
    const chars = pages.reduce((n, lines) => n + (lines || []).join('').replace(/\s/g, '').length, 0);
    return chars < 30 * Math.max(1, pages.length);
  }

  /* ---------- parseBill ---------- */

  // opts.ocr: le righe vengono dall'OCR (beta), non dal testo del PDF. Il risultato
  // porta `ocr: true` e passa dai controlli di ocrGate.
  function parseBill(pages, opts) {
    pages = pages || [];
    const ocr = !!(opts && opts.ocr);
    const today = opts && opts.today ? new Date(opts.today) : new Date();
    const result = { kind: null, fields: {}, warnings: [], scanned: false };
    if (ocr) result.ocr = true;
    if (looksScanned(pages)) {
      if (ocr) {                // l'OCR non ha letto testo: non è "una scansione"
        result.warnings.push('L’OCR non ha trovato testo leggibile: prova con una foto più nitida e dritta.');
        return result;
      }
      result.scanned = true;
      result.warnings.push('Il PDF sembra una scansione (nessun testo leggibile): le scansioni non sono supportate.');
      return result;
    }
    const entries = flatten(pages);
    const warnings = result.warnings;
    result.kind = detectKind(entries);
    const wantLuce = result.kind !== 'gas';
    const wantGas = result.kind !== 'luce';
    const ordered = (key, c) => {
      if (!c) return;
      result.fields[key] = { value: c.value, page: c.page, line: c.line };
      if (c.note) result.fields[key].note = c.note;
    };

    if (wantLuce) {
      const annual = annualCandidates(entries, KWH_UNIT);
      // Il grafico "ultimi 12 mesi" entra solo DOPO lo scarto dei valori vecchi: serve
      // a far discordare un annuo sospetto, mai a sostituirne uno scartato.
      const kept = dropStale(annual, entries, warnings, 'kwh');
      const c = kept.length ? kept.concat(twelveMonthChartCandidates(entries)) : kept;
      const hit = resolve('kwh', c, warnings);
      ordered('kwh', ocr ? ocrAnnual('kwh', hit, c, warnings, today) : hit);

      const p = powerCandidates(entries);
      const kw = resolve('kw', p, warnings);
      ordered('kw', kw);

      const r = residenceCandidates(entries);
      const distinct = r.filter((x, i) => r.findIndex((y) => y.value === x.value) === i);
      if (distinct.length === 1) ordered('residente', distinct[0]);
      else if (distinct.length > 1) warnings.push('Residente / non residente: indicazioni discordanti nella bolletta, impostalo a mano.');
    }

    if (wantGas) {
      const raw = annualCandidates(entries, SMC_UNIT);
      const c = dropStale(raw, entries, warnings, 'smc');
      const hit = resolve('smc', c, warnings);
      ordered('smc', ocr ? ocrAnnual('smc', hit, c, warnings, today) : hit);
    }

    {
      const g = regionCandidates(entries);
      const distinct = g.filter((x, i) => g.findIndex((y) => y.value === x.value) === i);
      // OCR: la sigla vale solo se un CAP sulla stessa riga la conferma (una lettera
      // letta male d\u00e0 spesso un'altra sigla valida: \u00abROMA RN\u00bb)
      const confirmed = ocr ? g.filter((x) => x.cap) : g;
      const hits = confirmed.filter((x, i) => confirmed.findIndex((y) => y.value === x.value) === i);
      if (distinct.length > 1) warnings.push('Regione: indirizzi di fornitura discordanti, sceglila a mano.');
      else if (hits.length === 1) ordered('regione', hits[0]);
      else if (distinct.length === 1) warnings.push('Regione letta dall\u2019OCR senza un CAP che la confermi: sceglila a mano.');
    }
    if (ocr) ocrGate(result);
    // Un campo semplicemente assente non genera avvisi: la UI elenca da sé i
    // campi mancanti. `warnings` spiega solo perché un valore presente in
    // bolletta è stato scartato (discordante, fuori scala, vecchio).
    return result;
  }

  // OCR: un consumo annuo vale solo se nel suo contesto (dall'etichetta al valore, ±2
  // righe) c'è un periodo annuo (300-400 giorni) concluso negli ultimi 18 mesi, o
  // «ultimi 12 mesi», e NESSUN periodo annuo più vecchio: periodi in conflitto =
  // nessun valore. Il caso da evitare è una casella annua ferma su un periodo vecchio
  // (layout A2A gas): in foto della sola pag. 1 si legge «CONSUMO ANNUO / N Smc» senza
  // date, e nient'altro sulla pagina dice che è vecchia (il periodo sta a pag. 3).
  const FRESH_DAYS = 548;
  function ocrAnnual(key, hit, cands, warnings, today) {
    if (!hit) return hit;
    const now = dayNumber(today.getUTCDate(), today.getUTCMonth() + 1, today.getUTCFullYear());
    let fresh = false, old = false;
    cands.filter((c) => c.value === hit.value).forEach((c) => {
      const text = (c.ctx || []).join(' ');
      if (/ultimi\s+12\s+mesi/i.test(text)) fresh = true;
      rangesIn(text).forEach((r) => {
        if (r.end - r.start < 300 || r.end - r.start > 400) return;
        if (now - r.end <= FRESH_DAYS && r.end - now <= 31) fresh = true;
        else old = true;
      });
    });
    if (fresh && !old) return hit;
    warnings.push(old
      ? 'Il ' + BOUNDS[key].label + ' letto dall\u2019OCR ha accanto un periodo vecchio: ignorato, inseriscilo a mano.'
      : 'Il ' + BOUNDS[key].label + ' letto dall\u2019OCR non ha accanto il suo periodo recente: non posso ' +
        'verificare che sia aggiornato, inseriscilo a mano.');
    return null;
  }

  // Controlli in più per l'OCR, dove una cifra può essere letta male: la potenza
  // impegnata contrattuale è un multiplo di 0,5 kW (1,5 · 3 · 4,5 · 6 …: 3,3 è la
  // disponibile), il consumo annuo in bolletta è un intero.
  function ocrGate(result) {
    const f = result.fields;
    if (f.kw && Math.abs(f.kw.value * 2 - Math.round(f.kw.value * 2)) > 1e-9) {
      result.warnings.push('Potenza letta dall’OCR non plausibile (' + f.kw.value + ' kW): inseriscila a mano.');
      delete f.kw;
    }
    for (const k of ['kwh', 'smc']) {
      if (f[k] && !Number.isInteger(f[k].value)) {
        result.warnings.push('Consumo letto dall’OCR non plausibile (' + f[k].value + '): inseriscilo a mano.');
        delete f[k];
      }
    }
  }

  return {
    linesFromTextContent: linesFromTextContent,
    parseBill: parseBill,
    parseItalianNumber: parseItalianNumber,
    PROVINCE_TO_REGION: PROVINCE_TO_REGION,
  };
});
