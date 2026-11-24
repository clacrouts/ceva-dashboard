// CEVA dashboard: the validation page, drawn from data/validation.json (no server).
// Charts are plain HTML (bars, tables) or canvas (density, histograms); each has a hover readout
// and a table view. Text read from the data files is inserted as text, never as HTML.
import { direction, fillLanguagePicker, initialLanguage, keepLanguage, loadText, locale } from "./languages.js";

const DATA = new URL("data/", document.baseURI).href;
const REF_TOKENS = { sm: "--ref-sm", emodnet_sat: "--ref-emodnet", emodnet_field: "--ref-field" };
const SEQUENTIAL = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"];

const state = { lang: initialLanguage(), text: null, data: null, manifest: null };
const drawers = [];
const $ = (id) => document.getElementById(id);
const T = () => state.text;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmt = (value, digits = 1, sign = false) => value == null || Number.isNaN(value) ? "–" :
  new Intl.NumberFormat(locale(state.lang), { maximumFractionDigits: digits, minimumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto" }).format(value);
const pct = (share) => share == null ? "–" : fmt(100 * share, 0);
const minOf = (values) => Math.min(...values);
const maxOf = (values) => Math.max(...values);

// A DOM element; "html" is only ever given our own text, never data.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ------------------------------------------------------------------ tooltip
const tip = h("div", { class: "tip", role: "status" });
document.body.append(tip);
function showTip(x, y, lines) {
  tip.replaceChildren(...lines.map((line, i) => h(i ? "span" : "strong", {}, line)));
  tip.style.display = "block";
  const { width, height } = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, innerWidth - width - 8)}px`;
  tip.style.top = `${Math.max(8, y - height - 10)}px`;
}
const hideTip = () => { tip.style.display = "none"; };

// ------------------------------------------------------------------ building blocks
function tiles(items) {
  return h("div", { class: "tiles" }, items.filter(Boolean).map(([label, value, note]) =>
    h("div", { class: "tile" }, h("span", { class: "tile-label" }, label), h("span", { class: "tile-value" }, value),
      note ? h("span", { class: "tile-note" }, note) : null)));
}

function card(title, note, ...content) {
  return h("figure", { class: "card" }, h("figcaption", {}, h("span", { class: "card-title" }, title),
    note ? h("span", { class: "card-note" }, note) : null), ...content);
}

function twin(head, rows) {
  return h("details", { class: "twin" }, h("summary", {}, T().table),
    h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))));
}

// One bar per group (one series, one colour); the value at the tip and the count beside it.
function barList(rows, { value, label, format, max }) {
  const top = max ?? (maxOf(rows.map((r) => r[value] ?? 0)) || 1);
  return h("div", { class: "bars" }, rows.map((r) => {
    const v = r[value];
    const tipLines = [format(v), label(r), T().count(fmt(r.n || r.n_cls, 0))];
    return h("div", { class: "bar-row", tabindex: "0",
      onpointermove: (e) => showTip(e.clientX, e.clientY, tipLines), onpointerleave: hideTip,
      onfocus: (e) => { const b = e.target.getBoundingClientRect(); showTip(b.right - 60, b.top, tipLines); }, onblur: hideTip },
    h("span", { class: "bar-label" }, label(r)),
    h("span", { class: "bar-track" }, h("span", { class: "bar-fill", style: `width:${Math.max(0, 100 * (v ?? 0) / top)}%` }),
      h("span", { class: "bar-value" }, format(v))),
    h("span", { class: "bar-n" }, fmt(r.n || r.n_cls, 0)));
  }));
}

// Two series per group (CEVA and its CoastSat variant), with a legend.
function pairedBars(groups, series, format) {
  const top = maxOf(groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0))) || 1;
  return h("div", {},
    h("div", { class: "legend" }, series.map((s) => h("span", {}, h("i", { style: `background:var(${s.token})` }), s.name))),
    h("div", { class: "bars paired" }, groups.map((g) => h("div", { class: "pair" },
      h("span", { class: "bar-label" }, g.label, h("small", {}, g.note)),
      h("span", { class: "pair-bars" }, series.map((s) => {
        const v = g.values[s.key];
        const lines = [format(v), `${g.label} · ${s.name}`];
        return h("span", { class: "bar-track", tabindex: "0",
          onpointermove: (e) => showTip(e.clientX, e.clientY, lines), onpointerleave: hideTip },
        h("span", { class: "bar-fill", style: `width:${v == null ? 0 : 100 * v / top}%;background:var(${s.token})` }),
        h("span", { class: "bar-value" }, format(v)));
      }))))));
}

// ------------------------------------------------------------------ canvas charts
function canvasIn(box, height) {
  const width = Math.max(box.clientWidth, 240);
  const ratio = window.devicePixelRatio || 1;
  const canvas = box.querySelector("canvas") || box.appendChild(h("canvas", {}));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = `11px ${token("--font")}`;
  return { canvas, ctx, width };
}

function axes(ctx, frame, { xTicks, yTicks, xLabel, yLabel, sx, sy, xFormat, yFormat }) {
  ctx.strokeStyle = token("--grid");
  ctx.lineWidth = 1;
  ctx.fillStyle = token("--muted");
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const v of xTicks) {
    const x = Math.round(sx(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, frame.top); ctx.lineTo(x, frame.bottom); ctx.stroke();
    ctx.fillText(xFormat(v), x, frame.bottom + 6);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of yTicks) {
    const y = Math.round(sy(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(frame.left, y); ctx.lineTo(frame.right, y); ctx.stroke();
    ctx.fillText(yFormat(v), frame.left - 6, y);
  }
  ctx.strokeStyle = token("--axis");
  ctx.beginPath(); ctx.moveTo(frame.left, frame.bottom + 0.5); ctx.lineTo(frame.right, frame.bottom + 0.5); ctx.stroke();
  ctx.fillStyle = token("--ink-2");
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(xLabel, (frame.left + frame.right) / 2, frame.bottom + 36);
  if (yLabel) {
    ctx.save();
    ctx.translate(12, (frame.top + frame.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }
}

function sequentialColour(level) {           // level 0..1 -> the one-hue ramp, light to dark
  const steps = SEQUENTIAL.map(token);
  return steps[Math.min(steps.length - 1, Math.floor(level * steps.length))];
}

function densityChart(d) {
  const box = h("div", { class: "plot" });
  const legend = h("div", { class: "scale" });
  const n = d.counts.length, start = d.start, step = d.step, end = start + n * step;
  const max = maxOf(d.counts.flat()) || 1;
  drawers.push(() => {
    const size = Math.min(box.clientWidth, 420);
    const { canvas, ctx } = canvasIn(box, size);
    const frame = { left: 52, right: size - 10, top: 8, bottom: size - 44 };
    const side = Math.min(frame.right - frame.left, frame.bottom - frame.top);
    frame.right = frame.left + side; frame.bottom = frame.top + side;
    const sx = (v) => frame.left + (v - start) / (end - start) * side;
    const sy = (v) => frame.bottom - (v - start) / (end - start) * side;
    const ticks = [-3, -2, -1, 0, 1, 2, 3].filter((v) => v >= start && v <= end);
    axes(ctx, frame, { xTicks: ticks, yTicks: ticks, xLabel: T().densityX, yLabel: T().densityY, sx, sy,
      xFormat: (v) => fmt(v, 0, true), yFormat: (v) => fmt(v, 0, true) });
    const cell = side / n;
    d.counts.forEach((row, i) => row.forEach((count, j) => {
      if (!count) return;
      ctx.fillStyle = sequentialColour(Math.log1p(count) / Math.log1p(max));
      ctx.fillRect(frame.left + j * cell, frame.bottom - (i + 1) * cell, Math.ceil(cell), Math.ceil(cell));
    }));
    ctx.strokeStyle = token("--ink-2");
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx(start), sy(start)); ctx.lineTo(sx(end), sy(end)); ctx.stroke();
    canvas.onpointermove = (e) => {
      const r = canvas.getBoundingClientRect();
      const j = Math.floor((e.clientX - r.left - frame.left) / cell), i = Math.floor((frame.bottom - (e.clientY - r.top)) / cell);
      if (i < 0 || j < 0 || i >= n || j >= n) return hideTip();
      const x0 = start + j * step, y0 = start + i * step;
      showTip(e.clientX, e.clientY, T().tipCell(fmt(x0, 1, true), fmt(x0 + step, 1, true), fmt(y0, 1, true),
        fmt(y0 + step, 1, true), fmt(d.counts[i][j], 0)));
    };
    canvas.onpointerleave = hideTip;
    legend.replaceChildren(h("span", {}, "1"), h("i", { style: `background:linear-gradient(90deg,${SEQUENTIAL.map(token).join(",")})` }),
      h("span", {}, fmt(max, 0)));
  });
  // table view: the counts in five classes each way
  const edges = [-3, -1, -0.5, 0.5, 1, 3];
  const index = (v) => Math.round((v - start) / step);
  const sum = (r0, r1, c0, c1) => d.counts.slice(r0, r1).reduce((a, row) => a + row.slice(c0, c1).reduce((x, y) => x + y, 0), 0);
  const rows = [];
  for (let c = 0; c < 5; c += 1) {
    const cols = [];
    for (let r = 0; r < 5; r += 1) cols.push(fmt(sum(index(edges[r]), index(edges[r + 1]), index(edges[c]), index(edges[c + 1])), 0));
    rows.push([`${fmt(edges[c], 1, true)} … ${fmt(edges[c + 1], 1, true)}`, ...cols]);
  }
  return [box, legend, twin(T().densityCols, rows)];
}

function histogramChart(hist, { xLabel, unit, digits = 1 }) {
  const box = h("div", { class: "plot" });
  const n = hist.counts.length, start = hist.start, step = hist.step, end = start + n * step;
  const max = maxOf(hist.counts) || 1;
  drawers.push(() => {
    const height = 220;
    const { canvas, ctx, width } = canvasIn(box, height);
    const frame = { left: 52, right: width - 10, top: 10, bottom: height - 44 };
    const sx = (v) => frame.left + (v - start) / (end - start) * (frame.right - frame.left);
    const sy = (v) => frame.bottom - v / max * (frame.bottom - frame.top);
    const span = end - start;
    const tickStep = span > 100 ? 50 : span > 20 ? 5 : span > 4 ? 1 : 0.5;
    const xTicks = [];
    for (let v = Math.ceil(start / tickStep) * tickStep; v <= end + 1e-9; v += tickStep) xTicks.push(+v.toFixed(6));
    const yStep = niceStep(max);
    const yTicks = [];
    for (let v = 0; v <= max; v += yStep) yTicks.push(v);
    axes(ctx, frame, { xTicks, yTicks, xLabel, sx, sy, xFormat: (v) => fmt(v, tickStep < 1 ? 1 : 0, true),
      yFormat: (v) => fmt(v, 0) });
    const bar = (frame.right - frame.left) / n;
    ctx.fillStyle = token("--series-1");
    hist.counts.forEach((count, i) => {
      if (!count) return;
      const x = frame.left + i * bar, y = sy(count);
      ctx.fillRect(x + (bar > 4 ? 1 : 0), y, Math.max(1, bar - (bar > 4 ? 2 : 0.5)), frame.bottom - y);
    });
    ctx.strokeStyle = token("--ink-2");
    ctx.beginPath(); ctx.moveTo(Math.round(sx(0)) + 0.5, frame.top); ctx.lineTo(Math.round(sx(0)) + 0.5, frame.bottom); ctx.stroke();
    canvas.onpointermove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - frame.left) / bar);
      if (i < 0 || i >= n) return hideTip();
      const a = start + i * step;
      showTip(e.clientX, e.clientY, [T().count(fmt(hist.counts[i], 0)),
        `${fmt(a, digits, true)} … ${fmt(a + step, digits, true)} ${unit}`]);
    };
    canvas.onpointerleave = hideTip;
  });
  const coarse = [];
  const group = Math.max(1, Math.round((step < 1 ? 0.5 : 25) / step));
  for (let i = 0; i < n; i += group) {
    coarse.push([fmt(start + i * step, digits, true), fmt(start + Math.min(n, i + group) * step, digits, true),
      fmt(hist.counts.slice(i, i + group).reduce((a, b) => a + b, 0), 0)]);
  }
  const outside = hist.below || hist.above
    ? h("p", { class: "card-note" }, T().outside(fmt(hist.below, 0), fmt(start, digits, true), fmt(hist.above, 0), fmt(end, digits, true), unit))
    : null;
  return [box, outside, twin(T().binCols, coarse)];
}

function inkOn(hex) {                       // near-black or white text, by the fill's luminance
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#0b0b0b" : "#ffffff";
}

function niceStep(max) {
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) || power;
}

function confusion(conf) {
  const t = T();
  const total = conf.counts.flat().reduce((a, b) => a + b, 0) || 1;
  return h("table", { class: "confusion" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), conf.classes.map((c) => h("th", {}, t.classNames[c])))),
    h("tbody", {}, conf.counts.map((row, i) => {
      const rowTotal = row.reduce((a, b) => a + b, 0) || 1;
      return h("tr", {}, h("th", {}, t.classNames[conf.classes[i]]), row.map((count) => {
        const share = count / rowTotal;
        const fill = sequentialColour(Math.min(0.999, share));
        return h("td", { style: `background:${fill};color:${inkOn(fill)}`,
          title: `${fmt(count, 0)} (${fmt(100 * count / total, 1)} %)` }, `${pct(share)} %`, h("small", {}, fmt(count, 0)));
      }));
    })));
}

// ------------------------------------------------------------------ the summary
function findings(d) {
  const t = T();
  const P = Object.fromEntries(d.products.map((p) => [p.key, p]));
  const sites = d.sites || [];
  const benefits = [], limits = [];
  const { sm, emodnet_sat: es, emodnet_field: field } = P;
  benefits.push(t.benefits.recent(d.years[1], sm?.years?.[1] ?? "–", es?.years?.[1] ?? "–"));
  benefits.push(t.benefits.dense(fmt(d.transects, 0)));
  const yearly = sites.map((s) => s.methods.ceva?.yearly?.rmse).filter(Number.isFinite);
  const rates = sites.map((s) => s.methods.ceva?.rates?.rmse).filter(Number.isFinite);
  if (yearly.length && rates.length) {
    benefits.push(t.benefits.checked(fmt(minOf(yearly), 0), fmt(maxOf(yearly), 0), fmt(minOf(rates), 1), fmt(maxOf(rates), 1)));
  }
  if (sm) {
    const precision = sm.by.precision.filter((r) => r.mad != null);
    if (precision.length > 1) benefits.push(t.benefits.uncertainty(fmt(precision[0].mad, 2), fmt(precision.at(-1).mad, 2)));
    benefits.push(t.benefits.consistent(pct(sm.overall.agree), pct(sm.overall.opposite)));
  }
  benefits.push(t.benefits.open);

  const tv = sites.find((s) => s.key === "trucvert");
  const landsat = (tv?.benchmark || []).filter((b) => b.sensors === "landsat");
  const others = landsat.filter((b) => !b.algorithm.startsWith("CEVA"));
  const best = others.length ? others.reduce((a, b) => (b.rmse < a.rmse ? b : a)) : null;
  const ours = landsat.find((b) => b.algorithm === "CEVA: CEVA solution");
  if (best && ours && best.rmse < ours.rmse) limits.push(t.limits.perImage(fmt(best.rmse, 0), fmt(ours.rmse, 0), fmt(best.n, 0), fmt(ours.n, 0)));
  if (field?.overlap_median != null && field.overall.agree != null) {
    limits.push(t.limits.before1984(pct(field.overlap_median), pct(field.overall.agree)));
  }
  if (es) limits.push(t.limits.short(pct(es.overall.agree), pct(es.overall.in_ci)));
  if (sm) {
    const types = sm.by.coastal_type.filter((r) => r.mad != null && t.coastNames[r.key]);
    if (types.length > 1) {
      const worst = types.reduce((a, b) => (b.mad > a.mad ? b : a)), bestType = types.reduce((a, b) => (b.mad < a.mad ? b : a));
      limits.push(t.limits.hard(t.coastNames[worst.key], fmt(worst.mad, 2), t.coastNames[bestType.key], fmt(bestType.mad, 2)));
    }
  }
  const pp = sites.find((s) => s.key === "perranporth");
  if (pp?.methods.ceva?.yearly) limits.push(t.limits.macrotidal(fmt(pp.methods.ceva.yearly.rmse, 0)));
  limits.push(t.limits.scope);
  return { benefits, limits };
}

// ------------------------------------------------------------------ sections
function sitesSection(d) {
  const t = T();
  const sites = d.sites || [];
  if (!sites.length) return null;
  const series = [{ key: "ceva", name: t.methodsLegend.ceva, token: "--series-1" },
    { key: "coastsat", name: t.methodsLegend.coastsat, token: "--series-2" }];
  const groups = (metric) => sites.map((s) => ({ label: s.title, note: t.surveyYears(...s.survey_years),
    values: Object.fromEntries(Object.entries(s.methods).map(([k, m]) => [k, m[metric]?.rmse ?? null])) }));
  const benches = sites.filter((s) => s.benchmark?.length).flatMap((s) => ["landsat", "sentinel2"].map((sensor) => {
    const rows = s.benchmark.filter((b) => b.sensors === sensor).sort((a, b) => a.rmse - b.rmse);
    if (!rows.length) return null;
    const top = maxOf(rows.map((r) => r.rmse));
    return card(`${s.title} · ${t.sensors[sensor]}`, t.benchUnit, h("div", { class: "bars" }, rows.map((r) => {
      const ours = r.algorithm.startsWith("CEVA");
      const name = t.benchNames[r.algorithm] || r.algorithm;
      const lines = [`${fmt(r.rmse, 1)} m`, name, t.images(fmt(r.n, 0))];
      return h("div", { class: `bar-row${ours ? " ours" : ""}`, tabindex: "0",
        onpointermove: (e) => showTip(e.clientX, e.clientY, lines), onpointerleave: hideTip },
      h("span", { class: "bar-label" }, name),
      h("span", { class: "bar-track" }, h("span", { class: "bar-fill", style: `width:${100 * r.rmse / top}%;background:var(${ours ? "--series-1" : "--quiet"})` }),
        h("span", { class: "bar-value" }, `${fmt(r.rmse, 0)} m`)),
      h("span", { class: "bar-n" }, fmt(r.n, 0)));
    })));
  })).filter(Boolean);
  const head = ["", ...series.flatMap((s) => [`${s.name} (${t.yearlyShort})`, `${s.name} (${t.ratesShort})`])];
  const rows = sites.map((s) => [s.title, ...series.flatMap((x) => [fmt(s.methods[x.key]?.yearly?.rmse, 1), fmt(s.methods[x.key]?.rates?.rmse, 2)])]);
  return h("section", { id: "sites" }, h("h2", {}, t.sitesTitle), h("p", { class: "intro" }, t.sitesIntro),
    h("div", { class: "grid2" },
      card(t.yearlyTitle, t.yearlyUnit, pairedBars(groups("yearly"), series, (v) => v == null ? "–" : `${fmt(v, 0)} m`)),
      card(t.ratesTitle, t.ratesUnit, pairedBars(groups("rates"), series, (v) => v == null ? "–" : `${fmt(v, 2)} ${t.rateUnit}`))),
    twin(head, rows),
    benches.length ? h("h3", {}, t.benchTitle(sites.filter((s) => s.benchmark?.length).map((s) => s.title).join(" & "))) : null,
    benches.length ? h("p", { class: "note" }, t.benchNote) : null,
    h("div", { class: "grid2" }, benches));
}

const MIN_GROUP = 30;                       // smaller groups stay in the table, without a bar

function groupCard(all, key, rated) {
  const t = T();
  const rows = (all || []).filter((r) => (rated ? r.n : r.n_cls) >= MIN_GROUP);
  if (!rows.length) return null;
  const label = (r) => key === "built" || key === "defence" ? t.flags[r.key] || r.key
    : key === "precision" ? t.precisionLabels[r.key] || r.key
      : key === "coastal_type" ? t.coastNames[r.key] || r.key : r.key;
  const content = rated
    ? barList(rows, { value: "mad", label, format: (v) => v == null ? "–" : `${fmt(v, 2)} ${t.rateUnit}` })
    : barList(rows, { value: "agree", label, format: (v) => v == null ? "–" : `${pct(v)} %`, max: 1 });
  return card(rated ? t.byTitle[key] : t.agreeBy[key], null, content,
    twin([t.tableCols.key, t.tableCols.n, t.tableCols.bias, t.tableCols.mad, t.tableCols.agree],
      all.map((r) => [label(r), fmt(r.n || r.n_cls, 0), fmt(r.bias, 2, true), fmt(r.mad, 2), `${pct(r.agree)} %`])));
}

function productSection(p) {
  const t = T();
  const text = t.products[p.key] || { name: p.product.name, about: p.product.method };
  const o = p.overall;
  const rated = o.n > 0;
  let reading = null;
  if (p.key === "sm" && p.offset) {
    reading = t.read.sm(fmt(o.mad, 2), o.bias < 0 ? t.more : t.lessRetreat, fmt(Math.abs(p.offset.median), 0),
      p.offset.median < 0 ? t.landward : t.seaward);
  } else if (p.key === "emodnet_sat") reading = t.read.emodnet_sat(pct(o.in_ci));
  else if (p.key === "emodnet_field") reading = t.read.emodnet_field(pct(p.overlap_median), fmt(p.no_period, 0));
  const by = p.by;
  const unit = t.rateUnit;
  return h("section", { class: "product", id: p.key },
    h("h3", {}, h("i", { class: "swatch", style: `background:var(${REF_TOKENS[p.key]})` }), text.name),
    h("p", { class: "about" }, text.about, " ", h("a", { href: p.product.url, rel: "noopener" }, p.product.licence)),
    reading ? h("p", { class: "read" }, reading) : null,
    tiles([
      [rated ? t.tiles.n : t.tiles.nCls, fmt(rated ? o.n : o.n_cls, 0), p.ceva_years ? `${p.ceva_years[0]}–${p.ceva_years[1]}` : null],
      rated ? [t.tiles.bias, `${fmt(o.bias, 2, true)} ${unit}`, t.tiles.biasNote] : null,
      rated ? [t.tiles.mad, `${fmt(o.mad, 2)} ${unit}`, t.tiles.madNote] : null,
      rated ? [t.tiles.within, `${pct(o.within_05)} %`, null] : null,
      o.agree != null ? [t.tiles.agree, `${pct(o.agree)} %`, t.tiles.agreeNote(fmt(o.kappa, 2))] : null,
    ]),
    rated ? h("div", { class: "grid2" },
      card(t.densityTitle, t.densityNote(fmt(p.density.outside, 0)), ...densityChart(p.density)),
      card(t.diffTitle, t.diffNote, ...histogramChart(p.difference, { xLabel: t.diffX, unit: t.rateUnit }))) : null,
    h("div", { class: "grid2" },
      groupCard(by.country, "country", rated), groupCard(by.coastal_type, "coastal_type", rated),
      groupCard(by.precision, "precision", rated),
      groupCard(by.defence, "defence", rated), groupCard(by.built, "built", rated),
      card(t.confusionTitle, t.confusionNote, confusion(p.confusion)),
      p.offset ? card(t.offsetTitle, t.offsetNote, ...histogramChart(p.offset, { xLabel: t.offsetX, unit: "m", digits: 0 })) : null),
    p.examples?.length ? h("details", { class: "examples" }, h("summary", {}, t.examplesTitle),
      h("table", {}, h("thead", {}, h("tr", {}, t.examplesCols.map((c) => h("th", {}, c)))),
        h("tbody", {}, p.examples.map((e) => h("tr", {},
          h("td", {}, h("a", { href: `./?t=${encodeURIComponent(e.id)}&u=${encodeURIComponent(e.unit)}` }, e.id)),
          h("td", {}, e.cn || "–"), h("td", {}, fmt(e.rate, 2, true)), h("td", {}, fmt(e.ceva, 2, true)),
          h("td", {}, fmt(e.diff, 2, true))))))) : null);
}

function sourcesSection(d) {
  const t = T();
  const items = d.products.map((p) => h("li", {}, `${p.product.name} (${p.product.provider}), ${p.product.citation}. `,
    h("a", { href: p.product.url, rel: "noopener" }, p.product.licence)));
  const surveys = (d.sites || []).map((s) => h("li", {}, `${t.surveysBy}, ${s.title}: ${s.attribution}`));
  return h("section", { id: "sources" }, h("h2", {}, t.sourcesTitle), h("ul", {}, items, surveys),
    state.manifest ? h("ul", {}, state.manifest.attribution.map((a) => h("li", {}, a))) : null);
}

function render() {
  const t = T(), d = state.data;
  document.documentElement.lang = locale(state.lang);
  document.documentElement.dir = direction(state.lang);
  document.title = `CEVA · ${t.pageTitle}`;
  $("title").textContent = t.pageTitle;
  $("back").textContent = `← ${t.back}`;
  fillLanguagePicker($("lang"), state.lang);
  $("lang").setAttribute("aria-label", t.language);
  drawers.length = 0;
  const main = $("report");
  if (!d) return;
  const { benefits, limits } = findings(d);
  const status = d.provisional
    ? h("p", { class: "banner" }, t.provisional(fmt(d.run.finished, 0), fmt(d.run.planned, 0), fmt(d.transects, 0)))
    : h("p", { class: "note" }, t.complete(d.generated.slice(0, 10), fmt(d.transects, 0)));
  main.replaceChildren(
    status,
    h("p", { class: "lede" }, t.lede),
    h("section", { id: "short" }, h("h2", {}, t.inShort), h("div", { class: "grid2" },
      h("div", { class: "verdict good" }, h("h3", {}, t.benefitsTitle), h("ul", {}, benefits.map((b) => h("li", { html: b })))),
      h("div", { class: "verdict limits" }, h("h3", {}, t.limitsTitle), h("ul", {}, limits.map((b) => h("li", { html: b })))))),
    sitesSection(d),
    h("section", { id: "products" }, h("h2", {}, t.productsTitle), h("p", { class: "intro" }, t.productsIntro),
      d.products.map(productSection)),
    h("section", { id: "method" }, h("h2", {}, t.methodTitle), h("ul", {}, t.method.map((m) => h("li", { html: m })))),
    sourcesSection(d),
    h("p", { class: "note footer" }, t.footer));
  requestAnimationFrame(() => drawers.forEach((draw) => draw()));
}

async function getJSON(name) {
  const response = await fetch(DATA + name, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

$("lang").addEventListener("change", async (event) => {
  state.text = await loadText("report", event.target.value);
  state.lang = event.target.value;
  keepLanguage(state.lang);
  render();
});
let resizing = null;
window.addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => drawers.forEach((draw) => draw()), 150); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawers.forEach((draw) => draw()));

(async () => {
  state.text = await loadText("report", state.lang);
  render();
  try {
    [state.data, state.manifest] = await Promise.all([getJSON("validation.json"), getJSON("manifest.json")]);
  } catch (error) {
    $("report").textContent = `Could not read the validation data: ${error.message}`;
    return;
  }
  render();
  window.cevaReport = { state };           // for the browser console and the tests
})();
