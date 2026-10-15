'use strict';

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

/* sequential blue ramp (reference palette steps 150→700); dark mode recedes low values into the surface */
const RAMP_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const RAMP_DARK = ['#104281', '#184f95', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];

/* ---------- formatting ---------- */
function fmtWon(v) {
  if (!isFinite(v)) return '–';
  if (v >= 1e12) return (v / 1e12).toFixed(v >= 1e13 ? 1 : 2) + '조원';
  if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e10 ? 0 : 1) + '억원';
  if (v >= 1e4) return Math.round(v / 1e4).toLocaleString() + '만원';
  return Math.round(v).toLocaleString() + '원';
}
function fmtCnt(v) {
  if (!isFinite(v)) return '–';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '억건';
  if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e6 ? 0 : 1) + '만건';
  return Math.round(v).toLocaleString() + '건';
}
const fmtAvg = (v) => (isFinite(v) && v > 0 ? Math.round(v).toLocaleString() + '원' : '–');
const FMT = { amt: fmtWon, cnt: fmtCnt, avg: fmtAvg };
const METRIC_NM = { amt: '매출금액', cnt: '매출건수', avg: '건당 평균금액' };
function fmtShort(metric, v) {
  if (metric === 'avg') return v >= 1e4 ? (v / 1e4).toFixed(1) + '만' : Math.round(v).toLocaleString();
  const u = metric === 'amt' ? [[1e12, '조'], [1e8, '억'], [1e4, '만']] : [[1e8, '억'], [1e4, '만']];
  for (const [d, n] of u) if (v >= d) { const x = v / d; return (x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(0) : x.toFixed(1)) + n; }
  return Math.round(v).toLocaleString();
}
const ymLabel = (ym) => `${ym.slice(0, 4)}.${ym.slice(4)}`;

/* ---------- state ---------- */
let B, TOPO;                // meta.json, boundaries (TopoJSON)
let FEATS = [];             // unit polygons as GeoJSON features (index = unit)
let Y;                      // number of years in the profile tables
const SER = {}, PROF = {};  // lazily fetched cube series / profiles, by category key
let TOPCAT = null;          // unit x year x 중분류 amounts
const pending = {};
let U, M, units, months;
let unitCity, unitSgg, sggList, cityAvail;
let ents = [];              // current entities
let unitEnt;                // unit -> entity index
let vals = [];              // per-entity values
let breaks = [];
let colors = {};
const S = { m0: 0, m1: 0, c1: 'ALL', c2: 'ALL', level: 'dong', city: 'ALL', metric: 'amt', focus: null, hover: null, rankAll: false };

let map, unitLayers = [], hlLayer, focusLayer, sggLineLayer, cityLineLayer, baseTiles, labelTiles;
let playTimer = null;

/* ---------- boot ---------- */
(async function boot() {
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
  // first paint needs only names + boundaries + the all-category cube (~150 KB gzipped)
  const allBin = getBin('data/cube/ALL.bin');
  [B, TOPO] = await Promise.all([get('data/meta.json'), get('data/geo.topo.json')]);
  months = B.months; M = months.length; units = B.units; U = units.length; Y = B.years.length;
  SER.ALL = decodeSeries('ALL', await allBin);
  FEATS = topojson.feature(TOPO, TOPO.objects.units).features;
  sggList = B.sggs;
  const sggByCode = Object.fromEntries(sggList.map((x, i) => [x.k, i]));
  unitSgg = units.map((u) => sggByCode[u.sgg]);
  unitCity = unitSgg.map((i) => sggList[i].city);
  cityAvail = Object.fromEntries(Object.entries(B.avail).map(([c, str]) => [c, Uint8Array.from(str, (ch) => +ch)]));
  S.m0 = M - 12; S.m1 = M - 1;

  initControls();
  initMap();
  buildEntities();
  render();
  $('#loading').hidden = true;
  fillNotes();
  // hover-card extras are small and only needed on hover: fetch them once the map is up
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
  idle(() => { loadProf('ALL').then(refreshTip); loadTopcat().then(refreshTip); });
})().catch((e) => { $('#loading').textContent = '데이터를 불러오지 못했습니다: ' + e.message; });

/* ---------- lazy binary data ----------
   uint16 log-quantized values stored as byte planes (all low bytes, then all high bytes): v = expm1(q / K) */
function getBin(p) {
  return fetch(p).then((r) => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
}
function u16(bytes, off, n) {
  const q = new Uint16Array(n);
  for (let i = 0; i < n; i++) q[i] = bytes[off + i] | (bytes[off + n + i] << 8);
  return q;
}
function delog(q, K, round) {
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] ? (round ? Math.round(Math.expm1(q[i] / K)) : Math.expm1(q[i] / K)) : 0;
  return out;
}
function decodeSeries(key, b) {
  const n = U * M, [Ka, Kc] = B.cubeK[key];
  return { a: delog(u16(b, 0, n), Ka), c: delog(u16(b, 2 * n, n), Kc, true) };
}
function once(key, f) {
  if (!pending[key]) pending[key] = f().catch((e) => { delete pending[key]; throw e; });
  return pending[key];
}
const loadSeries = (key) => SER[key] ? Promise.resolve(SER[key]) : once('c:' + key, () => getBin(`data/cube/${key}.bin`).then((b) => (SER[key] = decodeSeries(key, b))));
const loadProf = (key) => PROF[key] ? Promise.resolve(PROF[key]) : once('p:' + key, () => getBin(`data/prof/${key}.bin`).then((b) => {
  const n = U * Y;
  return (PROF[key] = { tot: delog(u16(b, 0, n), B.profK[key]), sh: b.subarray(2 * n) });
}));
const loadTopcat = () => TOPCAT ? Promise.resolve(TOPCAT) : once('topcat', () => getBin('data/topcat.bin').then((b) => (TOPCAT = delog(u16(b, 0, U * Y * B.cat2.length), B.topcatK))));
const refreshTip = () => { if (S.hover != null) showTip(S.hover); };
const seriesKey = () => (S.c2 !== 'ALL' ? S.c2 : S.c1);
const profKey = () => S.c1;

/* ---------- controls ---------- */
function initControls() {
  const m0 = $('#m0'), m1 = $('#m1');
  months.forEach((ym, i) => { m0.append(h('option', { value: i, text: ymLabel(ym) })); m1.append(h('option', { value: i, text: ymLabel(ym) })); });
  m0.onchange = () => { stopPlay(); S.m0 = +m0.value; if (S.m1 < S.m0) S.m1 = S.m0; render(); };
  m1.onchange = () => { stopPlay(); S.m1 = +m1.value; if (S.m0 > S.m1) S.m0 = S.m1; render(); };

  const yi = (y) => [months.indexOf(y + '01'), months.indexOf(y + '12')];
  const presets = [
    ['최근 1개월', () => [M - 1, M - 1]], ['최근 3개월', () => [M - 3, M - 1]], ['최근 12개월', () => [M - 12, M - 1]],
    ['2025년', () => yi('2025')], ['2024년', () => yi('2024')], ['전체', () => [0, M - 1]],
  ];
  for (const [nm, f] of presets) $('#presets').append(h('button', { type: 'button', text: nm, onclick: () => { stopPlay(); [S.m0, S.m1] = f(); render(); } }));
  $('#play').onclick = () => (playTimer ? stopPlay() : startPlay());

  const c1 = $('#c1');
  c1.append(h('option', { value: 'ALL', text: '전체 업종' }));
  for (const c of B.cat1) c1.append(h('option', { value: c.k, text: c.nm }));
  c1.onchange = () => { S.c1 = c1.value; S.c2 = 'ALL'; fillC2(); render(); };
  $('#c2').onchange = (e) => { S.c2 = e.target.value; render(); };
  fillC2();

  const city = $('#city');
  city.append(h('option', { value: 'ALL', text: '경기 19개 시군 전체' }));
  for (const c of B.cities) city.append(h('option', { value: c, text: c }));
  city.onchange = () => { S.city = city.value; S.focus = null; render(); fitScope(); };

  seg('#level', 'level', () => { S.focus = null; buildEntities(); render(); });
  seg('#metric', 'metric', render);

  $('#clearFocus').onclick = () => { S.focus = null; render(); };
  $('#rankAll').onclick = () => { S.rankAll = !S.rankAll; renderRank(); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { setTiles(); render(); });
}
function seg(sel, key, cb) {
  const root = $(sel);
  const sync = () => root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S[key])));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S[key] = b.dataset.v; sync(); cb();
  });
  sync();
}
function fillC2() {
  const c2 = $('#c2');
  c2.replaceChildren(h('option', { value: 'ALL', text: S.c1 === 'ALL' ? '중분류 (대분류 먼저 선택)' : '전체 중분류' }));
  c2.disabled = S.c1 === 'ALL';
  for (const c of B.cat2.filter((x) => x.p === S.c1)) c2.append(h('option', { value: c.k, text: c.nm }));
}
function startPlay() {
  $('#play').setAttribute('aria-pressed', 'true'); $('#play').textContent = '❚❚';
  let m = S.m0 === S.m1 ? S.m0 : S.m0;
  S.m0 = S.m1 = m; render();
  playTimer = setInterval(() => { m = m >= M - 1 ? 0 : m + 1; S.m0 = S.m1 = m; render(); }, 900);
}
function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer); playTimer = null;
  $('#play').setAttribute('aria-pressed', 'false'); $('#play').textContent = '▶';
}

/* ---------- map ---------- */
function initMap() {
  map = L.map('map', { zoomControl: true, preferCanvas: false, minZoom: 8, maxZoom: 15 });
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 650;
  map.getPane('labels').style.pointerEvents = 'none';
  setTiles();

  unitLayers = FEATS.map((f) => {
    const u = f.properties.i;
    const lyr = L.geoJSON(f, { style: { weight: 0.6, fillOpacity: 0.8 } }).getLayers()[0];
    lyr.on('mouseover', (e) => { setHover(unitEnt[u]); moveTip(e.originalEvent); });
    lyr.on('mousemove', (e) => moveTip(e.originalEvent));
    lyr.on('mouseout', () => setHover(null));
    lyr.on('click', () => { const ei = unitEnt[u]; S.focus = S.focus === ei ? null : ei; render(); });
    lyr.addTo(map);
    return lyr;
  });
  // district / city borders = arcs whose two sides differ (or the outer edge), straight from the topology
  const obj = TOPO.objects.units;
  const border = (key) => topojson.mesh(TOPO, obj, (a, b) => a === b || a.properties[key] !== b.properties[key]);
  sggLineLayer = L.geoJSON(border('s'), { interactive: false }).addTo(map);
  cityLineLayer = L.geoJSON(border('c'), { interactive: false }).addTo(map);
  focusLayer = L.layerGroup().addTo(map);
  hlLayer = L.layerGroup().addTo(map);
  fitScope();
}
function setTiles() {
  const mode = isDark() ? 'dark' : 'light';
  const attr = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · 경계: vuski/admdongkor';
  const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const tone = mode === 'dark' ? 'Dark' : 'Light';
  if (baseTiles) { baseTiles.remove(); labelTiles.remove(); }
  baseTiles = L.tileLayer(esri(`World_${tone}_Gray_Base`), { attribution: attr, maxNativeZoom: 16 }).addTo(map);
  labelTiles = L.tileLayer(esri(`World_${tone}_Gray_Reference`), { pane: 'labels', maxNativeZoom: 16 }).addTo(map);
}
function fitScope() {
  let b = null;
  unitLayers.forEach((l, u) => { if (S.city === 'ALL' || unitCity[u] === S.city) b = b ? b.extend(l.getBounds()) : L.latLngBounds(l.getBounds().getSouthWest(), l.getBounds().getNorthEast()); });
  if (b) { map.invalidateSize(); map.fitBounds(b, { padding: [20, 20], animate: false }); }
}
function entBounds(ei) {
  let b = null;
  for (const u of ents[ei].units) { const lb = unitLayers[u].getBounds(); b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast()); }
  return b;
}

/* ---------- entities & values ---------- */
function buildEntities() {
  if (S.level === 'dong') {
    ents = units.map((u, i) => ({ name: u.nm, sub: sggList[unitSgg[i]].nm, city: unitCity[i], units: [i], sgg: unitSgg[i] }));
    unitEnt = units.map((_, i) => i);
  } else {
    ents = sggList.map((x, i) => ({ name: x.nm, sub: x.city, city: x.city, units: [], sgg: i }));
    unitEnt = unitSgg.slice();
    unitSgg.forEach((si, u) => ents[si].units.push(u));
  }
}
const currentSeries = () => SER[seriesKey()];
const inScope = (e) => S.city === 'ALL' || e.city === S.city;
function sumUnits(ser, us, m0, m1, cities) {
  let a = 0, c = 0, avail = 0;
  for (const u of us) for (let m = m0; m <= m1; m++) { a += ser.a[u * M + m]; c += ser.c[u * M + m]; }
  if (cities) for (let m = m0; m <= m1; m++) if (cities.some((ct) => cityAvail[ct][m])) avail++;
  return { amt: a, cnt: c, avg: c ? a / c : 0, avail };
}
function computeValues() {
  const ser = currentSeries();
  vals = ents.map((e) => {
    const v = sumUnits(ser, e.units, S.m0, S.m1, [e.city]);
    v.val = v[S.metric];
    v.ok = v.avail > 0;
    return v;
  });
  // rank among in-scope entities with data
  const order = ents.map((_, i) => i).filter((i) => inScope(ents[i]) && vals[i].ok).sort((a, b) => vals[b].val - vals[a].val);
  order.forEach((ei, r) => (vals[ei].rank = r + 1));
  vals.order = order;
  // quantile breaks (7 classes)
  const xs = order.map((i) => vals[i].val).filter((v) => v > 0).sort((a, b) => a - b);
  // fewer areas than classes (e.g. 4 시군구) -> fewer, de-duplicated classes
  const nCls = Math.max(1, Math.min(7, xs.length));
  const bs = [];
  for (let k = 1; k < nCls; k++) {
    const b = xs[Math.min(xs.length - 1, Math.floor((k * xs.length) / nCls))];
    if (b > (bs.length ? bs[bs.length - 1] : xs[0])) bs.push(b);
  }
  breaks = bs;
}
function activeRamp() {
  const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT, n = breaks.length + 1;
  if (n >= ramp.length) return ramp;
  return Array.from({ length: n }, (_, i) => ramp[n === 1 ? ramp.length - 1 : Math.round(1 + (i * (ramp.length - 2)) / (n - 1))]);
}
function colorFor(v) {
  let k = 0;
  while (k < breaks.length && v >= breaks[k]) k++;
  return activeRamp()[k];
}

/* ---------- render ---------- */
function render() {
  $('#m0').value = S.m0; $('#m1').value = S.m1;
  colors = { surface: cssVar('--surface'), ink: cssVar('--ink'), ink2: cssVar('--ink-2'), nodata: cssVar('--nodata'), dim: cssVar('--dim'), accent: cssVar('--accent') };
  if (!currentSeries()) {
    // keep the previous frame (dimmed) while the selected category's cube downloads
    setBusy(true);
    const key = seriesKey();
    loadSeries(key).then(() => { if (seriesKey() === key) { setBusy(false); render(); } },
      () => { setBusy(false); $('#legend').prepend(h('div', { class: 'lg-sub', text: '데이터를 불러오지 못했습니다. 다시 선택해 주세요.' })); });
    return;
  }
  setBusy(false);
  if (!PROF[profKey()]) loadProf(profKey()).then(refreshTip);
  computeValues();
  styleMap();
  renderLegend();
  renderPanel();
  if (S.hover != null) showTip(S.hover);
}
function setBusy(on) { document.querySelector('.map-wrap').classList.toggle('busy', on); }
function styleMap() {
  const dong = S.level === 'dong';
  unitLayers.forEach((lyr, u) => {
    const ei = unitEnt[u], e = ents[ei], v = vals[ei];
    let st;
    if (!inScope(e)) st = { fillColor: colors.dim, fillOpacity: 0.35, color: colors.surface, weight: dong ? 0.4 : 0 };
    else if (!v.ok || v.val <= 0) st = { fillColor: colors.nodata, fillOpacity: 0.75, color: colors.surface, weight: dong ? 0.6 : 0 };
    else st = { fillColor: colorFor(v.val), fillOpacity: 0.82, color: colors.surface, weight: dong ? 0.6 : 0 };
    lyr.setStyle(st);
  });
  sggLineLayer.setStyle({ color: colors.ink2, weight: dong ? 0.9 : 1, opacity: 0.6 });
  cityLineLayer.setStyle({ color: colors.ink, weight: 1.5, opacity: 0.75 });
  focusLayer.clearLayers();
  if (S.focus != null) outlineEnt(S.focus, focusLayer, { color: colors.accent, weight: 3.5, dashArray: null });
}
function outlineEnt(ei, group, style) {
  const e = ents[ei];
  if (S.level === 'sgg') {
    group.addLayer(L.geoJSON(sggShape(ei), { interactive: false, style: { ...style, fill: false } }));
  } else {
    for (const u of e.units) group.addLayer(L.geoJSON(FEATS[u], { interactive: false, style: { ...style, fill: false } }));
  }
}
const sggShapes = {};
function sggShape(si) {
  if (!sggShapes[si]) sggShapes[si] = topojson.merge(TOPO, TOPO.objects.units.geometries.filter((g) => g.properties.s === si));
  return sggShapes[si];
}
function setHover(ei) {
  S.hover = ei;
  hlLayer.clearLayers();
  if (ei == null) { $('#tip').hidden = true; document.querySelectorAll('.rank li.on').forEach((li) => li.classList.remove('on')); return; }
  outlineEnt(ei, hlLayer, { color: colors.ink, weight: 2.5 });
  showTip(ei);
}

function rangeLabel() {
  const n = S.m1 - S.m0 + 1;
  return S.m0 === S.m1 ? ymLabel(months[S.m0]) : `${ymLabel(months[S.m0])}–${ymLabel(months[S.m1])} (${n}개월)`;
}
function catLabel() {
  if (S.c1 === 'ALL') return '전체 업종';
  const c1 = B.cat1.find((x) => x.k === S.c1).nm;
  if (S.c2 === 'ALL') return c1;
  return `${c1} › ${B.cat2.find((x) => x.k === S.c2).nm}`;
}

function renderLegend() {
  const lg = $('#legend');
  const ramp = activeRamp();
  lg.replaceChildren(
    h('div', { class: 'lg-title', text: `${METRIC_NM[S.metric]} · ${catLabel()}` }),
    h('div', { class: 'lg-sub', text: `${rangeLabel()} · ${S.level === 'dong' ? '행정동' : '시군구'} 분위 ${ramp.length}단계` }),
    h('div', { class: 'ramp' }, ramp.map((c) => h('span', { style: `background:${c}` }))),
    h('div', { class: 'ticks' }, [h('span', { text: '' }), ...breaks.map((b) => h('span', { text: fmtShort(S.metric, b) }))]),
    h('div', { class: 'nd' }, h('i'), '데이터 없음 (해당 기간 미제공)'),
  );
}

/* ---------- side panel ---------- */
function scopeUnits() {
  if (S.focus != null) return ents[S.focus].units;
  return units.map((_, i) => i).filter((u) => S.city === 'ALL' || unitCity[u] === S.city);
}
function scopeCities(us) { return [...new Set(us.map((u) => unitCity[u]))]; }

function renderPanel() {
  const focus = S.focus != null;
  $('#clearFocus').hidden = !focus;
  $('#focusEyebrow').textContent = focus ? `선택 지역 · ${ents[S.focus].sub}` : '선택 영역';
  $('#focusTitle').textContent = focus ? ents[S.focus].name : S.city === 'ALL' ? '경기 19개 시군' : S.city;

  const us = scopeUnits(), cities = scopeCities(us);
  const ser = currentSeries();
  const v = sumUnits(ser, us, S.m0, S.m1, cities);
  const covered = cities.filter((c) => { for (let m = S.m0; m <= S.m1; m++) if (cityAvail[c][m]) return true; return false; });
  const kp = $('#kpis');
  kp.replaceChildren(
    kpi(fmtWon(v.amt), '매출금액'), kpi(fmtCnt(v.cnt), '매출건수'), kpi(fmtAvg(v.avg), '건당 평균'),
    h('div', { class: 'coverage', text: `${catLabel()} · ${rangeLabel()}${cities.length > 1 ? ` · 데이터 제공 시군 ${covered.length}/${cities.length}` : ''}` }),
  );
  if (!trendLock) renderTrend(us, cities);
  renderRank();
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'v', text: v }), h('div', { class: 'l', text: l }));

function monthlySeries(us, cities) {
  const ser = currentSeries();
  const out = new Array(M);
  for (let m = 0; m < M; m++) {
    if (!cities.some((c) => cityAvail[c][m])) { out[m] = null; continue; }
    let a = 0, c = 0;
    for (const u of us) { a += ser.a[u * M + m]; c += ser.c[u * M + m]; }
    out[m] = S.metric === 'amt' ? a : S.metric === 'cnt' ? c : c ? a / c : null;
  }
  return out;
}

let drag = null, trendLock = false;
function renderTrend(us, cities) {
  const box = $('#trend');
  const W = box.clientWidth || 348, H = 150, pl = 40, pr = 6, pt = 8, pb = 20;
  const ys = monthlySeries(us, cities);
  const max = Math.max(1, ...ys.filter((x) => x != null));
  const x = (m) => pl + ((W - pl - pr) * m) / (M - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': '월별 추이' });
  // selected range shade
  const shade = s('rect', { y: pt, height: H - pt - pb, fill: cssVar('--shade'), rx: 3 });
  const placeShade = () => { shade.setAttribute('x', x(S.m0) - 3); shade.setAttribute('width', Math.max(6, x(S.m1) - x(S.m0) + 6)); };
  placeShade();
  svg.append(shade);
  // drag-select keeps this chart's DOM (and pointer capture) alive while the rest re-renders
  const setRange = (a, b) => { S.m0 = a; S.m1 = b; placeShade(); trendLock = true; try { render(); } finally { trendLock = false; } };
  for (const t of [0, 0.5, 1]) {
    svg.append(s('line', { class: 'grid-l', x1: pl, x2: W - pr, y1: y(max * t), y2: y(max * t) }));
    svg.append(s('text', { x: pl - 6, y: y(max * t) + 3, 'text-anchor': 'end' }, fmtShort(S.metric, max * t)));
  }
  svg.append(s('line', { class: 'axis-l', x1: pl, x2: W - pr, y1: H - pb, y2: H - pb }));
  months.forEach((ym, m) => { if (ym.endsWith('01')) svg.append(s('text', { x: x(m), y: H - 6, 'text-anchor': 'middle' }, `'${ym.slice(2, 4)}`)); });
  // months where only part of the scope's cities reported: the total dips for coverage, not spending
  const partial = months.map((_, m) => { const n = cities.filter((c) => cityAvail[c][m]).length; return n > 0 && n < cities.length; });
  partial.forEach((p, m) => { if (p) svg.append(s('rect', { x: x(m) - 1.5, y: H - pb + 2, width: 3, height: 3, rx: 1, fill: colors.ink2, opacity: 0.7 })); });
  // line with gaps for missing months
  let d = '';
  ys.forEach((v, m) => { if (v == null) return; d += (m > 0 && ys[m - 1] != null ? 'L' : 'M') + x(m).toFixed(1) + ',' + y(v).toFixed(1); });
  svg.append(s('path', { d, fill: 'none', stroke: colors.accent, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  ys.forEach((v, m) => { if (v != null && (m === 0 || ys[m - 1] == null) && (m === M - 1 || ys[m + 1] == null)) svg.append(s('circle', { cx: x(m), cy: y(v), r: 2.5, fill: colors.accent })); });
  const cross = s('line', { x1: 0, x2: 0, y1: pt, y2: H - pb, stroke: colors.ink2, 'stroke-width': 1, visibility: 'hidden' });
  const dot = s('circle', { r: 4, fill: colors.accent, stroke: colors.surface, 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = s('rect', { x: pl, y: 0, width: W - pl - pr, height: H, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(hit);
  const readout = h('div', { class: 'readout', hidden: '' });
  const cap = partial.some(Boolean) ? h('div', { class: 'hint', style: 'margin-top:2px', text: '▪ 표시 월은 일부 시군 데이터 미제공 (합계가 낮게 보임)' }) : null;
  box.replaceChildren(svg, readout, ...(cap ? [cap] : []));

  const mAt = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(M - 1, Math.round(((px - pl) / (W - pl - pr)) * (M - 1))));
  };
  hit.addEventListener('pointermove', (ev) => {
    const m = mAt(ev);
    if (drag != null) {
      const a = Math.min(drag, m), b = Math.max(drag, m);
      if (a !== S.m0 || b !== S.m1) setRange(a, b);
      return;
    }
    cross.setAttribute('x1', x(m)); cross.setAttribute('x2', x(m)); cross.setAttribute('visibility', 'visible');
    const v = ys[m];
    if (v != null) { dot.setAttribute('cx', x(m)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible'); } else dot.setAttribute('visibility', 'hidden');
    readout.replaceChildren(h('b', { text: v == null ? '데이터 없음' : FMT[S.metric](v) }), ymLabel(months[m]) + (partial[m] ? ` · 시군 ${cities.filter((c) => cityAvail[c][m]).length}/${cities.length}` : ''));
    readout.hidden = false;
    const left = (x(m) / W) * box.clientWidth;
    readout.style.left = Math.min(box.clientWidth - readout.offsetWidth, Math.max(0, left - readout.offsetWidth / 2)) + 'px';
    readout.style.top = '-6px';
  });
  hit.addEventListener('pointerleave', () => { if (drag == null) { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); readout.hidden = true; } });
  hit.addEventListener('pointerdown', (ev) => { stopPlay(); drag = mAt(ev); hit.setPointerCapture(ev.pointerId); setRange(drag, drag); });
  hit.addEventListener('pointerup', () => { drag = null; render(); });
}

function renderRank() {
  const ol = $('#rank');
  const order = vals.order || [];
  const list = S.rankAll ? order : order.slice(0, 10);
  $('#rankTitle').textContent = `${S.level === 'dong' ? '행정동' : '시군구'} 순위 · ${METRIC_NM[S.metric]} (${order.length}곳)`;
  $('#rankAll').textContent = S.rankAll ? '상위 10개만' : '전체 보기';
  const max = order.length ? vals[order[0]].val : 1;
  ol.replaceChildren(...list.map((ei) => {
    const e = ents[ei], v = vals[ei];
    const li = h('li', { tabindex: 0 },
      h('span', { class: 'n', text: v.rank }),
      h('span', { class: 'nm' }, e.name, h('small', { text: S.level === 'dong' ? e.sub : '' })),
      h('span', { class: 'val', text: FMT[S.metric](v.val) }),
      h('span', { class: 'bar' }, h('i', { style: `width:${(100 * v.val / max).toFixed(1)}%` })),
    );
    li.addEventListener('mouseenter', () => { hlLayer.clearLayers(); outlineEnt(ei, hlLayer, { color: colors.ink, weight: 2.5 }); li.classList.add('on'); });
    li.addEventListener('mouseleave', () => { hlLayer.clearLayers(); li.classList.remove('on'); });
    li.addEventListener('click', () => { S.focus = ei; render(); map.fitBounds(entBounds(ei), { padding: [60, 60], maxZoom: 13, animate: false }); });
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') li.click(); });
    return li;
  }));
}

/* ---------- hover card ---------- */
let lastMouse = { x: 0, y: 0 };
function moveTip(ev) {
  if (ev) lastMouse = { x: ev.clientX, y: ev.clientY };
  const tip = $('#tip');
  if (tip.hidden) return;
  const pad = 16, w = tip.offsetWidth, hgt = tip.offsetHeight;
  let x = lastMouse.x + pad, y = lastMouse.y + pad;
  if (x + w > innerWidth - 8) x = lastMouse.x - w - pad;
  if (y + hgt > innerHeight - 8) y = Math.max(8, innerHeight - hgt - 8);
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = y + 'px';
}

const HOUR_LB = ['0–6', '7–8', '9–10', '11–12', '13–14', '15–16', '17–18', '19–20', '21–22', '23'];
const DAY_LB = ['월', '화', '수', '목', '금', '토', '일'];
const AGE_BINS = [[[1, 2], '~10대'], [[3], '20대'], [[4], '30대'], [[5], '40대'], [[6], '50대'], [[7], '60대'], [[8], '70대'], [[9, 10, 11], '80대+']];

const yearSpan = () => [B.years.indexOf(months[S.m0].slice(0, 4)), B.years.indexOf(months[S.m1].slice(0, 4))];
function yearLabel() { const [y0, y1] = yearSpan(); return y0 === y1 ? `${B.years[y0]}년` : `${B.years[y0]}–${B.years[y1]}년`; }
function profileFor(us) {
  const P = PROF[profKey()];
  if (!P) return null;
  const D = 39, [y0, y1] = yearSpan();
  const acc = new Float64Array(D);
  let w = 0;
  for (const u of us) for (let y = y0; y <= y1; y++) {
    const i = u * Y + y, t = P.tot[i];
    if (!t) continue;
    w += t;
    for (let d = 0; d < D; d++) acc[d] += (t * P.sh[i * D + d]) / 255;
  }
  const yl = yearLabel();
  return { acc, w, label: `${yl} · ${S.c1 === 'ALL' ? '전체 업종' : B.cat1.find((x) => x.k === S.c1).nm} 기준` };
}

function topCats(us) {
  if (!TOPCAT) return null;
  const C = B.cat2.length, [y0, y1] = yearSpan();
  const rows = [];
  let total = 0;
  B.cat2.forEach((c, j) => {
    if (S.c1 !== 'ALL' && c.p !== S.c1) return;
    let a = 0;
    for (const u of us) for (let y = y0; y <= y1; y++) a += TOPCAT[(u * Y + y) * C + j];
    total += a;
    if (a > 0) rows.push([c, a]);
  });
  rows.sort((p, q) => q[1] - p[1]);
  return rows.slice(0, 5).map(([c, a]) => ({ nm: c.nm, p: total ? a / total : 0, on: c.k === S.c2 }));
}

function sparkline(ys, W = 300, H = 46) {
  const max = Math.max(1, ...ys.filter((v) => v != null));
  const x = (m) => 2 + ((W - 4) * m) / (M - 1), y = (v) => 3 + (H - 6) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  svg.append(s('rect', { x: x(S.m0) - 2, y: 0, width: Math.max(4, x(S.m1) - x(S.m0) + 4), height: H, fill: cssVar('--shade'), rx: 2 }));
  svg.append(s('line', { class: 'axis-l', x1: 0, x2: W, y1: H - 1, y2: H - 1 }));
  let d = '';
  ys.forEach((v, m) => { if (v == null) return; d += (m > 0 && ys[m - 1] != null ? 'L' : 'M') + x(m).toFixed(1) + ',' + y(v).toFixed(1); });
  svg.append(s('path', { d, fill: 'none', stroke: colors.accent, 'stroke-width': 1.75, 'stroke-linejoin': 'round' }));
  const last = S.m1; if (ys[last] != null) svg.append(s('circle', { cx: x(last), cy: y(ys[last]), r: 3, fill: colors.accent, stroke: colors.surface, 'stroke-width': 1.5 }));
  return svg;
}
function bars(values, labels, W = 145, H = 64, every = 1) {
  const max = Math.max(1e-9, ...values);
  const n = values.length, gap = 2, bw = (W - gap * (n - 1)) / n, top = 2, bot = 12;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  values.forEach((v, i) => {
    const bh = ((H - top - bot) * v) / max, x0 = i * (bw + gap);
    svg.append(s('rect', { x: x0, y: H - bot - bh, width: bw, height: Math.max(0.5, bh), rx: Math.min(2, bw / 2), fill: colors.accent }));
    if (i % every === 0) svg.append(s('text', { x: x0 + bw / 2, y: H - 2, 'text-anchor': 'middle', style: 'font-size:9px' }, labels[i]));
  });
  return svg;
}
function pyramid(m, f, labels, W = 145, H = 104) {
  const max = Math.max(1e-9, ...m, ...f), mid = W / 2, lw = 30, rowH = (H - 2) / labels.length;
  const half = mid - lw / 2 - 2;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  labels.forEach((lb, i) => {
    const yy = 1 + i * rowH, bh = rowH - 2;
    const wm = (half * m[i]) / max, wf = (half * f[i]) / max;
    svg.append(s('rect', { x: mid - lw / 2 - wm, y: yy, width: Math.max(0.5, wm), height: bh, rx: 2, fill: cssVar('--male') }));
    svg.append(s('rect', { x: mid + lw / 2, y: yy, width: Math.max(0.5, wf), height: bh, rx: 2, fill: cssVar('--female') }));
    svg.append(s('text', { x: mid, y: yy + bh - 2, 'text-anchor': 'middle', style: 'font-size:9px' }, lb));
  });
  return svg;
}

function showTip(ei) {
  const tip = $('#tip');
  const e = ents[ei], v = vals[ei];
  if (!e || !v) return;
  const nRange = S.m1 - S.m0 + 1;
  const kids = [
    h('div', { class: 't-name', text: e.name }),
    h('div', { class: 't-sub', text: `${S.level === 'dong' ? e.sub : e.city} · ${catLabel()} · ${rangeLabel()}` }),
  ];
  if (!inScope(e)) kids.push(h('div', { class: 't-warn', text: `현재 '${S.city}' 필터 밖의 지역입니다.` }));
  if (!v.ok) {
    kids.push(h('div', { class: 't-warn', text: '선택 기간에 이 시군의 데이터가 제공되지 않았습니다.' }));
    tip.replaceChildren(...kids); tip.hidden = false; moveTip(); return;
  }
  const scopeN = vals.order.length;
  const cityUnits = units.map((_, u) => u).filter((u) => unitCity[u] === e.city);
  const cityV = sumUnits(currentSeries(), cityUnits, S.m0, S.m1);
  const share = S.metric !== 'avg' && cityV[S.metric] ? v[S.metric] / cityV[S.metric] : null;
  kids.push(
    h('div', { class: 't-main' }, h('b', { text: FMT[S.metric](v.val) }), h('span', { text: METRIC_NM[S.metric] + (v.rank ? ` · ${v.rank}위 / ${scopeN}` : '') })),
    h('div', { class: 't-stats' },
      h('div', {}, h('b', { text: fmtWon(v.amt) }), '매출금액'),
      h('div', {}, h('b', { text: fmtCnt(v.cnt) }), '매출건수'),
      h('div', {}, h('b', { text: share != null && S.level === 'dong' ? (share * 100).toFixed(1) + '%' : fmtAvg(v.avg) }), share != null && S.level === 'dong' ? `${e.city} 내 비중` : '건당 평균'),
    ),
  );
  if (v.avail < nRange) kids.push(h('div', { class: 't-warn', text: `선택 기간 ${nRange}개월 중 ${nRange - v.avail}개월은 데이터 미제공 (제공된 월만 합산)` }));

  kids.push(h('h4', {}, `월별 ${METRIC_NM[S.metric]}`, h('small', { text: `${ymLabel(months[0])}–${ymLabel(months[M - 1])}` })), sparkline(monthlySeries(e.units, [e.city])));

  const tc = topCats(e.units);
  kids.push(h('h4', {}, S.c1 === 'ALL' ? '상위 업종 (중분류)' : `${B.cat1.find((x) => x.k === S.c1).nm} 내 상위 중분류`, h('small', { text: `${yearLabel()} 매출금액 비중` })));
  if (!tc) kids.push(h('div', { class: 't-sub', text: '업종 데이터를 불러오는 중…' }));
  else for (const r of tc) kids.push(h('div', { class: 'topcat', style: r.on ? 'font-weight:600' : null },
    h('span', { class: 'nm', text: r.nm }), h('span', { class: 'bar' }, h('i', { style: `width:${(r.p * 100).toFixed(1)}%` })), h('span', { class: 'p', text: (r.p * 100).toFixed(1) + '%' })));

  const pf = profileFor(e.units);
  if (!pf) kids.push(h('h4', {}, '고객 · 시간 분포'), h('div', { class: 't-sub', text: '분포 데이터를 불러오는 중…' }));
  else if (pf.w > 0) {
    const a = pf.acc;
    const ageM = AGE_BINS.map(([codes]) => codes.reduce((t, c) => t + a[10 + c - 1], 0));
    const ageF = AGE_BINS.map(([codes]) => codes.reduce((t, c) => t + a[21 + c - 1], 0));
    const sum = (arr) => arr.reduce((p, q) => p + q, 0);
    const mShare = sum(ageM) / (sum(ageM) + sum(ageF) || 1);
    kids.push(
      h('h4', {}, '고객 · 시간 분포', h('small', { text: pf.label })),
      h('div', { class: 'cols' },
        h('div', {},
          h('div', { class: 't-sub', style: 'margin:0', text: '성별·연령' }),
          h('div', { class: 't-sub', style: 'margin:0 0 2px' },
            h('span', { class: 'key', style: 'margin-left:0' }, h('i', { style: `background:${cssVar('--male')}` }), `남 ${(mShare * 100).toFixed(0)}%`),
            h('span', { class: 'key' }, h('i', { style: `background:${cssVar('--female')}` }), `여 ${((1 - mShare) * 100).toFixed(0)}%`)),
          pyramid(ageM, ageF, AGE_BINS.map((b) => b[1]))),
        h('div', {},
          h('div', { class: 't-sub', style: 'margin:0 0 2px', text: '시간대 (시)' }),
          bars(Array.from(a.slice(0, 10)), HOUR_LB, 145, 46, 3),
          h('div', { class: 't-sub', style: 'margin:4px 0 2px', text: '요일' }),
          bars(Array.from(a.slice(32, 39)), DAY_LB, 145, 40, 1)),
      ),
    );
  }
  tip.replaceChildren(...kids);
  tip.hidden = false;
  moveTip();
}

/* ---------- notes ---------- */
function fillNotes() {
  const n = [
    '출처: 경기데이터드림 「카드 소비 데이터」 (KB국민·비씨·롯데·삼성·하나카드, 공공누리 제2유형: 출처표시·상업적 이용금지). 원본 717개 CSV, 8억 2,596만 행을 행정동×월×업종으로 집계했습니다. 웹용 수치는 용량을 줄이기 위해 0.03% 이내로 근사한 값입니다.',
    '시군별 제공 기간이 다릅니다: 부천시는 2024.12까지, 과천·이천시는 2025년만, 성남·김포·남양주·여주·연천·의정부·파주는 2023.01부터(일부 월 누락). 미제공 월은 회색으로 표시하고 합계에서 빠집니다.',
    '매출은 가맹점 소재지 기준입니다. 성남시 분당구 판교·정자 일대처럼 온라인 플랫폼 본사가 있는 동은 인터넷쇼핑·전문서비스 매출이 매우 크게 잡힙니다. 지도 색은 분위(7단계)라 이상치의 영향을 덜 받습니다.',
    '경계는 2026.04 행정동 기준(vuski/admdongkor). 화성시 구 신설(2026) 이전 코드는 동 이름으로 연결했고, 안양 박달1·2동→박달동·호현동, 용인 유림동→유림1·2동은 한 구역으로 합쳐 표시합니다. 용인 양지면→양지읍.',
    '성별·연령·시간대·요일 분포는 선택 기간이 걸친 연도의 대분류 단위 매출금액 비중입니다(중분류 선택 시에도 대분류 기준). 시간대 코드 구간(1=0–6시 … 10=23시)과 연령 코드(10세 단위)는 원본 분포로 추정한 해석입니다.',
  ];
  $('#notes').replaceChildren(...n.map((t) => h('li', { text: t })));
}
