// A country's profile, opened from the summary by country: how its coast has changed since the first year,
// where, and how far to trust the numbers there (field surveys, precision, agreement with other products).
// Built from stats.json (every transect's rate, class and type) and validation.json, both already published.

const SVG = "http://www.w3.org/2000/svg";
const MIN_GROUP = 30;                         // smaller groups are too few to compare
const PRECISION_COLOURS = ["#fde0c5", "#f59e72", "#d1495b", "#6a1b4d"];     // as the map's precision colours
const LIMIT = 300, STEP = 10;                 // the rate chart: -3 to +3 m/yr in 0.1 m/yr bins (rates in cm/yr)
const COAST_ORDER = ["dune", "sediment_plain", "wetland", "inlet", "moderately_sloped", "cliffed_or_steep",
  "bedrock_plain", "engineered_structures"];

// A DOM element; "html" is only ever given our own text, never data.
function h(tag, props = {}, ...children) {
  const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
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

const tip = h("div", { class: "tip", role: "status" });
document.body.append(tip);
function showTip(x, y, lines) {
  const host = document.querySelector("dialog[open]") || document.body;     // a modal dialog hides what is outside it
  if (tip.parentNode !== host) host.append(tip);
  tip.replaceChildren(...lines.map((line, i) => h(i ? "span" : "strong", {}, line)));
  tip.style.display = "block";
  const { width, height } = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - width - 8))}px`;
  tip.style.top = `${Math.max(8, y - height - 10)}px`;
}
const hideTip = () => { tip.style.display = "none"; };
const hover = (lines) => ({
  tabindex: "0", onpointermove: (e) => showTip(e.clientX, e.clientY, lines()), onpointerleave: hideTip,
  onfocus: (e) => { const b = e.target.getBoundingClientRect(); showTip(b.left + b.width / 2, b.top, lines()); },
  onblur: hideTip,
});

// ------------------------------------------------------------------ the figures
function tally(ctx, groups) {
  const { keys, col } = ctx;
  const out = { ...ctx.aggregate(groups), precision: [0, 0, 0, 0], fast: 0, bins: new Array(2 * LIMIT / STEP).fill(0),
    below: 0, above: 0 };
  for (const g of groups) {
    out.precision[g[col.prec]] += g[col.n];
    for (const r of g[col.rates]) {
      if (Math.abs(r) >= 100) out.fast += 1;
      if (r < -LIMIT) out.below += 1;
      else if (r >= LIMIT) out.above += 1;
      else out.bins[Math.floor((r + LIMIT) / STEP)] += 1;
    }
  }
  out.count = out.rates.reduce((sum, list) => sum + list.length, 0);
  out.median = ctx.median(out.rates);
  out.where = (test) => ctx.aggregate(groups.filter(test));
  out.keys = keys;
  return out;
}

function classOfRate(cm, side) {               // the class colour of a bin's centre (|rate| < 3 m/yr)
  const a = Math.abs(cm);
  if (a < 50) return "stable";
  const kind = a < 100 ? "" : "intense_";
  return kind + (side < 0 ? "erosion" : "accretion");
}

// ------------------------------------------------------------------ building blocks
function stack(rows, parts, colours, tipOf) {
  return h("div", { class: "stack-rows" }, rows.map((row) => h("div", { class: "stack-row" },
    h("span", { class: "stack-label" }, row.label),
    h("div", { class: "bar" }, parts.map((part, i) => {
      const value = row.values[i];
      return value > 0 ? h("div", { style: `width:${100 * value}%;background:${colours[i]}`,
        ...hover(() => tipOf(row, i)) }) : null;
    })))));
}

function legend(items) {
  return h("div", { class: "legend profile-legend" }, items.map(([colour, label]) =>
    h("span", {}, h("i", { style: `background:${colour}` }), label)));
}

function rateChart(ctx, f) {
  const P = ctx.text.profile, n = f.count || 1;
  const W = 640, H = 210, L = 40, R = 8, T = 12, B = 38;
  const slots = 2 * LIMIT / STEP + 6, slot = (W - L - R) / slots;
  const x0 = L + 3 * slot;                        // the first bin of -3 m/yr; the far bins sit outside, apart
  const xOf = (cm) => x0 + (cm + LIMIT) / STEP * slot;
  const shares = [f.below / n, ...f.bins.map((c) => c / n), f.above / n];
  const top = niceTop(Math.max(...shares));
  const y = (s) => T + (1 - s / top) * (H - T - B);
  const out = [];
  [0, top / 2, top].forEach((s) => {
    out.push(h("svg:line", { x1: L, x2: W - R, y1: y(s), y2: y(s), class: "grid" }));
    out.push(h("svg:text", { x: L - 6, y: y(s) + 4, "text-anchor": "end" }, ctx.percent(s)));
  });
  const bar = (x, w, count, colour, lines) => {
    const g = h("svg:g", { class: "bin", ...hover(lines) });
    g.append(h("svg:rect", { x, y: T, width: w, height: H - T - B, class: "hit" }));
    if (count) g.append(h("svg:rect", { x: x + 0.5, y: y(count / n), width: Math.max(w - 1, 1), height: H - B - y(count / n),
      fill: colour }));
    return g;
  };
  const tipFor = (label, count) => () => [label, P.transects(ctx.fmt(count, 0), ctx.percent(count / n))];
  out.push(bar(L, 2 * slot, f.below, ctx.colours.severe_erosion,
    tipFor(P.beyondRetreat(ctx.fmt(LIMIT / 100, 0)), f.below)));
  f.bins.forEach((count, i) => {
    const lo = -LIMIT + i * STEP;
    out.push(bar(xOf(lo), slot, count, ctx.colours[classOfRate(lo + STEP / 2, lo + STEP / 2)],
      tipFor(P.between(ctx.fmt(lo / 100, 1, true), ctx.fmt((lo + STEP) / 100, 1, true)), count)));
  });
  out.push(bar(xOf(LIMIT) + slot, 2 * slot, f.above, ctx.colours.severe_accretion,
    tipFor(P.beyondAdvance(ctx.fmt(LIMIT / 100, 0)), f.above)));
  out.push(h("svg:line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "axis" }));
  for (let v = -2; v <= 2; v += 1) {                // ±3 is where the far bins start: they carry the label
    out.push(h("svg:text", { x: xOf(v * 100), y: H - B + 15, "text-anchor": "middle" }, ctx.fmt(v, 0, true)));
  }
  out.push(h("svg:text", { x: L + slot, y: H - B + 15, "text-anchor": "middle" }, `< ${ctx.fmt(-LIMIT / 100, 0)}`));
  out.push(h("svg:text", { x: xOf(LIMIT) + 2 * slot, y: H - B + 15, "text-anchor": "middle" }, `> ${ctx.fmt(LIMIT / 100, 0, true)}`));
  out.push(h("svg:text", { x: xOf(0), y: H - 4, "text-anchor": "middle", class: "axis-title" }, P.rateAxis));
  if (f.median != null && Math.abs(f.median) < LIMIT / 100) {
    const xm = xOf(f.median * 100);
    out.push(h("svg:line", { x1: xm, x2: xm, y1: T - 2, y2: H - B, class: "median" }));
    out.push(h("svg:text", { x: xm + (f.median < 0 ? -4 : 4), y: T + 8, "text-anchor": f.median < 0 ? "end" : "start",
      class: "median-label" }, P.median(ctx.fmt(f.median, 2, true))));
  }
  return h("svg:svg", { viewBox: `0 0 ${W} ${H}`, class: "rate-chart", role: "img", "aria-label": P.rateNote }, out);
}

function niceTop(value) {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
  return steps.find((s) => s >= value) || 1;
}

function diverging(ctx, title, rows) {
  const P = ctx.text.profile, cols = ctx.text.countryCols;
  const kept = rows.filter((r) => r.figures.rated >= MIN_GROUP);
  if (!kept.length) return null;
  const share = (r, k) => r.figures[k] / r.figures.rated;
  const top = Math.max(...kept.flatMap((r) => [share(r, "ero"), share(r, "acc")]), 0.01);
  const side = (r, k, colour) => h("span", { class: `dv-side dv-${k}`, ...hover(() => [r.label,
    `${k === "ero" ? cols.ero : cols.acc}: ${ctx.percent(share(r, k))}`, P.transects(ctx.fmt(r.figures[k], 0),
      ctx.percent(share(r, k)))]) },
  h("i", { style: `width:${78 * share(r, k) / top}%;background:${colour}` }), h("b", {}, ctx.percent(share(r, k))));
  return h("div", { class: "diverge" },
    h("div", { class: "dv-row dv-head" }, h("span", { class: "dv-label" }, title),
      h("span", { class: "dv-side dv-ero" }, cols.ero), h("span", { class: "dv-side dv-acc" }, cols.acc),
      h("span", { class: "dv-n" }, cols.n)),
    kept.map((r) => h("div", { class: "dv-row" }, h("span", { class: "dv-label" }, r.label),
      side(r, "ero", ctx.colours.intense_erosion), side(r, "acc", ctx.colours.intense_accretion),
      h("span", { class: "dv-n" }, ctx.fmt(r.figures.n, 0)))));
}

function agreement(ctx, product, here) {
  const P = ctx.text.profile;
  const name = ctx.text.refNames[product.key] || product.product.name;
  const years = Array.isArray(product.years) && product.years.length === 2 ? ` · ${product.years[0]}–${product.years[1]}` : "";
  const head = h("div", { class: "agree-head" }, h("strong", {}, name + years));
  if (!here) return h("div", { class: "agree" }, head, h("p", { class: "note" }, P.notCovered));
  if ((here.n_cls ?? 0) < MIN_GROUP) return h("div", { class: "agree" }, head, h("p", { class: "note" }, P.tooFew));
  head.append(h("span", { class: "note" }, P.inCommon(ctx.fmt(here.n_cls, 0))));
  const all = product.overall;
  const metrics = [["agree", P.sameClass], ["within_05", P.within], ["opposite", P.opposite]]
    .filter(([k]) => here[k] != null && all[k] != null);
  return h("div", { class: "agree" }, head, metrics.map(([k, label]) => h("div", { class: "agree-row",
    ...hover(() => [label, `${ctx.country}: ${ctx.percent(here[k])}`, P.europeValue(ctx.percent(all[k]))]) },
  h("span", { class: "agree-label" }, label),
  h("span", { class: "agree-track" }, h("i", { class: "agree-fill", style: `width:${100 * here[k]}%` }),
    h("i", { class: "agree-europe", style: `left:${100 * all[k]}%` })),
  h("span", { class: "agree-value" }, h("b", {}, ctx.percent(here[k])), " ", h("small", {}, P.europeValue(ctx.percent(all[k])))))));
}

// ------------------------------------------------------------------ the profile
export function renderProfile(box, ctx) {
  const T = ctx.text, P = T.profile, { keys, col } = ctx;
  const mine = ctx.groups.filter((g) => keys.cc[g[col.cc]] === ctx.code);
  const here = tally(ctx, mine), europe = tally(ctx, ctx.groups);
  const [y0, y1] = ctx.years;
  const rated = (f) => f.rated || 1;

  const nav = h("div", { class: "profile-nav" },
    h("button", { class: "ghost back", type: "button", onclick: ctx.onBack }, P.back),
    h("button", { class: "images-link", type: "button", onclick: ctx.onMap }, P.showOnMap));
  const lead = h("div", { class: "profile-lead" },
    h("p", { class: "eyebrow" }, P.sub(ctx.fmt(here.n, 0), ctx.fmt(roughly(here.n / 10), 0), y0, y1)),
    h("h2", {}, ctx.country),
    h("p", { class: "headline" }, P.summary(ctx.percent(here.ero / rated(here)), ctx.percent(here.acc / rated(here)), y0)),
    h("p", {}, P.typical(ctx.fmt(here.median, 2, true), ctx.percent(here.fast / (here.count || 1))), " ",
      P.europe(ctx.percent(europe.ero / rated(europe)), ctx.percent(europe.acc / rated(europe)),
        ctx.fmt(europe.median, 2, true))));

  // how the coast has changed
  const classes = ctx.classes.filter((k) => k !== "insufficient_data");
  const classShares = (f) => classes.map((k) => (f.classes[k] || 0) / rated(f));
  const classRows = [{ label: ctx.country, values: classShares(here), f: here },
    { label: P.europeRow, values: classShares(europe), f: europe }];
  const changed = h("section", { class: "profile-section" },
    h("h3", {}, P.changeTitle),
    h("p", { class: "note" }, P.classesNote),
    stack(classRows, classes, classes.map((k) => ctx.colours[k]), (row, i) => [T.classes[classes[i]],
      `${row.label}: ${ctx.percent(row.values[i])}`, T.classRanges[classes[i]]]),
    legend(classes.map((k) => [ctx.colours[k], T.classes[k]])),
    h("details", { class: "twin" }, h("summary", {}, P.table),
      h("table", {}, h("thead", {}, h("tr", {}, [T.countryCols.bar, P.rateCol, ctx.country, P.europeRow].map((c) => h("th", {}, c)))),
        h("tbody", {}, classes.map((k, i) => h("tr", {}, h("td", {}, T.classes[k]), h("td", {}, T.classRanges[k]),
          h("td", { class: "num" }, ctx.percent(classRows[0].values[i])), h("td", { class: "num" }, ctx.percent(classRows[1].values[i]))))))),
    h("h4", {}, P.rateTitle),
    rateChart(ctx, here),
    h("p", { class: "note" }, P.rateNote));

  // where it happens
  const present = new Set(mine.map((g) => keys.coast[g[col.coast]]));
  const coastRows = COAST_ORDER.filter((k) => present.has(k)).map((k) => ({ label: cap(ctx, T.coasts[k] || k),
    figures: here.where((g) => keys.coast[g[col.coast]] === k) }));
  const shoreRows = [
    ["natural", (g) => g[col.built] === 0 && g[col.def] === 0], ["built", (g) => g[col.built] === 1],
    ["defended", (g) => g[col.def] === 1],
  ].map(([k, test]) => ({ label: T.shoreOptions[k], figures: here.where(test) }));
  const where = h("section", { class: "profile-section" },
    h("h3", {}, P.whereTitle),
    h("p", { class: "note" }, P.whereNote(ctx.fmt(MIN_GROUP, 0))),
    diverging(ctx, T.coastType, coastRows),
    diverging(ctx, T.shoreFilter, shoreRows));

  // how vulnerable the coast is (summary.json), here and across the whole coast published
  const vHere = ctx.summary.countries[ctx.code]?.vulnerability, vAll = ctx.summary.all?.vulnerability;
  let vulnerable = null;
  if (ctx.cvi && vHere?.known && vAll?.known) {
    const V = T.vulnerability, colours = ctx.cvi.colours;
    const shares = (b) => b.classes.map((c) => c / b.known);
    const rows = [{ label: ctx.country, values: shares(vHere), b: vHere }, { label: P.europeRow, values: shares(vAll), b: vAll }];
    const high = (row) => row.values[2] + row.values[3];
    vulnerable = h("section", { class: "profile-section" },
      h("h3", {}, V.title),
      h("p", {}, V.profileLead(ctx.percent(high(rows[0])), ctx.percent(high(rows[1])), ctx.fmt(vHere.median, 1),
        ctx.fmt(vAll.median, 1))),
      stack(rows, colours, colours, (row, i) => [V.classes[i], `${row.label}: ${ctx.percent(row.values[i])}`,
        P.transects(ctx.fmt(row.b.classes[i], 0), ctx.percent(row.values[i]))]),
      legend(colours.map((c, i) => [c, V.classes[i]])),
      h("details", { class: "twin" }, h("summary", {}, P.table),
        h("table", {}, h("thead", {}, h("tr", {}, ["", ctx.country, P.europeRow].map((c) => h("th", {}, c)))),
          h("tbody", {}, colours.map((_, i) => h("tr", {}, h("td", {}, V.classes[i]),
            h("td", { class: "num" }, ctx.percent(rows[0].values[i])), h("td", { class: "num" }, ctx.percent(rows[1].values[i]))))))),
      h("p", { class: "note" }, V.profileNote));
  }

  // how far to trust the numbers here
  const trust = h("section", { class: "profile-section" }, h("h3", {}, P.trustTitle), h("p", {}, P.trustIntro));
  const v = ctx.validation;
  const quality = ctx.quality;
  const sites = v?.sites?.filter((s) => siteCountry(s, ctx.summary) === ctx.code) || [];
  trust.append(h("h4", {}, P.surveysTitle));
  if (sites.length) {
    trust.append(h("ul", { class: "surveys" }, sites.map((s) => {
      const m = s.methods?.ceva || {};
      const span = m.rates ? `${m.rates.first_year}–${m.rates.last_year}` : "";
      return h("li", {}, P.surveyLine(s.title.split(",")[0], span, ctx.fmt(m.yearly?.rmse, 0), ctx.fmt(m.rates?.rmse, 1)));
    })));
  } else if (quality) {
    trust.append(h("p", {}, P.surveysNone(ctx.fmt(quality.sites, 0), ctx.fmt(quality.yearly_rmse[0], 0),
      ctx.fmt(quality.yearly_rmse[1], 0), ctx.fmt(quality.rate_rmse[0], 1), ctx.fmt(quality.rate_rmse[1], 1))));
  }
  if (ctx.validationPage) trust.append(h("p", { class: "note" }, h("a", { href: "validation.html" }, T.howCompares)));

  const precisionRows = [{ label: ctx.country, values: here.precision.map((c) => c / (here.n || 1)), f: here },
    { label: P.europeRow, values: europe.precision.map((c) => c / (europe.n || 1)), f: europe }];
  const under10 = (row) => row.values[0] + row.values[1];
  trust.append(h("h4", {}, P.precisionTitle),
    h("p", {}, P.precisionLead(ctx.percent(under10(precisionRows[0])), ctx.percent(under10(precisionRows[1])))),
    stack(precisionRows, PRECISION_COLOURS, PRECISION_COLOURS, (row, i) => [T.precisionOptions[i],
      `${row.label}: ${ctx.percent(row.values[i])}`, P.transects(ctx.fmt(row.f.precision[i], 0), ctx.percent(row.values[i]))]),
    legend(PRECISION_COLOURS.map((c, i) => [c, T.precisionOptions[i]])),
    h("p", { class: "note" }, P.precisionNote));

  trust.append(h("h4", {}, P.agreementTitle), h("p", { class: "note" }, P.agreementNote));
  if (v === "loading") trust.append(h("p", { class: "note" }, P.loading));
  else if (v?.products) {
    const english = ctx.summary.countries[ctx.code]?.name;
    trust.append(h("div", { class: "agree-key" }, h("span", {}, h("i", { class: "agree-fill" }), ctx.country),
      h("span", {}, h("i", { class: "agree-europe" }), P.europeRow)));
    v.products.forEach((p) => trust.append(agreement(ctx, p, p.by?.country?.find((c) => c.key === english))));
  }

  box.replaceChildren(...[nav, lead, changed, where, vulnerable, trust].filter(Boolean));
}

// A length in km to two significant figures (transects are 100 m apart: 25,022 transects, about 2,500 km).
const roughly = (km) => { const unit = km < 100 ? 1 : 10 ** (Math.floor(Math.log10(km)) - 1); return Math.round(km / unit) * unit; };

const cap = (ctx, text) => text ? text.charAt(0).toLocaleUpperCase(ctx.locale) + text.slice(1) : text;

// A survey site's country, from the English country name that ends its title ("Truc Vert, France").
function siteCountry(site, summary) {
  const place = site.title.split(",").at(-1).trim().replace(/^the /, "");
  return Object.entries(summary.countries).find(([, c]) => c.name === place)?.[0] || null;
}
