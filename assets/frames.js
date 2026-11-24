// Full-page image viewer: a segment's images (assets/viewer.js), the positions of one transect over time
// (click to open an image), and the segment on the map.
import { ImageArchive, ImageViewer } from "./viewer.js";
import { countryName, initialLanguage, loadText, locale } from "./languages.js";

const params = new URLSearchParams(location.search);
const FRAMES = new URL(params.get("frames") || "frames/", document.baseURI).href;
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const $ = (id) => document.getElementById(id);

const lang = params.get("lang") || initialLanguage();
const text = await loadText("map", lang);
const fmt = (value, digits = 1, sign = false) => value == null || Number.isNaN(value) ? "–" :
  new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits, minimumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto" }).format(value);

const archive = new ImageArchive(`${FRAMES}index.json`);
const map = new maplibregl.Map({ container: "map", style: BASEMAP, center: [0, 48], zoom: 4, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
const mapReady = new Promise((resolve) => map.on("load", resolve));
const years = await fetch("data/manifest.json").then((r) => (r.ok ? r.json() : null)).then((m) => m?.years)
  .catch(() => null);                                 // the year range of the "every year" colours
const viewer = new ImageViewer($("viewer"), { text: text.viewer, fmt, map, beforeLayer: "segments-fill", onChange: drawChart,
  years: years || undefined });
let firstTransect = params.get("transect");

// ------------------------------------------------------------------ the chart of one transect
function drawChart() {
  const svg = $("chart"), m = viewer.meta;
  if (!m) { svg.replaceChildren(); return; }
  const tr = m.transects[viewer.transect];
  $("chart-title").textContent = `Positions of transect ${tr.id}`;
  const W = svg.clientWidth || 600, H = svg.clientHeight || 220, L = 64, R = 10, T = 10, B = 24;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const pts = viewer.imagesOf(tr.id);
  const yearly = m.yearly[tr.id];
  const yl = yearly ? yearly.year.map((y, k) => [y + 0.5, yearly.x[k] / 10]).filter(([, x]) => Number.isFinite(x)) : [];
  const xs = pts.map((p) => p.x).concat(yl.map((p) => p[1]));
  if (!xs.length) { svg.replaceChildren(); return; }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = xs.map((x) => x - mean).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.ceil(sorted.length * 0.99) - 1];
  const pad = Math.max(10, (hi - lo) * 0.1);
  const y0 = lo - pad, y1 = hi + pad, t0 = Math.floor(viewer.when[0]), t1 = Math.ceil(viewer.when.at(-1));
  const sx = (v) => L + (v - t0) / (t1 - t0 || 1) * (W - L - R);
  const sy = (v) => T + (1 - (v - mean - y0) / (y1 - y0)) * (H - T - B);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, label) => {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (label) e.textContent = label;
    return e;
  };
  const out = [];
  niceTicks(y0, y1, 5).forEach((v) => {
    out.push(el("line", { x1: L, x2: W - R, y1: sy(v + mean), y2: sy(v + mean), class: "grid" }));
    out.push(el("text", { x: L - 6, y: sy(v + mean) + 4, "text-anchor": "end" }, `${v > 0 ? "+" : ""}${v} m`));
  });
  for (let y = Math.ceil(t0 / 5) * 5; y <= t1; y += 5) out.push(el("text", { x: sx(y), y: H - 6, "text-anchor": "middle" }, String(y)));
  pts.forEach((p) => out.push(el("circle", { cx: sx(p.when), cy: sy(Math.max(Math.min(p.x, y1 + mean), y0 + mean)), r: 1.8,
    class: p.flag === 1 ? "dot out" : "dot" })));
  if (yl.length > 1) out.push(el("polyline", { points: yl.map(([t, x]) => `${sx(t).toFixed(1)},${sy(x).toFixed(1)}`).join(" "), class: "yearly" }));
  const cx = sx(viewer.currentWhen);
  out.push(el("line", { x1: cx, x2: cx, y1: T, y2: H - B, class: "cursor" }));
  svg.replaceChildren(...out);
  svg.onclick = (event) => {
    const box = svg.getBoundingClientRect();
    const when = t0 + ((event.clientX - box.left) * (W / box.width) - L) / (W - L - R) * (t1 - t0);
    let best = 0, gap = Infinity;
    viewer.when.forEach((t, f) => { const g = Math.abs(t - when); if (g < gap) { gap = g; best = f; } });
    viewer.stop();
    viewer.show(best);
  };
}
function niceTicks(lo, hi, count) {
  const step0 = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v));
  return out;
}

// ------------------------------------------------------------------ the segments on the map
async function showSegments(segments) {
  await mapReady;
  const features = segments.map((s) => ({ type: "Feature", properties: { name: s.name },
    geometry: { type: "Polygon", coordinates: [[...s.corners, s.corners[0]]] } }));
  if (map.getSource("segments")) { map.getSource("segments").setData({ type: "FeatureCollection", features }); return; }
  map.addSource("segments", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({ id: "segments", type: "line", source: "segments", paint: { "line-color": "#0b5d7a", "line-width": 1.5, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "segments-fill", type: "fill", source: "segments", paint: { "fill-color": "#0b5d7a", "fill-opacity": 0.06 } });
  map.on("click", "segments-fill", (e) => choose(areaOf(e.features[0].properties.name), e.features[0].properties.name));
  map.on("mouseenter", "segments-fill", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "segments-fill", () => { map.getCanvas().style.cursor = ""; });
}

// ------------------------------------------------------------------ choosing a segment
const areaOf = (segment) => segment.replace(/-\d+$/, "");      // "<unit>-<k>": the unit
async function choose(area, name) {
  const segments = await archive.segmentsOf(area);
  const seg = segments.find((s) => s.name === name) || segments[0];
  if (!seg) return;
  $("area").value = area;
  $("segment").innerHTML = segments.map((s) => `<option value="${s.name}">${s.name.slice(area.length + 1)} · ${s.frames} images</option>`).join("");
  $("segment").value = seg.name;
  try {
    await showSegments(segments);
    await viewer.open(archive, seg, firstTransect);
  } catch (error) {
    return;
  }
  firstTransect = null;
  if (!viewer.meta) return;
  map.fitBounds(viewer.bounds, { padding: 40, duration: 0 });
  const m = viewer.meta, mb = (b) => `${(b / 1e6).toFixed(2)} MB`, km = (px) => (px * m.pixel_m / 1000).toFixed(1);
  $("sizes").textContent = `${viewer.frames} images · video ${mb(seg.files[m.video][1])} · lines ${mb(seg.files[`${seg.name}.json`][1])}`
    + ` · ${m.width} × ${m.height} px of ${m.pixel_m} m (${km(m.width)} × ${km(m.height)} km)`;
  drawChart();
}
$("area").addEventListener("change", (e) => choose(e.target.value));
$("segment").addEventListener("change", (e) => choose($("area").value, e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.target.closest("select, input, button")) return;
  if (e.key === "ArrowRight") { viewer.stop(); viewer.step(1); }
  else if (e.key === "ArrowLeft") { viewer.stop(); viewer.step(-1); }
  else if (e.key === " ") { e.preventDefault(); viewer.playing ? viewer.stop() : viewer.start(); }
});
window.addEventListener("resize", drawChart);

try {
  await archive.load();
} catch (error) {
  $("viewer").textContent = `No image archive found (${error.message}).`;
  throw error;
}
const areas = archive.areas().map((a) => ({ ...a,          // a unit without a name: its country and code
  label: a.label === a.name && a.country ? `${countryName(a.country, lang)} · ${a.name}` : a.label }))
  .sort((a, b) => a.label.localeCompare(b.label, locale(lang)));
$("area").innerHTML = areas.map((a) => `<option value="${a.name}">${a.label}</option>`).join("");
if (params.get("transect") && params.get("unit")) {          // back to this transect's card on the map
  $("back").href = `./?t=${encodeURIComponent(params.get("transect"))}&u=${encodeURIComponent(params.get("unit"))}`;
}
const asked = params.get("segment");
const askedArea = asked && areas.find((a) => a.name === areaOf(asked)) ? areaOf(asked) : areas[0].name;
choose(askedArea, asked);
window.cevaFrames = { viewer, archive, choose };     // for the browser console and the tests
