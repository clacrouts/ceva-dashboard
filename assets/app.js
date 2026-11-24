// CEVA dashboard: a static map of shoreline change read from precomputed files (data/), no server.
import { countryName, direction, fillLanguagePicker, initialLanguage, keepLanguage, loadText, locale } from "./languages.js";
import { ImageArchive, ImageViewer, LINE_COLOURS } from "./viewer.js";

const DATA = new URL("data/", document.baseURI).href;
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

const CLASS_COLOURS = {
  extreme_erosion: "#67001f", severe_erosion: "#b2182b", intense_erosion: "#d6604d", erosion: "#f4a582",
  stable: "#a3a9b0", accretion: "#92c5de", intense_accretion: "#4393c3", severe_accretion: "#2166ac",
  extreme_accretion: "#053061", insufficient_data: "#d9dde1",
};
const SHORE_COLOURS = {
  sandy_gravel_or_small_boulder_sediments: "#e0a92e", muddy_sediments: "#8c6239",
  rocky_shore_platform_or_large_boulders: "#5f6b78", no_sediment_or_shore_platform: "#b8c0c8", unknown: "#dde1e5",
};
const SE_STOPS = [[2, "#fde0c5"], [6, "#f59e72"], [12, "#d1495b"], [25, "#6a1b4d"]];
// CEVA minus the Shoreline Monitor (m/yr): diverging, grey where they agree
const SMD_STEPS = [[-1, "#b2182b"], [-0.5, "#f4a582"], [0.5, "#c3c7cc"], [1, "#92c5de"], [Infinity, "#2166ac"]];
const SMD_NONE = "#e3e6e9";
// chart series: CEVA positions, CEVA trend, then one colour per product
const POSITION_COLOUR = "#2a78d6", TREND_COLOUR = "#eb6834";
const REF_COLOURS = { sm: "#6250d6", emodnet_sat: "#e87ba4", emodnet_field: "#eda100" };

// Filters: the change classes each choice keeps, and the precision bins (standard error of a yearly
// position, m) as in stats.json.
const EROSION = ["extreme_erosion", "severe_erosion", "intense_erosion", "erosion"];
const ACCRETION = ["extreme_accretion", "severe_accretion", "intense_accretion", "accretion"];
const CHANGE = { all: null, erosion: EROSION, erosion1: EROSION.slice(0, 3), erosion3: EROSION.slice(0, 2),
  erosion5: EROSION.slice(0, 1), stable: ["stable"], accretion: ACCRETION, accretion1: ACCRETION.slice(0, 3),
  accretion3: ACCRETION.slice(0, 2), accretion5: ACCRETION.slice(0, 1) };
const PRECISION = [[0, 5], [5, 10], [10, 20], [20, 1e9]];
const NO_FILTERS = { cc: "all", change: "all", coast: "all", material: "all", shore: "all", prec: "all", sig: false };
const MATERIALS = ["sandy_gravel_or_small_boulder_sediments", "muddy_sediments", "rocky_shore_platform_or_large_boulders",
  "no_sediment_or_shore_platform", "unknown"];
const COASTS = ["dune", "sediment_plain", "wetland", "inlet", "moderately_sloped", "cliffed_or_steep", "bedrock_plain",
  "engineered_structures"];

const state = { lang: initialLanguage(), text: null, mode: "cls", manifest: null, summary: null, stats: null,
  archive: null, viewer: null, imagesOpen: false,
  series: new Map(), refs: new Map(), selected: null, filters: { ...NO_FILTERS }, sort: { key: "name", dir: 1 } };
const $ = (id) => document.getElementById(id);
const t = () => state.text;
state.text = await loadText("map", state.lang);

const fmt = (value, digits = 1, sign = false) => value == null || Number.isNaN(value) ? "–" :
  new Intl.NumberFormat(locale(state.lang), { maximumFractionDigits: digits, minimumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto" }).format(value);
const pct = (part, whole) => whole ? fmt(100 * part / whole, 0) : "–";
const share = (part, whole) => whole ? new Intl.NumberFormat(locale(state.lang), { style: "percent",
  maximumFractionDigits: 0 }).format(part / whole) : "–";
const cap = (text) => text ? text.charAt(0).toLocaleUpperCase(locale(state.lang)) + text.slice(1) : text;
const nameOf = (code) => countryName(code, state.lang, state.summary?.countries?.[code]?.name);
// The trend and half its 95 % range (symmetric: a straight-line fit), or the trend alone.
function rateText(p) {
  const half = p.lo != null && p.hi != null ? (Number(p.hi) - Number(p.lo)) / 2 : null;
  return half != null && Number.isFinite(half) ? t().rateCi(fmt(p.rate, 1, true), fmt(half, 1)) : t().rate(fmt(p.rate, 1, true));
}

async function getJSON(name) {
  const response = await fetch(DATA + name, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

// ------------------------------------------------------------------ map
const linkedView = location.hash.includes("map=");     // read before the map writes its own position
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "map", style: BASEMAP, center: [5, 50], zoom: 3.4, hash: "map", attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
window.ceva = { map, state, select, setLanguage, setFilters };      // for the browser console and the tests
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

function colourExpression() {
  if (state.mode === "shore") {
    return ["match", ["coalesce", ["get", "shore"], "unknown"],
      ...Object.entries(SHORE_COLOURS).flat(), SHORE_COLOURS.unknown];
  }
  if (state.mode === "se") {
    return ["interpolate", ["linear"], ["coalesce", ["get", "se"], 25], ...SE_STOPS.flat()];
  }
  if (state.mode === "smd") {
    return ["step", ["coalesce", ["get", "smd"], -999], SMD_NONE, -998, SMD_STEPS[0][1],
      ...SMD_STEPS.slice(0, -1).flatMap(([edge], i) => [edge, SMD_STEPS[i + 1][1]])];
  }
  return ["match", ["get", "cls"], ...Object.entries(CLASS_COLOURS).flat(), CLASS_COLOURS.insufficient_data];
}

function addLayers() {
  map.addSource("shoreline", { type: "vector", url: `pmtiles://${DATA}shoreline.pmtiles` });
  map.addLayer({
    id: "dots", type: "circle", source: "shoreline", "source-layer": "shoreline",
    paint: {
      "circle-color": colourExpression(),
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.4, 6, 3, 9, 4, 12, 5.5, 15, 8],
      "circle-opacity": state.mode === "cls" ? ["case", ["==", ["get", "sig"], 1], 0.95, 0.45] : 0.9,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 12, 0.6],
      "circle-stroke-color": "rgba(255,255,255,0.8)",
    },
  });
  map.addSource("selected", { type: "geojson", data: emptyCollection() });
  map.addLayer({ id: "selected-line", type: "line", source: "selected", filter: ["==", ["get", "kind"], "line"],
    paint: { "line-color": "#0b5d7a", "line-width": 2, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "selected-years", type: "circle", source: "selected", filter: ["==", ["get", "kind"], "year"],
    paint: { "circle-radius": 3, "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "year"], 2000], 1984, "#cfe3ea", 2025, "#0b5d7a"],
      "circle-stroke-width": 0.5, "circle-stroke-color": "#fff" } });
}

function restyle() {
  if (!map.getLayer("dots")) return;
  map.setPaintProperty("dots", "circle-color", colourExpression());
  map.setPaintProperty("dots", "circle-opacity",
    state.mode === "cls" ? ["case", ["==", ["get", "sig"], 1], 0.95, 0.45] : 0.9);
  renderLegend();
}

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

// Room for the panels when the map frames an area: the overview on the side, or at the bottom on a phone.
function fitPadding() {
  if (matchMedia("(max-width: 720px)").matches) return { top: 30, left: 20, right: 20, bottom: Math.round(innerHeight * 0.42) + 20 };
  return { top: 40, bottom: 40, left: $("overview").offsetWidth + 40, right: 40 };     // the panel stays on the left
}
// The same, with the transect's card open on the right (or over the lower part of a phone's screen).
function cardPadding() {
  if (matchMedia("(max-width: 720px)").matches) return { top: 20, left: 20, right: 20, bottom: Math.round(innerHeight * 0.7) + 20 };
  return { top: 40, bottom: 40, left: $("overview").offsetWidth + 40, right: $("card").offsetWidth + 40 };
}

map.on("load", async () => {
  addLayers();
  try {
    [state.manifest, state.summary] = await Promise.all([getJSON("manifest.json"), getJSON("summary.json")]);
  } catch (error) {
    $("headline").textContent = `Could not read the data: ${error.message}`;
    return;
  }
  if (!linkedView) {
    const [w, s, e, n] = state.manifest.bounds;
    map.fitBounds([[w, s], [e, n]], { padding: fitPadding(), duration: 0 });
  }
  renderAll();
  // satellite images, when index.html points to an image archive (meta ceva-images)
  const images = document.querySelector('meta[name="ceva-images"]')?.content;
  if (images) {
    const archive = new ImageArchive(images);
    archive.load().then(() => {
      state.archive = archive;
      if (state.selected) renderImagesSection(state.selected);
    }).catch(() => { /* no images published */ });
  }
  if (state.manifest.files?.stats) {
    getJSON("stats.json").then((stats) => {
      state.stats = stats;
      state.col = Object.fromEntries(stats.columns.map((c, i) => [c, i]));
      fillFilters();
      renderStats();
    }).catch(() => { /* the filters still work on the map */ });
  }
  const params = new URLSearchParams(location.search);
  if (params.get("t") && params.get("u")) restoreSelection(params.get("t"), params.get("u"));
});

const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
map.on("mousemove", "dots", (event) => {
  map.getCanvas().style.cursor = "pointer";
  const p = event.features[0].properties;
  hover.setLngLat(event.lngLat).setText(`${t().classes[p.cls] || ""} · ${rateText(p)}`).addTo(map);
});
map.on("mouseleave", "dots", () => { map.getCanvas().style.cursor = ""; hover.remove(); });
map.on("click", "dots", (event) => select(event.features[0].properties));

// ------------------------------------------------------------------ overview panel
function renderLegend() {
  const legend = $("legend");
  if (state.mode === "shore") {
    legend.innerHTML = Object.keys(SHORE_COLOURS).map((k) =>
      `<span><i style="background:${SHORE_COLOURS[k]}"></i>${t().shores[k]}</span>`).join("");
  } else if (state.mode === "smd") {
    legend.innerHTML = SMD_STEPS.map(([, c], i) => `<span><i style="background:${c}"></i>${t().smdLegend[i]}</span>`).join("")
      + `<span><i style="background:${SMD_NONE}"></i>${t().smdLegend[5]}</span><span class="faint">${t().smdNote}</span>`;
  } else if (state.mode === "se") {
    legend.innerHTML = SE_STOPS.map(([v, c]) => `<span><i style="background:${c}"></i>${fmt(v, 0)} m</span>`).join("")
      + `<span class="faint">${t().precision(SE_STOPS[0][0], SE_STOPS.at(-1)[0])}</span>`;
  } else {
    legend.innerHTML = state.manifest.classes.map((k) =>
      `<span title="${t().classRanges[k]}"><i style="background:${CLASS_COLOURS[k]}"></i>${t().classes[k]}</span>`).join("")
      + `<span class="faint">${t().faintNote}</span>`;
  }
}

// ------------------------------------------------------------------ filters and figures
function filterExpression() {
  const f = state.filters, parts = [];
  if (f.cc !== "all") parts.push(["==", ["get", "cc"], f.cc]);
  if (CHANGE[f.change]) parts.push(["in", ["get", "cls"], ["literal", CHANGE[f.change]]]);
  if (f.coast !== "all") parts.push(["==", ["coalesce", ["get", "coast"], "unknown"], f.coast]);
  if (f.material !== "all") parts.push(["==", ["coalesce", ["get", "shore"], "unknown"], f.material]);
  const flag = (name, value) => ["==", ["to-string", ["get", name]], value];
  if (f.shore === "natural") parts.push(flag("built", "false"), flag("def", "false"));
  if (f.shore === "built") parts.push(flag("built", "true"));
  if (f.shore === "defended") parts.push(flag("def", "true"));
  if (f.prec !== "all") {
    const [lo, hi] = PRECISION[Number(f.prec)];
    parts.push([">=", ["coalesce", ["get", "se"], 1e6], lo], ["<", ["coalesce", ["get", "se"], 1e6], hi]);
  }
  if (f.sig) parts.push(["==", ["get", "sig"], 1]);
  return parts.length ? ["all", ...parts] : null;
}

// A group of stats.json (transects alike in everything the filters look at) passes the filters.
function passes(g, f, anyCountry = false) {
  const k = state.stats.keys, c = state.col;
  if (!anyCountry && f.cc !== "all" && k.cc[g[c.cc]] !== f.cc) return false;
  if (CHANGE[f.change] && !CHANGE[f.change].includes(k.cls[g[c.cls]])) return false;
  if (f.coast !== "all" && k.coast[g[c.coast]] !== f.coast) return false;
  if (f.material !== "all" && k.shore[g[c.shore]] !== f.material) return false;
  if (f.shore === "natural" && !(g[c.built] === 0 && g[c.def] === 0)) return false;
  if (f.shore === "built" && g[c.built] !== 1) return false;
  if (f.shore === "defended" && g[c.def] !== 1) return false;
  if (f.prec !== "all" && g[c.prec] !== Number(f.prec)) return false;
  return !(f.sig && g[c.sig] !== 1);
}

function firstAtLeast(sorted, value, strict) {       // index of the first rate >= value (> value if strict)
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] <= value : sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function aggregate(groups) {
  const k = state.stats.keys, c = state.col;
  const out = { n: 0, rated: 0, ero: 0, acc: 0, classes: Object.fromEntries(state.manifest.classes.map((x) => [x, 0])),
    rates: [] };
  for (const g of groups) {
    const cls = k.cls[g[c.cls]], rates = g[c.rates];
    out.n += g[c.n];
    if (cls !== "insufficient_data") { out.rated += g[c.n]; out.classes[cls] = (out.classes[cls] || 0) + g[c.n]; }
    if (g[c.sig] === 1) {                          // significant: retreating below zero, advancing above
      out.ero += firstAtLeast(rates, 0, false);
      out.acc += rates.length - firstAtLeast(rates, 0, true);
    }
    out.rates.push(rates);
  }
  return out;
}

function median(lists) {
  let length = 0;
  for (const list of lists) length += list.length;
  if (!length) return null;
  const all = new Float64Array(length);
  let at = 0;
  for (const list of lists) { all.set(list, at); at += list.length; }
  all.sort();
  const mid = length >> 1;
  return (length % 2 ? all[mid] : (all[mid - 1] + all[mid]) / 2) / 100;    // cm/yr to m/yr
}

// The figures of the filtered transects (summary.json alone until stats.json has arrived).
function currentFigures() {
  if (state.stats) return aggregate(state.stats.groups.filter((g) => passes(g, state.filters)));
  const s = state.filters.cc === "all" ? state.summary.all : state.summary.countries[state.filters.cc];
  return s && { n: s.transects, rated: s.rated, classes: s.classes, ero: s.significant_erosion, acc: s.significant_accretion };
}

const activeFilters = () => Object.entries(state.filters).filter(([k, v]) => v !== NO_FILTERS[k]).length;

function options(select, entries, value) {
  select.innerHTML = entries.map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  select.value = entries.some(([v]) => String(v) === String(value)) ? value : entries[0][0];
}

function fillFilters() {
  const text = t();
  const countries = (state.stats ? state.stats.keys.cc : Object.keys(state.summary.countries)).filter(Boolean)
    .map((code) => [code, nameOf(code)]).sort((a, b) => a[1].localeCompare(b[1], locale(state.lang)));
  options($("f-country"), [["all", text.allCountries], ...countries], state.filters.cc);
  options($("f-change"), Object.keys(CHANGE).map((k) => [k, text.changeOptions[k]]), state.filters.change);
  const present = state.stats ? state.stats.keys.coast : COASTS;
  const coasts = [...COASTS.filter((k) => present.includes(k)), ...present.filter((k) => !COASTS.includes(k))];
  options($("f-coast"), [["all", text.allTypes], ...coasts.map((k) => [k, k === "unknown" ? text.shores.unknown
    : cap(text.coasts[k] || k.replaceAll("_", " "))])], state.filters.coast);
  const materials = state.stats ? MATERIALS.filter((k) => state.stats.keys.shore.includes(k)) : MATERIALS;
  options($("f-material"), [["all", text.allMaterials], ...materials.map((k) => [k, text.shores[k]])], state.filters.material);
  options($("f-shore"), Object.entries(text.shoreOptions), state.filters.shore);
  options($("f-prec"), [["all", text.precisionOptions.all], ...PRECISION.map((_, i) => [i, text.precisionOptions[i]])],
    state.filters.prec);
  $("f-sig").checked = state.filters.sig;
}

function setFilters(changes, zoom = false) {
  state.filters = { ...state.filters, ...changes };
  if (map.getLayer("dots")) map.setFilter("dots", filterExpression());
  fillFilters();
  renderStats();
  if ($("countries").open) renderCountries();
  if (zoom) {
    const block = state.filters.cc === "all" ? state.manifest : state.summary.countries[state.filters.cc];
    if (block && block.bounds && block.bounds.every(Number.isFinite)) {
      const [w, s, e, n] = block.bounds;
      map.fitBounds([[w, s], [e, n]], { padding: fitPadding(), maxZoom: 11 });
    }
  }
}

function renderStats() {
  const figures = currentFigures();
  const active = activeFilters();
  $("filter-count").hidden = !active;
  $("filter-count").textContent = fmt(active, 0);
  $("f-reset").hidden = !active;
  $("filtered").hidden = !active || !figures;
  if (figures && active) $("filtered").textContent = figures.n ? t().filtered(fmt(figures.n, 0), fmt(state.manifest.transects, 0))
    : t().noMatch;
  $("country-button").hidden = !state.stats;
  if (!figures) return;
  $("headline").innerHTML = t().headline(fmt(figures.n, 0), pct(figures.ero, figures.rated), pct(figures.acc, figures.rated));
  $("bar").innerHTML = classBar(figures);
  $("bar").setAttribute("aria-label", t().barNote);
  $("bar-note").textContent = t().barNote;
}

function classBar(figures) {
  return state.manifest.classes.map((k) => {
    const part = figures.rated ? 100 * (figures.classes[k] || 0) / figures.rated : 0;
    return part > 0 ? `<div style="width:${part}%;background:${CLASS_COLOURS[k]}" title="${t().classes[k]}: ${fmt(part, 1)} %"></div>` : "";
  }).join("");
}

// ------------------------------------------------------------------ summary by country
function countryRows() {
  const byCountry = new Map(), all = [];
  const k = state.stats.keys, c = state.col;
  for (const g of state.stats.groups) {
    if (!passes(g, state.filters, true)) continue;
    all.push(g);
    const code = k.cc[g[c.cc]];
    if (!code) continue;
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(g);
  }
  const row = (code, name, groups) => {
    const a = aggregate(groups);
    return { code, name, n: a.n, km: a.n / 10, ero: a.rated ? a.ero / a.rated : null, acc: a.rated ? a.acc / a.rated : null,
      median: median(a.rates), figures: a };
  };
  const rows = [...byCountry].map(([code, groups]) => row(code, nameOf(code), groups));
  const { key, dir } = state.sort;
  rows.sort((a, b) => key === "name" ? dir * a.name.localeCompare(b.name, locale(state.lang))
    : dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity)));
  return { rows, total: row(null, t().total, all) };
}

const COUNTRY_COLUMNS = ["name", "km", "n", "ero", "acc", "median", "bar"];

function renderCountries() {
  const text = t();
  $("countries-intro").textContent = text.countryIntro + (activeFilters() > (state.filters.cc === "all" ? 0 : 1)
    ? ` ${text.countryFiltered}` : "");
  const { rows, total } = countryRows();
  const cell = (r, key) => key === "name" ? r.name : key === "km" ? fmt(r.km, 0) : key === "n" ? fmt(r.n, 0)
    : key === "ero" || key === "acc" ? (r[key] == null ? "–" : share(r[key], 1))
      : key === "median" ? fmt(r.median, 2, true) : "";
  const head = COUNTRY_COLUMNS.map((key) => {
    const th = document.createElement("th");
    th.scope = "col";
    if (key === "bar") { th.textContent = text.countryCols.bar; return th; }
    const button = document.createElement("button");
    button.className = "sort";
    button.textContent = text.countryCols[key];
    if (state.sort.key === key) {
      th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
      button.textContent += state.sort.dir > 0 ? " ▲" : " ▼";
    }
    button.addEventListener("click", () => {
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "name" ? 1 : -1 };
      renderCountries();
    });
    th.append(button);
    return th;
  });
  const line = (r, tag = "td") => {
    const tr = document.createElement("tr");
    COUNTRY_COLUMNS.forEach((key) => {
      const td = document.createElement(key === "name" && tag === "td" ? "th" : tag);
      if (key === "name" && tag === "td") td.scope = "row";
      if (key === "bar") {
        td.innerHTML = `<div class="bar mini">${classBar(r.figures)}</div>`;
      } else {
        td.textContent = cell(r, key);
      }
      if (key !== "name" && key !== "bar") td.className = "num";
      tr.append(td);
    });
    return tr;
  };
  const table = $("country-table");
  const thead = document.createElement("thead"), tbody = document.createElement("tbody"), tfoot = document.createElement("tfoot");
  thead.append(Object.assign(document.createElement("tr"), {}));
  thead.firstChild.append(...head);
  rows.forEach((r) => {
    const tr = line(r);
    tr.tabIndex = 0;
    tr.classList.toggle("chosen", r.code === state.filters.cc);
    const choose = () => { $("countries").close(); setFilters({ cc: r.code }, true); };
    tr.addEventListener("click", choose);
    tr.addEventListener("keydown", (event) => { if (event.key === "Enter") choose(); });
    tbody.append(tr);
  });
  tfoot.append(line(total, "td"));
  table.replaceChildren(thead, tbody, tfoot);
}

$("colour-by").addEventListener("change", (event) => { state.mode = event.target.value; restyle(); });
$("f-country").addEventListener("change", (event) => setFilters({ cc: event.target.value }, true));
$("f-change").addEventListener("change", (event) => setFilters({ change: event.target.value }));
$("f-coast").addEventListener("change", (event) => setFilters({ coast: event.target.value }));
$("f-material").addEventListener("change", (event) => setFilters({ material: event.target.value }));
$("f-shore").addEventListener("change", (event) => setFilters({ shore: event.target.value }));
$("f-prec").addEventListener("change", (event) => setFilters({ prec: event.target.value }));
$("f-sig").addEventListener("change", (event) => setFilters({ sig: event.target.checked }));
$("f-reset").addEventListener("click", () => setFilters({ ...NO_FILTERS }, state.filters.cc !== "all"));
$("country-button").addEventListener("click", () => { renderCountries(); $("countries").showModal(); });
if (matchMedia("(min-width: 721px)").matches) $("filters").open = true;

// ------------------------------------------------------------------ the evidence card
async function seriesOf(unit) {
  if (!state.series.has(unit)) state.series.set(unit, getJSON(`series/${encodeURIComponent(unit)}.json`));
  return state.series.get(unit);
}

async function refsOf(unit) {
  if (!state.manifest?.files?.refs) return { transects: {} };
  if (!state.refs.has(unit)) {
    state.refs.set(unit, getJSON(`refs/${encodeURIComponent(unit)}.json`).catch(() => ({ transects: {} })));
  }
  return state.refs.get(unit);
}

async function select(props) {
  state.selected = props;
  const params = new URLSearchParams(location.search);
  params.set("t", props.id);
  params.set("u", props.unit);
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  $("card").classList.remove("hidden");
  $("card-text").textContent = t().loading;
  const [data, refs] = await Promise.all([seriesOf(props.unit), refsOf(props.unit)]);
  const series = data.transects[props.id];
  if (state.selected !== props) return;           // another one was clicked meanwhile
  renderCard(props, series, refs.transects[props.id] || {});
  highlight(series);
}

function relative(series) {
  const mean = series.x.reduce((a, b) => a + b, 0) / series.x.length;
  return series.x.map((x) => x - mean);
}

function trend(years, values) {
  const n = years.length;
  const my = years.reduce((a, b) => a + b, 0) / n;
  const mv = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  years.forEach((y, i) => { sxy += (y - my) * (values[i] - mv); sxx += (y - my) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  return years.map((y) => mv + slope * (y - my));
}

function renderCard(p, series, refs = {}) {
  const text = t();
  $("card-place").textContent = [p.cc ? nameOf(p.cc) : p.cn, text.shores[p.shore || "unknown"]].filter(Boolean).join(" · ");
  $("card-rate").textContent = rateText(p);
  $("card-ci").hidden = p.lo == null || p.hi == null;
  renderImagesSection(p);
  const chip = $("card-class");
  chip.textContent = text.classes[p.cls] || p.cls;
  chip.style.background = CLASS_COLOURS[p.cls] || CLASS_COLOURS.insufficient_data;
  chip.style.color = ["stable", "erosion", "accretion", "insufficient_data"].includes(p.cls) ? "#1c2530" : "#fff";
  const significant = p.sig === 1 || p.sig === "1";
  const r = Math.abs(p.rate), lo = Math.abs(p.lo), hi = Math.abs(p.hi);
  $("card-text").textContent = !significant ? text.summaryNone(p.y0, p.y1, fmt(p.rate, 1, true))
    : p.rate < 0 ? text.summaryRetreat(p.y0, p.y1, fmt(r), fmt(Math.min(lo, hi)), fmt(Math.max(lo, hi)))
      : text.summaryAdvance(p.y0, p.y1, fmt(r), fmt(Math.min(lo, hi)), fmt(Math.max(lo, hi)));
  const facts = [
    [text.years, `${fmt(p.ny, 0)} (${p.y0}–${p.y1})`],
    [text.images, series ? fmt(series.n.reduce((a, b) => a + b, 0), 0) : "–"],
    [text.precisionFact, `± ${fmt(p.se)} m`],
    [text.coastType, [text.shores[p.shore || "unknown"], text.coasts[p.coast]].filter(Boolean).join(", ")],
    [text.built, p.built == null ? "–" : (p.built === true || p.built === "true" || p.built === 1) ? text.yes : text.no],
    [text.defence, p.def == null ? "–" : (p.def === true || p.def === "true" || p.def === 1) ? text.yes : text.no],
  ];
  if (!state.manifest?.files?.refs) facts.push([text.monitor, p.sds == null ? "–" : text.rate(fmt(p.sds, 1, true))]);
  $("card-facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("card-id").textContent = `${text.transect} ${p.id}`;
  renderRefs(refs);
  renderChart(series, refs);
}

// ------------------------------------------------------------------ the satellite images, in the card
// For transects whose segment has images: a button opens them under the chart, and the image is drawn
// in place on the map with the detected and corrected waterlines. A click on the chart opens a year.
function viewer() {
  if (!state.viewer) {
    state.viewer = new ImageViewer($("viewer"), { text: t().viewer, fmt, map, beforeLayer: "dots",
      years: state.manifest?.years, onChange: () => chart?.redraw(false, false), onPick: selectTransect });
  }
  return state.viewer;
}

async function renderImagesSection(p) {
  const seg = state.archive ? await state.archive.find(p.unit, p.id).catch(() => null) : null;
  if (state.selected !== p) return;                  // another transect was opened meanwhile
  const box = $("card-images");
  box.hidden = !seg;
  $("chart").classList.toggle("clickable", Boolean(seg));
  if (!seg) { closeImages(); return; }
  const v = t().viewer;
  $("images-toggle").textContent = state.imagesOpen ? v.hide : v.show;
  $("images-toggle").setAttribute("aria-expanded", String(state.imagesOpen));
  $("images-page").textContent = v.page;
  $("images-page").href = `frames.html?segment=${encodeURIComponent(seg.name)}&transect=${encodeURIComponent(p.id)}`
    + `&unit=${encodeURIComponent(p.unit)}&lang=${state.lang}`;
  $("images-hint").textContent = v.hint;
  if (state.imagesOpen) openImages(seg, p.id);
}

// Open (or follow) the images of a segment; frame the map on them when they are out of view.
async function openImages(seg, transectId, fit = false) {
  const v = viewer();
  $("viewer").hidden = false;
  try {
    await v.open(state.archive, seg, transectId);
  } catch {
    return false;
  }
  if (!v.meta) return false;
  const [[w, s], [e, n]] = v.bounds, view = map.getBounds();
  if (fit || !view.contains([w, s]) || !view.contains([e, n])) {
    map.fitBounds(v.bounds, { padding: cardPadding(), maxZoom: 15 });
  }
  chart?.redraw(false, false);
  return true;
}

function closeImages() {
  state.viewer?.close();
  $("viewer").hidden = true;
  chart?.redraw(false, false);
}

$("images-toggle").addEventListener("click", async () => {
  const p = state.selected, seg = p && state.archive ? await state.archive.find(p.unit, p.id) : null;
  if (!seg) return;
  state.imagesOpen = !state.imagesOpen;
  renderImagesSection(p);
  if (state.imagesOpen) openImages(seg, p.id, true); else closeImages();
});

// A transect clicked on the image: open its card (it is on the map, around the image).
function selectTransect(id) {
  const found = map.querySourceFeatures("shoreline", { sourceLayer: "shoreline", filter: ["==", ["get", "id"], id] });
  if (found.length) select(found[0].properties); else state.viewer?.setTransect(id);
}

// Each image's corrected shoreline at the transect as a dot on the chart, and the image shown as a line.
// A year's images are spread around the year's point (its median), hence the half-year shift.
function drawImageDots(u) {
  const v = state.viewer;
  if (!v?.meta || !state.selected || u.ceva == null) return;
  const dots = v.imagesOf(state.selected.id);
  const { ctx } = u, { left, top, width, height } = u.bbox, ratio = devicePixelRatio || 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  for (const d of dots) {
    ctx.fillStyle = d.flag === 1 ? "rgba(143, 150, 158, 0.55)" : "rgba(42, 120, 214, 0.42)";
    ctx.beginPath();
    ctx.arc(u.valToPos(d.when - 0.5, "x", true), u.valToPos(d.x - u.ceva.mean, "y", true), 1.7 * ratio, 0, 2 * Math.PI);
    ctx.fill();
  }
  if (v.currentWhen != null) {
    const x = u.valToPos(v.currentWhen - 0.5, "x", true);
    ctx.strokeStyle = LINE_COLOURS.corr;
    ctx.lineWidth = 1.5 * ratio;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }
  ctx.restore();
}

// A click on the chart: the image under the pointer (a dot), else the image that best represents the year.
async function chartClick(u) {
  const x = u.posToVal(u.cursor.left, "x");
  const p = state.selected, seg = p && state.archive ? await state.archive.find(p.unit, p.id) : null;
  if (!seg || !Number.isFinite(x)) return;
  const v = viewer();
  let target = null;
  if (v.meta && v.seg?.name === seg.name) {
    let near = 6;
    for (const d of v.imagesOf(p.id)) {
      const gap = Math.hypot(u.valToPos(d.when - 0.5, "x") - u.cursor.left, u.valToPos(d.x - u.ceva.mean, "y") - u.cursor.top);
      if (gap < near) { near = gap; target = d.frame; }
    }
  }
  const opening = !state.imagesOpen;
  state.imagesOpen = true;
  renderImagesSection(p);
  if (!(await openImages(seg, p.id, opening))) return;
  v.stop();
  if (target != null) await v.show(target); else await v.showYear(Math.round(x));
}

// Other products at this transect: their rate and years, and CEVA's rate over the same years.
function renderRefs(refs) {
  const text = t();
  const box = $("card-refs");
  const keys = Object.keys(REF_COLOURS).filter((k) => refs[k]);
  if (!state.manifest?.files?.refs) { box.replaceChildren(); return; }
  const value = (r) => r.r != null ? text.rate(fmt(r.r, 1, true)) : r.k ? text.clsNames[r.k] : "–";
  const rows = keys.map((k) => {
    const r = refs[k];
    const tr = document.createElement("tr");
    if (r.d != null && k !== "sm") tr.title = text.refsAway(fmt(r.d, 0));
    const name = document.createElement("td");
    name.innerHTML = `<i style="background:${REF_COLOURS[k]}"></i>`;
    name.append(text.refNames[k]);
    const cells = [r.y && r.y[0] ? `${r.y[0]}–${r.y[1]}` : text.noPeriod, value(r),
      r.c != null ? text.rate(fmt(r.c, 1, true)) : "–"].map((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      return td;
    });
    tr.append(name, ...cells);
    return tr;
  });
  const parts = [];
  const heading = document.createElement("h3");
  heading.textContent = text.refsTitle;
  parts.push(heading);
  if (rows.length) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>${text.refsCols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
    const body = document.createElement("tbody");
    body.append(...rows);
    table.append(body);
    parts.push(table);
  } else {
    const none = document.createElement("p");
    none.className = "note";
    none.textContent = text.refsNone;
    parts.push(none);
  }
  const note = document.createElement("p");
  note.className = "note";
  note.textContent = text.refsNote + " ";
  const link = document.createElement("a");
  link.href = "validation.html";
  link.textContent = text.howCompares;
  note.append(link);
  parts.push(note);
  box.replaceChildren(...parts);
}

// A product's rate drawn over its own years, through CEVA's mean position of those years.
function referenceLine(years, rel, r) {
  if (r.r == null || !r.y || r.y[0] == null) return null;
  const inside = years.map((y, i) => [y, rel[i]]).filter(([y]) => y >= r.y[0] && y <= r.y[1]);
  if (inside.length < 2) return null;
  const my = inside.reduce((a, [y]) => a + y, 0) / inside.length;
  const mv = inside.reduce((a, [, v]) => a + v, 0) / inside.length;
  const lo = inside[0][0], hi = inside.at(-1)[0];
  return years.map((y) => (y >= lo && y <= hi ? mv + r.r * (y - my) : null));
}

let chart = null;
function renderChart(series, refs = {}) {
  const box = $("chart");
  if (chart) { chart.destroy(); chart = null; }
  box.innerHTML = "";
  if (!series || series.year.length < 2) { box.textContent = t().noData; return; }
  const years = series.year, rel = relative(series);
  const lower = rel.map((v, i) => v - (series.se[i] ?? 0));
  const upper = rel.map((v, i) => v + (series.se[i] ?? 0));
  const line = trend(years, rel);
  const width = Math.max(box.clientWidth, 260);
  const extra = Object.keys(REF_COLOURS).filter((k) => refs[k]).map((k) => [k, referenceLine(years, rel, refs[k])])
    .filter(([, values]) => values);
  chart = new uPlot({
    width, height: 220, padding: [8, 8, 0, 0], legend: { show: false }, cursor: { points: { size: 6 } },
    scales: { x: { time: false, range: (u, lo, hi) => [lo - 0.5, hi + 0.5] } },
    axes: [{ stroke: "#5b6673", grid: { stroke: "#eef1f4" }, values: (u, v) => v.map((year) => String(year)) },
      { stroke: "#5b6673", grid: { stroke: "#eef1f4" }, size: 68,
        values: (u, v) => v.map((x) => `${fmt(x, 0, true)} m`) }],
    series: [{},
      { stroke: "rgba(11,93,122,0)", points: { show: false } },
      { stroke: "rgba(11,93,122,0)", points: { show: false } },
      { label: "position", stroke: POSITION_COLOUR, width: 1.5, points: { size: 6, fill: POSITION_COLOUR } },
      { label: "trend", stroke: TREND_COLOUR, width: 2, dash: [6, 4], points: { show: false } },
      ...extra.map(([k]) => ({ label: k, stroke: REF_COLOURS[k], width: 2, points: { show: false } }))],
    bands: [{ series: [2, 1], fill: "rgba(42,120,214,0.12)" }],
    hooks: { draw: [drawImageDots], ready: [(u) => {
      let down = null;                                  // a drag zooms the chart: only a still click opens an image
      u.over.addEventListener("mousedown", (e) => { down = [e.clientX, e.clientY]; });
      u.over.addEventListener("click", (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) chartClick(u);
      });
    }] },
  }, [years, lower, upper, rel, line, ...extra.map(([, values]) => values)], box);
  chart.ceva = { mean: series.x.reduce((a, b) => a + b, 0) / series.x.length };      // as in relative()
  const keys = [[POSITION_COLOUR, t().keyPosition, false], [TREND_COLOUR, t().keyTrend, true],
    ...extra.map(([k]) => [REF_COLOURS[k], `${t().refNames[k]} ${refs[k].y[0]}–${refs[k].y[1]}`, false])];
  $("chart-keys").innerHTML = keys.map(([c, label, dashed]) =>
    `<span><i class="${dashed ? "dash" : ""}" style="border-color:${c}"></i>${label}</span>`).join("");
}
window.addEventListener("resize", () => { if (chart) chart.setSize({ width: $("chart").clientWidth, height: 220 }); });

function haversine([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180, dlat = (lat2 - lat1) * rad, dlon = (lon2 - lon1) * rad;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

function highlight(series) {
  if (!series || !series.line) { map.getSource("selected").setData(emptyCollection()); return; }
  const [land, sea] = series.line, length = haversine(land, sea);
  const at = (x) => [land[0] + (sea[0] - land[0]) * x / length, land[1] + (sea[1] - land[1]) * x / length];
  const features = [{ type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: series.line } }]
    .concat(series.year.map((year, i) => ({ type: "Feature", properties: { kind: "year", year },
      geometry: { type: "Point", coordinates: at(series.x[i]) } })));
  map.getSource("selected").setData({ type: "FeatureCollection", features });
}

async function restoreSelection(id, unit) {
  try {
    const data = await seriesOf(unit);
    const series = data.transects[id];
    if (!series || !series.line) return;
    map.jumpTo({ center: series.line[1], zoom: Math.max(map.getZoom(), 13) });
    map.once("idle", () => {
      const found = map.querySourceFeatures("shoreline", { sourceLayer: "shoreline", filter: ["==", ["get", "id"], id] });
      if (found.length) select(found[0].properties);
    });
  } catch { /* a link to a transect that is no longer published */ }
}

$("card-close").addEventListener("click", () => {
  $("card").classList.add("hidden");
  state.imagesOpen = false;
  closeImages();
  map.getSource("selected")?.setData(emptyCollection());
  state.selected = null;
  const params = new URLSearchParams(location.search);
  params.delete("t"); params.delete("u");
  history.replaceState(null, "", `${location.pathname}${params.size ? "?" + params : ""}${location.hash}`);
});

// ------------------------------------------------------------------ language and "how to read this"
function translateStatic() {
  document.documentElement.lang = locale(state.lang);
  document.documentElement.dir = direction(state.lang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const value = t()[el.dataset.i18n];
    if (typeof value === "string") el.textContent = value;
  });
  fillLanguagePicker($("lang"), state.lang);
  $("lang").setAttribute("aria-label", t().language);
  document.title = `CEVA · ${t().title}`;
}

function renderAbout() {
  $("about-body").innerHTML = t().aboutHtml;
  if (state.manifest?.files?.validation) {
    const p = document.createElement("p");
    p.innerHTML = `<a href="validation.html">${t().howCompares}</a>`;
    $("attributions").before(p);
  }
  if (state.manifest) {
    $("attributions").innerHTML = state.manifest.attribution.map((a) => `<li>${a}</li>`).join("")
      + `<li>Map: © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap</li>`;
    const m = state.manifest;
    $("version").textContent = `CEVA ${m.ceva_version} · ${m.method} · ${fmt(m.transects, 0)} transects · `
      + `${m.years[0]}–${m.years[1]} · ${m.generated.slice(0, 10)} · data ${m.licence}`;
  }
}

// A publication made before the run is finished says so, with the countries it covers.
function renderPreview() {
  const banner = $("preview");
  banner.hidden = !state.manifest.provisional;
  if (banner.hidden) return;
  const codes = Object.keys(state.summary.countries);
  const places = codes.length > 5 ? t().countriesCount(fmt(codes.length, 0))
    : new Intl.ListFormat(locale(state.lang), { type: "conjunction" })
      .format(codes.map(nameOf).sort((a, b) => a.localeCompare(b, locale(state.lang))));
  banner.textContent = t().preview(fmt(state.summary.all.transects, 0), places);
}

function renderAll() {
  translateStatic();
  if (!state.manifest) return;
  const quality = state.manifest.validation;
  if (quality) $("caveats").textContent = t().caveatsFrom(fmt(quality.yearly_rmse[0], 0), fmt(quality.yearly_rmse[1], 0),
    fmt(quality.rate_rmse[0], 1), fmt(quality.rate_rmse[1], 1));
  $("validation-link").hidden = !state.manifest.files?.validation;
  renderPreview();
  state.viewer?.setText(t().viewer);
  fillFilters();
  renderLegend();
  renderStats();
  if ($("countries").open) renderCountries();
  if (state.selected) {
    Promise.all([seriesOf(state.selected.unit), refsOf(state.selected.unit)]).then(([d, r]) =>
      renderCard(state.selected, d.transects[state.selected.id], r.transects[state.selected.id] || {}));
  }
}

async function setLanguage(lang) {
  state.text = await loadText("map", lang);
  state.lang = lang;
  keepLanguage(lang);
  renderAll();
  if ($("about").open) renderAbout();
}
$("lang").addEventListener("change", (event) => setLanguage(event.target.value));
$("about-button").addEventListener("click", () => { renderAbout(); $("about").showModal(); });

translateStatic();
