/*
 * ocr.js — lettura OCR (beta) di una bolletta scansionata o fotografata, nel browser.
 *
 * PaddleOCR: detector PP-OCRv3 mobile + riconoscitore PP-OCRv5 latin mobile, in
 * onnxruntime-web (WASM, un thread: GitHub Pages non manda COOP/COEP). Porta in JS
 * la pipeline Python di PaddleOCR: soglie 0,3 / 0,6, unclip 1,6, altezza di
 * riconoscimento 48, canali in ordine BGR come cv2.imread, con cui i modelli sono
 * stati esportati.
 *
 * Un solo file con due ruoli:
 *  - libreria pura (UMD: window.EnergyOcr / module.exports), testata in node;
 *  - entry point del Web Worker: `new Worker('ocr.js')` installa onmessage.
 *
 * Protocollo del worker (postMessage):
 *   → {type:'init', base}            base = cartella degli asset (vendor/ocr-v1/)
 *   ← {type:'progress', phase:'download', loaded, total}
 *   ← {type:'ready'} | {type:'error', message}
 *   → {type:'page', id, width, height, buffer}   buffer = RGBA (ArrayBuffer, trasferito)
 *   ← {type:'progress', phase:'boxes', id, done, total}
 *   ← {type:'page', id, lines: string[], boxes, ms}
 * Niente lascia il dispositivo: il worker scarica solo gli asset, dallo stesso sito.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) lib.installWorker(root);
  else root.EnergyOcr = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DET_MAX_SIDE = 960;     // un lato più grande (1600) non legge meglio ed è più lento
  const DET_THRESHOLD = 0.3;
  const BOX_THRESHOLD = 0.6;
  const UNCLIP_RATIO = 1.6;
  const REC_HEIGHT = 48;
  const REC_MIN_WIDTH = 16;
  // Come il NormalizeImage di PaddleOCR: l'immagine è BGR (cv2.imread)
  // e media/deviazione si applicano nell'ordine dell'array, quindi al canale 0 (B)
  // va 0,485. Non è la media ImageNet "girata" in BGR: è quella con cui il modello
  // è stato addestrato ed esportato.
  const MEAN_BGR = [0.485, 0.456, 0.406];
  const STD_BGR = [0.229, 0.224, 0.225];

  /* ---------- detector: input ---------- */

  function detInputSize(w, h, maxSide) {
    const r = Math.min(1, (maxSide || DET_MAX_SIDE) / Math.max(w, h));
    return {
      nw: Math.max(32, Math.round((w * r) / 32) * 32),
      nh: Math.max(32, Math.round((h * r) / 32) * 32),
    };
  }

  // RGBA (w×h) → tensore NCHW float32 nw×nh, canali B,G,R, normalizzato. Ridimensiona
  // per media d'area quando riduce (niente aliasing su un foglio a 2000 px), bilineare
  // quando ingrandisce.
  function detTensor(rgba, w, h, nw, nh) {
    const out = new Float32Array(3 * nw * nh);
    const plane = nw * nh;
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = y * sy, y1 = Math.min(h, (y + 1) * sy);
      for (let x = 0; x < nw; x++) {
        const x0 = x * sx, x1 = Math.min(w, (x + 1) * sx);
        let r = 0, g = 0, b = 0, n = 0;
        if (sx <= 1 && sy <= 1) {
          const px = bilinear(rgba, w, h, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
          r = px[0]; g = px[1]; b = px[2]; n = 1;
        } else {
          for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
            for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
              const i = (yy * w + xx) * 4;
              r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
            }
          }
        }
        const o = y * nw + x;
        out[o] = (b / n / 255 - MEAN_BGR[0]) / STD_BGR[0];
        out[plane + o] = (g / n / 255 - MEAN_BGR[1]) / STD_BGR[1];
        out[2 * plane + o] = (r / n / 255 - MEAN_BGR[2]) / STD_BGR[2];
      }
    }
    return out;
  }

  function bilinear(rgba, w, h, fx, fy) {
    fx = Math.min(w - 1, Math.max(0, fx));
    fy = Math.min(h - 1, Math.max(0, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const top = rgba[i00 + c] * (1 - ax) + rgba[i10 + c] * ax;
      const bot = rgba[i01 + c] * (1 - ax) + rgba[i11 + c] * ax;
      out[c] = top * (1 - ay) + bot * ay;
    }
    return out;
  }

  /* ---------- geometria: inviluppo convesso e rettangolo d'area minima ---------- */

  function convexHull(pts) {          // monotone chain; pts = [[x,y],…]
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // Come cv2.minAreaRect: {cx, cy, w, h, ux, uy} con (ux,uy) versore del lato w.
  function minAreaRect(pts) {
    const hull = convexHull(pts);
    if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: 1, uy: 0 };
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      let ux = b[0] - a[0], uy = b[1] - a[1];
      const len = Math.hypot(ux, uy);
      if (!len) continue;
      ux /= len; uy /= len;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const q of hull) {
        const u = q[0] * ux + q[1] * uy, v = -q[0] * uy + q[1] * ux;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
        best = { area, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, ux, uy };
      }
    }
    // orientazione canonica: lato w il più vicino all'orizzontale
    if (Math.abs(best.uy) > Math.abs(best.ux)) {
      best = { cx: best.cx, cy: best.cy, w: best.h, h: best.w, ux: best.uy, uy: -best.ux };
    }
    if (best.ux < 0) { best.ux = -best.ux; best.uy = -best.uy; }
    return { cx: best.cx, cy: best.cy, w: best.w, h: best.h, ux: best.ux, uy: best.uy };
  }

  // Vertici in ordine alto-sinistra, alto-destra, basso-destra, basso-sinistra.
  function rectCorners(r) {
    const hx = (r.w / 2) * r.ux, hy = (r.w / 2) * r.uy;      // mezzo lato w
    const vx = -(r.h / 2) * r.uy, vy = (r.h / 2) * r.ux;     // mezzo lato h (verso il basso)
    return [[r.cx - hx - vx, r.cy - hy - vy], [r.cx + hx - vx, r.cy + hy - vy],
      [r.cx + hx + vx, r.cy + hy + vy], [r.cx - hx + vx, r.cy - hy + vy]];
  }

  /* ---------- detector: post-processing (DB) ---------- */

  // Mappa di probabilità W×H → rettangoli di testo, in coordinate della mappa.
  function dbBoxes(prob, W, H) {
    const N = W * H;
    const label = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const boxes = [];
    for (let s = 0; s < N; s++) {
      if (label[s] !== -1 || prob[s] <= DET_THRESHOLD) continue;
      // componente 8-connessa (equivale al contorno esterno di cv2.findContours)
      const pts = [];
      let top = 0;
      stack[top++] = s; label[s] = boxes.length;
      while (top) {
        const p = stack[--top];
        const px = p % W, py = (p - px) / W;
        pts.push([px, py]);
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if ((!dx && !dy) || nx < 0 || nx >= W) continue;
            const q = ny * W + nx;
            if (label[q] === -1 && prob[q] > DET_THRESHOLD) { label[q] = boxes.length; stack[top++] = q; }
          }
        }
      }
      boxes.push(null);                 // segnaposto: l'etichetta è l'indice
      if (pts.length < 4) continue;
      const r = minAreaRect(pts);
      if (Math.min(r.w, r.h) < 3) continue;
      if (rectMean(prob, W, H, r) < BOX_THRESHOLD) continue;
      // unclip: per un rettangolo l'offset di pyclipper allarga ogni lato di d
      const area = r.w * r.h, peri = 2 * (r.w + r.h);
      const d = (area * UNCLIP_RATIO) / Math.max(peri, 1e-6);
      const g = { cx: r.cx, cy: r.cy, w: r.w + 2 * d, h: r.h + 2 * d, ux: r.ux, uy: r.uy };
      if (Math.min(g.w, g.h) < 5) continue;
      boxes[boxes.length - 1] = g;
    }
    return boxes.filter(Boolean);
  }

  // Media della probabilità dentro il rettangolo (come cv2.mean con la maschera fillPoly).
  function rectMean(prob, W, H, r) {
    const c = rectCorners(r);
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - r.cx, dy = y - r.cy;
        const u = dx * r.ux + dy * r.uy, v = -dx * r.uy + dy * r.ux;
        if (Math.abs(u) <= r.w / 2 + 0.5 && Math.abs(v) <= r.h / 2 + 0.5) { sum += prob[y * W + x]; n++; }
      }
    }
    return n ? sum / n : 0;
  }

  // Rettangolo della mappa → coordinate dell'immagine originale.
  function scaleRect(r, fx, fy) {
    const c = rectCorners(r).map((p) => [p[0] * fx, p[1] * fy]);
    return c;
  }

  /* ---------- riconoscitore ---------- */

  // Ritaglio di un quadrilatero (alto-sx, alto-dx, basso-dx, basso-sx) → tensore 1×3×48×nw
  // BGR normalizzato in [-1, 1]. Un riquadro alto e stretto (≥ 1,5) si ruota di 90° in
  // senso antiorario, come np.rot90 nella pipeline Python.
  function cropTensor(rgba, w, h, quad) {
    const [p0, p1, , p3] = quad;
    const bw = Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
    const bh = Math.max(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]), Math.hypot(quad[2][0] - p1[0], quad[2][1] - p1[1]));
    const rotate = Math.floor(bh) / Math.max(1, Math.floor(bw)) >= 1.5;
    const outW0 = rotate ? bh : bw, outH0 = rotate ? bw : bh;
    const nw = Math.max(REC_MIN_WIDTH, Math.ceil((REC_HEIGHT * outW0) / Math.max(1, outH0)));
    const ex = [p1[0] - p0[0], p1[1] - p0[1]], ey = [p3[0] - p0[0], p3[1] - p0[1]];
    const data = new Float32Array(3 * REC_HEIGHT * nw);
    const plane = REC_HEIGHT * nw;
    for (let v = 0; v < REC_HEIGHT; v++) {
      for (let u = 0; u < nw; u++) {
        const s = (u + 0.5) / nw, t = (v + 0.5) / REC_HEIGHT;
        // senza rotazione: (s, t) lungo (ex, ey); con rot90 antiorario: x = 1 - t, y = s
        const a = rotate ? 1 - t : s, b = rotate ? s : t;
        const px = bilinear(rgba, w, h, p0[0] + a * ex[0] + b * ey[0] - 0.5, p0[1] + a * ex[1] + b * ey[1] - 0.5);
        const o = v * nw + u;
        data[o] = (px[2] / 255 - 0.5) / 0.5;
        data[plane + o] = (px[1] / 255 - 0.5) / 0.5;
        data[2 * plane + o] = (px[0] / 255 - 0.5) / 0.5;
      }
    }
    return { data, width: nw };
  }

  // Decodifica CTC greedy: logits T×C, classe 0 = blank.
  function ctcDecode(logits, T, C, chars) {
    let s = '', prev = 0;
    for (let t = 0; t < T; t++) {
      let bi = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) { const v = logits[t * C + c]; if (v > bv) { bv = v; bi = c; } }
      if (bi !== prev && bi !== 0) s += chars[bi] || '';
      prev = bi;
    }
    return s;
  }

  // Dizionario del riconoscitore: 'blank' + 502 righe di dict.txt + spazio (come PaddleOCR).
  function charsFromDict(text) {
    return ['blank'].concat(text.split('\n').slice(0, 502), [' ']);
  }

  /* ---------- righe ---------- */

  // items: [{y0, y1, x0, text}] → righe (centro verticale dentro una riga esistente).
  function groupLines(items) {
    const sorted = items.filter((i) => i.text.trim()).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const it of sorted) {
      const mid = (it.y0 + it.y1) / 2;
      const ln = lines.find((l) => l.y0 < mid && mid < l.y1);
      if (ln) ln.items.push(it);
      else lines.push({ y0: it.y0, y1: it.y1, items: [it] });
    }
    return lines.map((l) => l.items.sort((a, b) => a.x0 - b.x0).map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  /* ---------- worker ---------- */

  function installWorker(scope) {
    let ort = null, det = null, rec = null, chars = null;

    async function fetchWithProgress(url, onBytes) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' per ' + url);
      if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); onBytes(b.byteLength); return b; }
      const reader = res.body.getReader();
      const parts = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); n += value.byteLength; onBytes(value.byteLength);
      }
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return out.buffer;
    }

    async function init(base) {
      const manifest = await (await fetch(base + 'manifest.json')).json();
      const total = manifest.total_bytes;
      let loaded = 0;
      const tick = (n) => { loaded += n; scope.postMessage({ type: 'progress', phase: 'download', loaded, total }); };
      ort = await import(base + 'ort.wasm.min.mjs');
      tick(manifest.files['ort.wasm.min.mjs'].bytes);
      ort.env.wasm.wasmPaths = base;
      ort.env.wasm.numThreads = 1;       // senza COOP/COEP non ci sono thread
      ort.env.wasm.proxy = false;
      // il .wasm lo scarica ort: lo si precarica qui per contarlo nella barra
      const wasm = await fetchWithProgress(base + 'ort-wasm-simd-threaded.wasm', tick);
      ort.env.wasm.wasmBinary = wasm;
      const [detBuf, recBuf, dict] = await Promise.all([
        fetchWithProgress(base + 'det.onnx', tick),
        fetchWithProgress(base + 'rec.onnx', tick),
        fetchWithProgress(base + 'dict.txt', tick).then((b) => new TextDecoder().decode(b)),
      ]);
      chars = charsFromDict(dict);
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      det = await ort.InferenceSession.create(new Uint8Array(detBuf), opts);
      rec = await ort.InferenceSession.create(new Uint8Array(recBuf), opts);
    }

    async function page(msg) {
      const t0 = Date.now();
      const rgba = new Uint8ClampedArray(msg.buffer);
      const { width: w, height: h } = msg;
      const { nw, nh } = detInputSize(w, h);
      const dIn = new ort.Tensor('float32', detTensor(rgba, w, h, nw, nh), [1, 3, nh, nw]);
      const dOut = await det.run({ [det.inputNames[0]]: dIn });
      const prob = dOut[det.outputNames[0]].data;
      const rects = dbBoxes(prob, nw, nh);
      const items = [];
      for (let i = 0; i < rects.length; i++) {
        const quad = scaleRect(rects[i], w / nw, h / nh);
        const crop = cropTensor(rgba, w, h, quad);
        const rIn = new ort.Tensor('float32', crop.data, [1, 3, REC_HEIGHT, crop.width]);
        const rOut = (await rec.run({ [rec.inputNames[0]]: rIn }))[rec.outputNames[0]];
        const [, T, C] = rOut.dims;
        const text = ctcDecode(rOut.data, T, C, chars);
        const ys = quad.map((p) => p[1]), xs = quad.map((p) => p[0]);
        items.push({ y0: Math.min(...ys), y1: Math.max(...ys), x0: Math.min(...xs), text });
        if (i % 8 === 7) scope.postMessage({ type: 'progress', phase: 'boxes', id: msg.id, done: i + 1, total: rects.length });
      }
      return { type: 'page', id: msg.id, lines: groupLines(items), boxes: rects.length, ms: Date.now() - t0 };
    }

    let queue = Promise.resolve();
    scope.onmessage = (e) => {
      const msg = e.data || {};
      queue = queue.then(async () => {
        try {
          if (msg.type === 'init') { await init(msg.base); scope.postMessage({ type: 'ready' }); }
          else if (msg.type === 'page') scope.postMessage(await page(msg));
        } catch (err) {
          scope.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
        }
      });
    };
  }

  return {
    DET_MAX_SIDE, REC_HEIGHT,
    detInputSize, detTensor, convexHull, minAreaRect, rectCorners, dbBoxes, rectMean, scaleRect,
    cropTensor, ctcDecode, charsFromDict, groupLines, installWorker,
  };
});
