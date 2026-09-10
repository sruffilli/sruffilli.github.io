// Sentieri — list + map of 3-day trekking candidates. Vanilla ES module,
// Leaflet vendored, routes.json is the source of truth for every string.

const AREA_COLORS = {
  laghi: 'var(--area-laghi)',
  emilia: 'var(--area-emilia)',
  romagna: 'var(--area-romagna)',
  lombardia: 'var(--area-lombardia)',
};
const AREA_HEX = { laghi: '#2b6cb0', emilia: '#b7410e', romagna: '#2f6b3a', lombardia: '#6b3fa0' };
const FIT = {
  ok: { label: '≤ 1000 m/g', color: 'var(--fit-ok)' },
  borderline: { label: 'sfora di poco', color: 'var(--fit-borderline)' },
  over: { label: 'sfora', color: 'var(--fit-over)' },
  unknown: { label: 'da verificare', color: 'var(--fit-unknown)' },
};
const ACCESS = { treno: 'treno', bus: 'bus', auto: 'in auto' };

const state = {
  data: null,
  tracks: new Map(),
  filters: { area: null, access: null, fit: null },
  active: null,
  layers: new Map(), // id → { group, lines: [] }
  map: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};

const fmtKm = (n) => (n == null ? '—' : `${Math.round(n * 10) / 10} km`.replace('.', ','));
const fmtM = (n) => (n == null ? '—' : `+${Math.round(n)} m`);

/** Official figure if routes.json has one, else BRouter's estimate flagged `est`. */
function dayFigures(route, i) {
  const d = route.days[i];
  const t = state.tracks.get(route.id)?.days?.[i];
  return {
    km: d.km ?? t?.km ?? null,
    kmEst: d.km == null,
    dplus: d.dplus ?? t?.dplus ?? null,
    dplusEst: d.dplus == null,
  };
}

function totals(route) {
  let km = 0, dplus = 0, est = false, maxDay = 0;
  route.days.forEach((_, i) => {
    const f = dayFigures(route, i);
    km += f.km || 0;
    dplus += f.dplus || 0;
    est = est || f.kmEst || f.dplusEst;
    maxDay = Math.max(maxDay, f.dplus || 0);
  });
  return { km, dplus, est, maxDay };
}

// ---------------------------------------------------------------- rendering

function renderHeader() {
  const { subtitle, constraints } = state.data;
  $('#subtitle').textContent = subtitle;
  $('#constraints').replaceChildren(
    el('li', {}, `${constraints.days} giorni`),
    el('li', {}, `~${constraints.kmTarget} km`),
    el('li', {}, `≤ ${constraints.dplusMaxPerDay} m/giorno`),
    el('li', {}, 'partenza coi mezzi o anello dall\u2019auto')
  );
}

function renderFilters() {
  const groups = {
    area: Object.entries(state.data.areas),
    access: Object.entries(ACCESS),
    fit: Object.entries(FIT).map(([k, v]) => [k, v.label]),
  };
  for (const [name, options] of Object.entries(groups)) {
    const box = $(`.filters__group[data-filter="${name}"]`);
    box.replaceChildren(
      ...options.map(([value, label]) =>
        el('button', {
          type: 'button',
          'data-value': value,
          'aria-pressed': String(state.filters[name] === value),
          onclick: () => {
            state.filters[name] = state.filters[name] === value ? null : value;
            renderFilters();
            applyFilters();
          },
        }, label)
      )
    );
  }
}

function visible(route) {
  const f = state.filters;
  if (f.area && route.area !== f.area) return false;
  if (f.access && route.access !== f.access) return false;
  if (f.fit && route.fit !== f.fit) return false;
  return true;
}

function applyFilters() {
  let n = 0;
  for (const route of state.data.routes) {
    const show = visible(route);
    $(`#route-${route.id}`).hidden = !show;
    const layer = state.layers.get(route.id);
    if (layer) {
      if (show && !state.map.hasLayer(layer.group)) layer.group.addTo(state.map);
      if (!show && state.map.hasLayer(layer.group)) layer.group.remove();
    }
    n += show ? 1 : 0;
  }
  $('#count').textContent = `${n} percors${n === 1 ? 'o' : 'i'}`;
  if (state.active && !visible(state.data.routes.find((r) => r.id === state.active))) setActive(null);
}

function renderRoutes() {
  const list = $('#routes');
  const sorted = [...state.data.routes].sort((a, b) => a.rank - b.rank);
  list.replaceChildren(...sorted.map(renderCard));
}

function renderCard(route) {
  const t = totals(route);
  const fit = FIT[route.fit] || FIT.unknown;
  const card = el('li', {
    class: 'route',
    id: `route-${route.id}`,
    style: `--area:${AREA_COLORS[route.area]};--fit:${fit.color}`,
    onmouseenter: () => highlight(route.id, true),
    onmouseleave: () => highlight(route.id, false),
  });
  const body = el('div', { class: 'route__body', id: `body-${route.id}`, hidden: '' });
  const head = el('button', {
    class: 'route__head',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': `body-${route.id}`,
    onclick: () => setActive(state.active === route.id ? null : route.id),
  },
    el('div', { class: 'route__kicker' },
      el('span', {}, state.data.areas[route.area]),
      el('span', {}, route.loop ? 'anello' : 'lineare'),
      el('span', {}, ACCESS[route.access] || route.access)
    ),
    el('h3', { class: 'route__name' }, route.name),
    el('div', { class: 'route__stats' },
      el('span', {}, el('b', {}, `${t.est ? '≈ ' : ''}${fmtKm(t.km)}`)),
      el('span', {}, el('b', {}, `${t.est ? '≈ ' : ''}${fmtM(t.dplus)}`), ' tot.'),
      el('span', {}, 'max/g ', el('b', {}, fmtM(t.maxDay))),
      el('span', { class: 'badge badge--fit' }, fit.label),
      el('span', { class: 'badge badge--rank' }, '★'.repeat(4 - route.rank))
    ),
    el('p', { class: 'route__pitch' }, route.pitch)
  );
  card.append(head, body);
  return card;
}

function renderBody(route) {
  const body = $(`#body-${route.id}`);
  if (body.dataset.rendered) return;
  body.dataset.rendered = '1';
  const track = state.tracks.get(route.id);
  const over = state.data.constraints.dplusMaxPerDay;
  const rows = route.days.map((d, i) => {
    const f = dayFigures(route, i);
    return el('tr', {},
      el('td', {}, el('span', { class: 'day-n' }, i + 1), d.label, d.note ? el('span', { class: 'note' }, d.note) : null),
      el('td', { class: `num ${f.kmEst ? 'est' : ''}` }, `${f.kmEst ? '≈ ' : ''}${fmtKm(f.km)}`),
      el('td', { class: `num ${f.dplusEst ? 'est' : ''} ${f.dplus > over ? 'over' : ''}` }, `${f.dplusEst ? '≈ ' : ''}${fmtM(f.dplus)}`)
    );
  });
  const t = totals(route);
  const gaps = (track?.days || []).reduce((n, d) => n + (d.gaps || 0), 0);
  body.append(...[
    el('table', { class: 'days' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Giorno'), el('th', {}, 'km'), el('th', {}, 'D+'))),
      el('tbody', {}, ...rows),
      el('tfoot', {}, el('tr', {}, el('td', {}, 'Totale'), el('td', { class: 'num' }, `${t.est ? '≈ ' : ''}${fmtKm(t.km)}`), el('td', { class: 'num' }, `${t.est ? '≈ ' : ''}${fmtM(t.dplus)}`)))
    ),
    el('h4', {}, 'Mezzi'),
    el('p', {}, route.transport),
    route.caveats ? el('h4', {}, 'Note') : null,
    route.caveats ? el('p', {}, route.caveats) : null,
    gaps ? el('p', { class: 'note' }, `Sulla mappa ${gaps} tratt${gaps === 1 ? 'o' : 'i'} in linea retta: BRouter non ha trovato un sentiero fra quei due punti.`) : null,
    el('div', { class: 'route__links' },
      ...route.sources.map((s) => el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.label + ' ↗')),
      track ? el('button', { type: 'button', onclick: () => downloadGpx(route, track) }, 'GPX indicativo ↓') : null
    )
  ].filter(Boolean));
}

function setActive(id) {
  if (state.active && state.active !== id) {
    const prev = $(`#route-${state.active}`);
    prev.classList.remove('is-active');
    $('.route__head', prev).setAttribute('aria-expanded', 'false');
    $(`#body-${state.active}`).hidden = true;
    highlight(state.active, false);
  }
  state.active = id;
  if (!id) return;
  const route = state.data.routes.find((r) => r.id === id);
  const card = $(`#route-${id}`);
  renderBody(route);
  card.classList.add('is-active');
  $('.route__head', card).setAttribute('aria-expanded', 'true');
  $(`#body-${id}`).hidden = false;
  highlight(id, true);
  const layer = state.layers.get(id);
  if (layer) state.map.fitBounds(layer.group.getBounds(), { padding: [30, 30] });
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  history.replaceState(null, '', `#${id}`);
}

function highlight(id, on) {
  const layer = state.layers.get(id);
  if (!layer) return;
  const strong = on || state.active === id;
  for (const line of layer.lines) {
    line.setStyle({ weight: strong ? 6 : 3.5, opacity: strong ? 1 : 0.75 });
    if (strong) line.bringToFront();
  }
}

function renderRejected() {
  $('#rejected-list').replaceChildren(
    ...state.data.rejected.map((r) => el('li', {}, el('b', {}, r.name), ` — ${r.why}`))
  );
}

// ---------------------------------------------------------------------- map

function initMap() {
  const map = L.map('map', { zoomControl: true, attributionControl: true });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  topo.addTo(map);
  L.control.layers({ 'Topografica': topo, 'OSM': osm }, null, { position: 'topright' }).addTo(map);
  map.setView([45.2, 10.2], 7);
  state.map = map;

  $('#legend').replaceChildren(
    ...Object.entries(state.data.areas).map(([k, label]) => el('span', { style: `--c:${AREA_HEX[k]}` }, label))
  );
}

function addRouteToMap(route, track) {
  const color = AREA_HEX[route.area];
  const group = L.featureGroup();
  const lines = [];
  track.days.forEach((day, i) => {
    const line = L.polyline(day.coords, {
      color, weight: 3.5, opacity: 0.75,
      dashArray: day.gaps ? '6 6' : null,
    });
    line.bindTooltip(`${route.name} — giorno ${i + 1}: ${day.from} → ${day.to}`, { sticky: true });
    line.on('click', () => setActive(route.id));
    line.addTo(group);
    lines.push(line);
    const isEnd = i === track.days.length - 1;
    L.marker(day.coords[0], {
      icon: L.divIcon({ className: '', html: `<div class="day-marker" style="--c:${color}">${i + 1}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
      title: `${route.name}: partenza giorno ${i + 1} — ${day.from}`,
    }).on('click', () => setActive(route.id)).addTo(group);
    if (isEnd) {
      L.marker(day.coords[day.coords.length - 1], {
        icon: L.divIcon({ className: '', html: `<div class="day-marker day-marker--end">■</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
        title: `${route.name}: arrivo — ${day.to}`,
      }).on('click', () => setActive(route.id)).addTo(group);
    }
  });
  group.addTo(state.map);
  state.layers.set(route.id, { group, lines });
}

// ---------------------------------------------------------------------- gpx

function downloadGpx(route, track) {
  const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const trks = track.days.map((d, i) =>
    `  <trk><name>${esc(`${route.name} — giorno ${i + 1}: ${d.from} → ${d.to}`)}</name><trkseg>\n` +
    d.coords.map(([lat, lon]) => `    <trkpt lat="${lat}" lon="${lon}"/>`).join('\n') +
    `\n  </trkseg></trk>`
  ).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="tools.ruffilli.it/sentieri" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${esc(route.name)}</name><desc>Traccia indicativa (BRouter fra i capi tappa), non il tracciato ufficiale.</desc></metadata>\n${trks}\n</gpx>\n`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `sentieri-${route.id}.gpx` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --------------------------------------------------------------------- boot

async function boot() {
  const data = await fetch('routes.json').then((r) => r.json());
  state.data = data;
  document.title = data.title;
  renderHeader();
  initMap();
  await Promise.all(
    data.routes.map(async (route) => {
      try {
        const track = await fetch(`tracks/${route.id}.json`).then((r) => (r.ok ? r.json() : null));
        if (track) state.tracks.set(route.id, track);
      } catch { /* a missing track only loses the line */ }
    })
  );
  renderFilters();
  renderRoutes();
  renderRejected();
  for (const route of data.routes) {
    const track = state.tracks.get(route.id);
    if (track) addRouteToMap(route, track);
  }
  applyFilters();
  const openFromHash = () => {
    const wanted = location.hash.slice(1);
    if (wanted && wanted !== state.active && data.routes.some((r) => r.id === wanted)) setActive(wanted);
  };
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  $('#count').textContent = 'Errore nel caricamento dei dati.';
});
