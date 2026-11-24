// Satellite image viewer, one 2 km segment of coast at a time, read with HTTP range requests from a ZIP
// archive (see `ceva frames`). Over each image: the detected waterline, the shoreline after the tide and
// wave correction, and the year's position. A segment's images are one H.264 video, image i at i / fps
// seconds; seeking to the middle of an image's time lands on that exact image.
// Used by the map's card (app.js) and by the full-page viewer (frames.js).

// Magenta for the detected waterline (no beach is magenta), red for the corrected shoreline (dashed vs
// solid, for colour-blind readers), near-black for the year's position. Each line has a thin casing so it
// shows on sand and on water.
export const LINE_COLOURS = { obs: "#e026d4", corr: "#ff3b3b", year: "#1b1f24" };

// "Every year": every year's position at once, coloured by year with matplotlib's plasma colour map
// (CC0), dark blue for the first year to yellow for the last. The range is fixed, so a colour is the same
// year on every segment.
export const HISTORY_STOPS = ["#0d0887", "#2a0593", "#41049d", "#5601a4", "#6a00a8", "#7e03a8", "#8f0da4", "#a11b9b",
  "#b12a90", "#bf3984", "#cc4778", "#d6556d", "#e16462", "#ea7457", "#f2844b", "#f89540", "#fca636", "#feba2c",
  "#fcce25", "#f7e425", "#f0f921"];
export const HISTORY_YEARS = [1984, 2025];
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function yearColour(year, [first, last] = HISTORY_YEARS, stops = HISTORY_STOPS) {
  const n = stops.length - 1;
  const t = Math.max(0, Math.min(1, (year - first) / (last - first || 1))) * n;
  const k = Math.min(Math.floor(t), n - 1), f = t - k;
  const a = hexRgb(stops[k]), b = hexRgb(stops[k + 1]);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
}
const HOVER_PX = 8;                       // pointing within this many screen pixels of a year's line names it
function toSegment([px, py], [x0, y0], [x1, y1]) {      // the distance from a point to a segment
  const dx = x1 - x0, dy = y1 - y0, len = dx * dx + dy * dy;
  const u = len ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len)) : 0;
  return Math.hypot(px - (x0 + u * dx), py - (y0 + u * dy));
}
const BREAK_M = 250;                      // a year's line breaks where neighbouring positions are further apart
const SCALE = 4;                          // canvas pixels per image pixel
const SVG = "http://www.w3.org/2000/svg";

// ------------------------------------------------------------------ the archive
// Two layouts of the index (ceva frames): one file listing every segment of one archive (v1), or, for
// many units, index.json listing the units (v2) and units/<unit>.json their segments, each segment
// naming its archive (one per country). A unit's index is fetched only when one of its transects is opened.
export class ImageArchive {
  constructor(indexUrl) {
    this.indexUrl = new URL(indexUrl, document.baseURI).href;
    this.index = null;
    this.cache = new Map();
    this.units = new Map();
  }

  async load() {
    if (!this.index) {
      const response = await fetch(this.indexUrl, { cache: "no-cache" });
      if (!response.ok) throw new Error(`${response.status} for the image index`);
      this.index = await response.json();
      if (this.index.segments) {
        this.url = this.index.url || new URL(this.index.archive, this.indexUrl).href;
        this.byTransect = new Map(this.index.segments.flatMap((s) => (s.transects || []).map((t) => [t, s])));
      }
    }
    return this.index;
  }

  // The areas (units or survey sites) with images: [{name, label}].
  areas() {
    if (this.index.units) {
      return Object.entries(this.index.units).map(([name, u]) => ({ name, label: u.label || name, country: u.country }));
    }
    const seen = new Map();
    this.index.segments.forEach((s) => { if (!seen.has(s.area)) seen.set(s.area, { name: s.area, label: s.label || s.area }); });
    return [...seen.values()];
  }

  async unit(name) {
    if (!this.units.has(name)) {
      const url = new URL(`units/${encodeURIComponent(name)}.json`, this.indexUrl);
      this.units.set(name, fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { segments: [] }))
        .then((u) => ({ ...u, byTransect: new Map(u.segments.flatMap((s) => (s.transects || []).map((t) => [t, s]))) })));
    }
    return this.units.get(name);
  }

  async segmentsOf(area) {
    await this.load();
    if (this.index.segments) return this.index.segments.filter((s) => s.area === area);
    return this.index.units?.[area] ? (await this.unit(area)).segments : [];
  }

  // The segment holding a transect of a unit, or null where there are no images.
  async find(unit, transectId) {
    await this.load();
    if (this.index.segments) return this.byTransect.get(String(transectId)) || null;
    if (!this.index.units?.[unit]) return null;
    return (await this.unit(unit)).byTransect.get(String(transectId)) || null;
  }

  urlOf(seg) { return seg.archive ? new URL(seg.archive, this.indexUrl).href : this.url; }

  async bytes(seg, [start, size]) {
    const response = await fetch(this.urlOf(seg), { headers: { Range: `bytes=${start}-${start + size - 1}` } });
    if (!response.ok) throw new Error(`${response.status} reading the image archive`);
    const buffer = await response.arrayBuffer();
    return response.status === 206 ? buffer : buffer.slice(start, start + size);   // a server without ranges
  }

  // The segment's description (lines, times) and its video, kept for the last few segments opened.
  open(seg) {
    if (!this.cache.has(seg.name)) {
      const job = (async () => {
        const meta = JSON.parse(new TextDecoder().decode(await this.bytes(seg, seg.files[`${seg.name}.json`])));
        const video = await this.bytes(seg, seg.files[meta.video]);
        return { meta, videoUrl: URL.createObjectURL(new Blob([video], { type: "video/mp4" })) };
      })();
      job.catch(() => this.cache.delete(seg.name));
      this.cache.set(seg.name, job);
      if (this.cache.size > 4) {
        const [oldest, old] = this.cache.entries().next().value;
        this.cache.delete(oldest);
        old.then((o) => URL.revokeObjectURL(o.videoUrl)).catch(() => {});
      }
    }
    return this.cache.get(seg.name);
  }
}

// ------------------------------------------------------------------ the viewer
const fractionalYear = (iso) => {
  const t = Date.parse(`${iso}:00Z`), y = new Date(t).getUTCFullYear();
  const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
  return y + (t - start) / (end - start);
};

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => { if (k === "class") node.className = v; else node.setAttribute(k, v); });
  node.append(...children);
  return node;
}

export class ImageViewer {
  // root: where the viewer is drawn. options: text (the viewer's strings), fmt (number formatting),
  // map (a MapLibre map to draw the frame on), beforeLayer (the frame goes under this layer),
  // onChange(frame) after each image or transect change, onPick(transectId) when a transect is clicked,
  // years: [first, last] of the colours of "every year", palette: their colour stops.
  constructor(root, { text, fmt, map = null, beforeLayer, onChange, onPick, years = HISTORY_YEARS, palette = HISTORY_STOPS } = {}) {
    Object.assign(this, { root, fmt: fmt || ((v, d = 1) => v.toFixed(d)), map, beforeLayer, onChange, onPick, yearRange: years,
      stops: palette });
    this.seg = null; this.meta = null; this.frame = 0; this.transect = 0; this.playing = false;
    this.mode = "all"; this.delay = 100; this.busy = null; this.history = false;
    this.video = element("video", { muted: "", playsinline: "", preload: "auto" });
    this.video.muted = true;
    this.canvas = element("canvas", { class: "iv-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.setAttribute("class", "iv-lines");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.caption = element("p", { class: "iv-caption", "aria-live": "polite" });
    this.prev = element("button", { class: "iv-button", type: "button" }, "◀");
    this.play = element("button", { class: "iv-button", type: "button" }, "▶");
    this.next = element("button", { class: "iv-button", type: "button" }, "▶︎|");
    this.slider = element("input", { class: "iv-slider", type: "range", min: "0", max: "0", value: "0" });
    this.modeSelect = element("select", { class: "iv-select" });
    this.speedSelect = element("select", { class: "iv-select" });
    this.historyBox = element("input", { type: "checkbox" });
    this.historyLabel = element("span");
    this.legend = element("div", { class: "iv-legend" });
    this.hoverSvg = document.createElementNS(SVG, "svg");       // the line pointed at, over the others
    this.hoverSvg.setAttribute("class", "iv-lines iv-hover-lines");
    this.hoverSvg.setAttribute("preserveAspectRatio", "none");
    this.tip = element("div", { class: "iv-tip" });
    this.tip.hidden = true;
    const frameBox = element("div", { class: "iv-frame" }, this.canvas, this.svg, this.hoverSvg, this.tip);
    frameBox.addEventListener("pointermove", (e) => this.hover(e));
    frameBox.addEventListener("pointerleave", () => this.hover(null));
    root.replaceChildren(frameBox, this.caption,
      element("div", { class: "iv-controls" }, this.prev, this.play, this.next, this.slider, this.modeSelect, this.speedSelect,
        element("label", { class: "iv-check" }, this.historyBox, this.historyLabel)),
      this.legend);
    this.historyBox.addEventListener("change", (e) => {
      this.history = e.target.checked;
      this.hover(null);
      this.renderLegend();
      if (this.meta) { this.drawLines(this.frame); this.frameOnMap(this.frame); }
    });
    this.prev.addEventListener("click", () => { this.stop(); this.step(-1); });
    this.next.addEventListener("click", () => { this.stop(); this.step(1); });
    this.play.addEventListener("click", () => (this.playing ? this.stop() : this.start()));
    this.slider.addEventListener("input", (e) => { this.stop(); this.show(Number(e.target.value)); });
    this.modeSelect.addEventListener("change", (e) => { this.mode = e.target.value; });
    this.speedSelect.addEventListener("change", (e) => { this.delay = Number(e.target.value); });
    root.addEventListener("keydown", (e) => {
      if (e.target.closest("select, input")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); this.stop(); this.step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); this.stop(); this.step(-1); }
    });
    this.setText(text);
  }

  setText(text) {
    this.text = text;
    const v = text;
    this.prev.title = v.prev; this.next.title = v.next; this.play.title = this.playing ? v.pause : v.play;
    this.prev.setAttribute("aria-label", v.prev); this.next.setAttribute("aria-label", v.next);
    this.play.setAttribute("aria-label", this.playing ? v.pause : v.play);
    this.slider.setAttribute("aria-label", v.image);
    this.modeSelect.setAttribute("aria-label", v.image);
    this.modeSelect.innerHTML = `<option value="all">${v.every}</option><option value="year">${v.perYear}</option>`;
    this.modeSelect.value = this.mode;
    this.speedSelect.innerHTML = [[250, 4], [100, 10], [40, 25]].map(([d, n]) => `<option value="${d}">${v.speed(n)}</option>`).join("");
    this.speedSelect.value = String(this.delay);
    this.historyLabel.textContent = v.history;
    this.renderLegend();
    if (this.meta) this.describe(this.frame);
  }

  renderLegend() {
    const v = this.text;
    this.historyBox.checked = this.history;
    if (!this.history) {
      this.legend.replaceChildren(...["obs", "corr", "year"].map((k) =>
        element("span", {}, element("i", { class: `iv-key iv-key-${k}` }), v[k])));
      this.mark = null;
      return;
    }
    const [first, last] = this.yearRange;
    const at = (year) => `left: ${((year - first) / (last - first || 1)) * 100}%`;
    this.mark = element("i", { class: "iv-bar-mark" });
    const ticks = [];                                   // the decades, under the bar
    for (let y = Math.ceil((first + 3) / 10) * 10; y <= last - 3; y += 10) ticks.push(element("span", { class: "iv-tick", style: at(y) }, String(y)));
    const bar = element("span", { class: "iv-bar", style: `background: linear-gradient(to right, ${this.stops.join(", ")})` },
      ...ticks, this.mark);
    this.legend.replaceChildren(
      element("span", { class: "iv-bar-row" }, String(first), bar, String(last)),
      element("span", {}, v.historyKey),
      element("span", {}, element("i", { class: "iv-key iv-key-now" }), v.historyNow));
    if (this.meta) this.markYear(this.years[this.frame]);
  }

  markYear(year) {
    if (!this.mark) return;
    const [first, last] = this.yearRange;
    this.mark.style.left = `${Math.max(0, Math.min(1, (year - first) / (last - first || 1))) * 100}%`;
  }

  colourOf(year) { return yearColour(year, this.yearRange, this.stops); }

  // Pointing at the image with "every year" on: the nearest year's line is drawn on top and named.
  hover(event) {
    const clear = () => { this.tip.hidden = true; this.hoverSvg.replaceChildren(); };
    if (!event || !this.history || !this.meta) { clear(); return; }
    const box = this.svg.getBoundingClientRect();
    const scale = this.meta.width / box.width;          // image pixels per screen pixel
    const px = (event.clientX - box.left) * scale, py = (event.clientY - box.top) * (this.meta.height / box.height);
    let best = null, gap = HOVER_PX * scale;
    for (const line of this.historyLines()) {
      for (const run of line.runs) {
        for (let i = 0; i < run.length; i++) {
          const d = toSegment([px, py], run[i], run[Math.min(i + 1, run.length - 1)]);
          if (d < gap) { gap = d; best = line; }
        }
      }
    }
    if (!best) { clear(); return; }
    const colour = this.colourOf(best.year);
    this.hoverSvg.setAttribute("viewBox", `0 0 ${this.meta.width} ${this.meta.height}`);
    this.hoverSvg.replaceChildren(...best.runs.flatMap((run) => ["iv-casing-now", "iv-now"].map((cls) => {
      const el = document.createElementNS(SVG, "polyline");
      el.setAttribute("points", (run.length > 1 ? run : [run[0], run[0]]).map((p) => p.join(",")).join(" "));
      el.setAttribute("class", cls);
      if (cls === "iv-now") el.style.stroke = colour;
      return el;
    })));
    const frame = this.svg.parentElement.getBoundingClientRect();
    this.tip.replaceChildren(element("i", { style: `background: ${colour}` }), String(best.year));
    this.tip.style.left = `${event.clientX - frame.left + 12}px`;
    this.tip.style.top = `${event.clientY - frame.top - 28}px`;
    this.tip.hidden = false;
  }

  // ---------------------------------------------------------------- opening a segment
  async open(archive, seg, transectId) {
    if (this.seg?.name === seg.name && this.meta) { this.setTransect(transectId); return; }
    this.stop();
    this.hover(null);
    this.seg = seg;
    this.meta = null;
    this.caption.textContent = this.text.loading;
    let opened;
    try {
      opened = await archive.open(seg);
    } catch (error) {
      if (this.seg === seg) this.caption.textContent = this.text.failed(error.message);
      throw error;
    }
    if (this.seg !== seg) return;                     // another segment was asked for meanwhile
    const { meta, videoUrl } = opened;
    this.video.src = videoUrl;
    await new Promise((resolve, reject) => {
      this.video.onloadeddata = resolve;
      this.video.onerror = () => reject(new Error("video"));
    });
    if (this.seg !== seg) return;
    this.meta = meta;
    this.n = meta.transects.length;
    this.frames = meta.time.length;
    this.years = meta.time.map((t) => Number(t.slice(0, 4)));
    this.when = meta.time.map(fractionalYear);
    this.best = new Map([...new Set(this.years)].map((y) => [y, this.bestOfYear(y)]));
    const k = transectId == null ? -1 : meta.transects.findIndex((t) => t.id === String(transectId));
    this.transect = k >= 0 ? k : Math.floor(this.n / 2);
    this.canvas.width = meta.width * SCALE;
    this.canvas.height = meta.height * SCALE;
    this.svg.setAttribute("viewBox", `0 0 ${meta.width} ${meta.height}`);
    this.slider.max = String(this.frames - 1);
    if (this.map) await this.addToMap();
    const latest = this.best.get(this.years.at(-1));
    await this.show(latest ?? this.frames - 1);
  }

  setTransect(transectId) {
    const k = this.meta ? this.meta.transects.findIndex((t) => t.id === String(transectId)) : -1;
    if (k < 0 || k === this.transect) return;
    this.transect = k;
    this.drawLines(this.frame);
    this.describe(this.frame);
    this.onChange?.(this.frame);
  }

  value(key, frame, t) {
    const v = this.meta[key][frame * this.n + t];
    return v == null ? null : v / 10;
  }

  at(t, x) {
    const tr = this.meta.transects[t];
    return [tr.x0 + x * tr.dx, tr.y0 + x * tr.dy];
  }

  // The image of a year whose corrected shorelines sit closest to the year's positions (clear ones first).
  bestOfYear(year) {
    let best = null, score = Infinity;
    this.years.forEach((y, f) => {
      if (y !== year) return;
      const gaps = [];
      this.meta.transects.forEach((tr, t) => {
        const yearly = this.meta.yearly[tr.id];
        const k = yearly ? yearly.year.indexOf(year) : -1;
        const x = this.value("x_corr", f, t);
        if (k >= 0 && x != null && yearly.x[k] != null && this.meta.flag[f * this.n + t] === 0) {
          gaps.push(Math.abs(x - yearly.x[k] / 10));
        }
      });
      if (!gaps.length) return;
      gaps.sort((a, b) => a - b);
      const s = gaps[Math.floor(gaps.length / 2)] + 2 * this.meta.cloud[f];
      if (s < score) { score = s; best = f; }
    });
    return best;
  }

  // For a chart: each image's corrected shoreline at a transect (fractional year, metres, flag, image).
  imagesOf(transectId) {
    const t = this.meta ? this.meta.transects.findIndex((tr) => tr.id === String(transectId)) : -1;
    if (t < 0) return [];
    const out = [];
    for (let f = 0; f < this.frames; f++) {
      const x = this.value("x_corr", f, t), flag = this.meta.flag[f * this.n + t];
      if (x != null && (flag === 0 || flag === 1)) out.push({ when: this.when[f], x, flag, frame: f });
    }
    return out;
  }

  get currentWhen() { return this.meta ? this.when[this.frame] : null; }

  showYear(year) {
    if (!this.meta) return Promise.resolve();
    const best = this.best.get(year);
    const f = best ?? this.years.findIndex((y) => y >= year);
    return this.show(f >= 0 ? f : this.frames - 1);
  }

  // ---------------------------------------------------------------- one image
  async draw(frame) {
    await new Promise((resolve) => {
      const target = (frame + 0.5) / this.meta.fps;
      if (Math.abs(this.video.currentTime - target) < 1e-3 && this.video.readyState >= 2) { resolve(); return; }
      this.video.onseeked = resolve;
      this.video.currentTime = target;
    });
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
  }

  async show(frame) {
    if (!this.meta) return;
    frame = Math.max(0, Math.min(this.frames - 1, frame));
    this.frame = frame;
    const job = this.draw(frame);
    this.busy = job;
    await job;
    if (this.busy !== job || !this.meta) return;
    this.drawLines(frame);
    this.describe(frame);
    this.slider.value = String(frame);
    this.frameOnMap(frame);
    this.onChange?.(frame);
  }

  linesOf(frame) {
    const obs = [], corr = [], year = [];
    const y = this.years[frame];
    this.meta.transects.forEach((tr, t) => {
      const flag = this.meta.flag[frame * this.n + t];
      const o = this.value("x_obs", frame, t), c = this.value("x_corr", frame, t);
      if (o != null && flag !== -1) obs.push(this.at(t, o));
      if (c != null && flag === 0) corr.push(this.at(t, c));
      const yearly = this.meta.yearly[tr.id];
      const k = yearly ? yearly.year.indexOf(y) : -1;
      if (k >= 0 && yearly.x[k] != null) year.push(this.at(t, yearly.x[k] / 10));
    });
    return { year, obs, corr };                       // drawing order: the year's position underneath
  }

  // Every year's position along the segment, oldest first: [{year, runs}], kept for the segment. A year's
  // line breaks where two neighbouring positions (transects 100 m apart) are more than BREAK_M apart: a
  // river mouth, a harbour or one wrong position, not a shoreline. A position alone is a run of one (a dot).
  historyLines() {
    if (this.historyOf?.meta === this.meta) return this.historyOf.lines;
    const byYear = new Map(), gap = BREAK_M / (this.meta.pixel_m || 10);
    this.meta.transects.forEach((tr, t) => {
      const yearly = this.meta.yearly[tr.id];
      yearly?.year.forEach((y, k) => {
        if (yearly.x[k] == null) return;
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(this.at(t, yearly.x[k] / 10));
      });
    });
    const lines = [...byYear].sort((a, b) => a[0] - b[0]).map(([year, points]) => {
      const runs = [[points[0]]];
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        if (Math.hypot(x1 - x0, y1 - y0) > gap) runs.push([]);
        runs.at(-1).push(points[i]);
      }
      return { year, runs };
    });
    this.historyOf = { meta: this.meta, lines };
    return lines;
  }

  drawLines(frame) {
    const line = (points, cls, colour) => {
      const el = document.createElementNS(SVG, "polyline");
      el.setAttribute("points", points.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" "));
      el.setAttribute("class", cls);
      if (colour) el.style.stroke = colour;
      return el;
    };
    const parts = [line([this.at(this.transect, 0), this.at(this.transect, 2000)], "iv-chosen")];
    if (this.history) {                                 // casings first, so each line keeps a dark edge
      const lines = this.historyLines(), now = lines.find((l) => l.year === this.years[frame]);
      const draw = ({ year, runs }, cls) => runs.map((run) =>         // a run of one: a dot (a round cap)
        line(run.length > 1 ? run : [run[0], run[0]], cls, cls.includes("casing") ? null : this.colourOf(year)));
      parts.push(...lines.flatMap((l) => draw(l, "iv-casing-hist")), ...lines.flatMap((l) => draw(l, "iv-hist")));
      if (now) parts.push(...draw(now, "iv-casing-now"), ...draw(now, "iv-now"));
      this.markYear(this.years[frame]);
    } else {
      for (const [kind, points] of Object.entries(this.linesOf(frame))) {
        if (points.length < 2) continue;
        parts.push(line(points, `iv-casing iv-casing-${kind}`), line(points, `iv-${kind}`));
      }
    }
    this.meta.transects.forEach((tr, t) => {            // wide invisible strokes: click to follow a transect
      const pick = line([this.at(t, 0), this.at(t, 2000)], "iv-pick");
      pick.addEventListener("click", () => (this.onPick ? this.onPick(tr.id) : this.setTransect(tr.id)));
      parts.push(pick);
    });
    this.svg.replaceChildren(...parts);
  }

  describe(frame) {
    const m = this.meta, v = this.text, t = this.transect, f = this.fmt;
    const o = this.value("x_obs", frame, t), c = this.value("x_corr", frame, t);
    const flag = m.flag[frame * this.n + t];
    const why = flag === 1 ? v.outlier : flag === 2 ? v.unused : flag === -1 ? v.none : null;
    const moved = o != null && c != null && !why ? v.moved(f(Math.abs(c - o), 0), c >= o ? v.seaward : v.landward) : why;
    const level = (x) => (x == null ? "–" : f(x / 10, 1, true));
    this.caption.replaceChildren(
      element("b", {}, v.caption(m.time[frame].replace("T", " "), m.platform[frame], f(frame + 1, 0), f(this.frames, 0),
        f(m.cloud[frame], 0))),
      element("br"), `${v.water(level(m.tide[frame]), level(m.wave[frame]))} → ${m.transects[t].id}: ${moved}`);
  }

  // ---------------------------------------------------------------- playing
  sequence() { return this.mode === "year" ? [...this.best.values()].filter((f) => f != null) : null; }

  step(direction) {
    const list = this.sequence();
    if (!list) return this.show(this.frame + direction);
    const now = list.findIndex((f) => f >= this.frame);
    const k = direction > 0 ? (now < 0 ? 0 : list[now] > this.frame ? now : now + 1)
      : (now <= 0 ? list.length - 1 : now - 1);
    return this.show(list[(k + list.length) % list.length]);
  }

  async start() {
    if (!this.meta) return;
    this.playing = true;
    this.play.textContent = "❚❚";
    this.play.title = this.text.pause;
    while (this.playing) {
      const started = performance.now();
      if (this.frame >= this.frames - 1 && !this.sequence()) await this.show(0); else await this.step(1);
      const wait = this.delay - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop() {
    this.playing = false;
    this.play.textContent = "▶";
    this.play.title = this.text?.play || "";
  }

  // ---------------------------------------------------------------- the map
  get bounds() {
    const lons = this.meta.corners.map((c) => c[0]), lats = this.meta.corners.map((c) => c[1]);
    return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  }

  toLonLat([col, row]) {                 // frame pixel -> lon/lat, from the frame's four corners
    const [tl, tr, br, bl] = this.meta.corners, u = col / this.meta.width, v = row / this.meta.height;
    return [0, 1].map((i) => (1 - u) * (1 - v) * tl[i] + u * (1 - v) * tr[i] + u * v * br[i] + (1 - u) * v * bl[i]);
  }

  async addToMap() {
    const map = this.map;
    if (!map.isStyleLoaded()) await new Promise((resolve) => map.once("idle", resolve));
    this.removeFromMap();
    const before = this.beforeLayer && map.getLayer(this.beforeLayer) ? this.beforeLayer : undefined;
    map.addSource("iv-frame", { type: "canvas", canvas: this.canvas, coordinates: this.meta.corners, animate: false });
    map.addLayer({ id: "iv-frame", type: "raster", source: "iv-frame",
      paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } }, before);
    map.addSource("iv-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const kind = (k) => ["==", ["get", "kind"], k];
    const round = { "line-cap": "round", "line-join": "round" };
    map.addLayer({ id: "iv-hist-casing", type: "line", source: "iv-lines", filter: kind("hist"), layout: round,
      paint: { "line-color": "rgba(0,0,0,0.45)", "line-width": 3 } });
    map.addLayer({ id: "iv-hist", type: "line", source: "iv-lines", filter: kind("hist"),
      layout: { ...round, "line-sort-key": ["get", "year"] },
      paint: { "line-color": ["to-color", ["get", "colour"]], "line-width": 1.5 } });
    map.addLayer({ id: "iv-hist-dot", type: "circle", source: "iv-lines", filter: ["match", ["get", "kind"], ["hist-dot", "now-dot"], true, false],
      paint: { "circle-color": ["to-color", ["get", "colour"]], "circle-radius": ["case", kind("now-dot"), 2.5, 1.5],
        "circle-stroke-width": ["case", kind("now-dot"), 1.5, 0.75],
        "circle-stroke-color": ["case", kind("now-dot"), "rgba(255,255,255,0.9)", "rgba(0,0,0,0.45)"] } });
    map.addLayer({ id: "iv-now-casing", type: "line", source: "iv-lines", filter: kind("now"), layout: round,
      paint: { "line-color": "rgba(255,255,255,0.9)", "line-width": 5 } });
    map.addLayer({ id: "iv-now", type: "line", source: "iv-lines", filter: kind("now"), layout: round,
      paint: { "line-color": ["to-color", ["get", "colour"]], "line-width": 2.5 } });
    map.addLayer({ id: "iv-casing", type: "line", source: "iv-lines", layout: round,
      filter: ["match", ["get", "kind"], ["obs", "corr", "year"], true, false],
      paint: { "line-color": ["case", kind("year"), "rgba(255,255,255,0.85)", "rgba(0,0,0,0.55)"],
        "line-width": ["case", kind("year"), 4, 4.5] } });
    map.addLayer({ id: "iv-year", type: "line", source: "iv-lines", filter: kind("year"),
      layout: { "line-cap": "round" }, paint: { "line-color": LINE_COLOURS.year, "line-width": 2, "line-dasharray": [0.5, 2] } });
    map.addLayer({ id: "iv-obs", type: "line", source: "iv-lines", filter: kind("obs"),
      paint: { "line-color": LINE_COLOURS.obs, "line-width": 2.5, "line-dasharray": [2, 1] } });
    map.addLayer({ id: "iv-corr", type: "line", source: "iv-lines", filter: kind("corr"),
      paint: { "line-color": LINE_COLOURS.corr, "line-width": 2.5 } });
    const Popup = globalThis.maplibregl?.Popup;           // pointing at a year's line names it, as on the image
    if (Popup) {
      this.popup = new Popup({ closeButton: false, closeOnClick: false, className: "iv-popup", offset: 10 });
      this.onHoverMap = (e) => {                          // of the lines under the pointer, the nearest
        let f = null, gap = Infinity;
        for (const g of e.features || []) {
          const points = (g.geometry.type === "Point" ? [g.geometry.coordinates] : g.geometry.coordinates).map((c) => map.project(c));
          points.forEach((a, i) => {
            const d = toSegment([e.point.x, e.point.y], [a.x, a.y], [points[Math.min(i + 1, points.length - 1)].x, points[Math.min(i + 1, points.length - 1)].y]);
            if (d < gap) { gap = d; f = g; }
          });
        }
        if (!f) return;
        this.popup.setLngLat(e.lngLat).setDOMContent(element("span", { class: "iv-tip-text" },
          element("i", { style: `background: ${f.properties.colour}` }), String(f.properties.year))).addTo(map);
      };
      this.onLeaveMap = () => this.popup.remove();
      for (const id of ["iv-hist", "iv-hist-dot"]) { map.on("mousemove", id, this.onHoverMap); map.on("mouseleave", id, this.onLeaveMap); }
    }
  }

  frameOnMap(frame) {
    const source = this.map?.getSource("iv-frame");
    if (!source) return;
    source.play();                                    // the canvas source copies the canvas while playing
    requestAnimationFrame(() => source.pause());
    const feature = (properties, points) => ({ type: "Feature", properties,
      geometry: { type: "LineString", coordinates: points.map((p) => this.toLonLat(p)) } });
    let features;
    if (this.history) {
      const lines = this.historyLines(), now = lines.find((l) => l.year === this.years[frame]);
      const of = ({ year, runs }, kind) => runs.map((run) => {
        const properties = { kind: run.length > 1 ? kind : `${kind}-dot`, year, colour: this.colourOf(year) };
        return run.length > 1 ? feature(properties, run)
          : { type: "Feature", properties, geometry: { type: "Point", coordinates: this.toLonLat(run[0]) } };
      });
      features = lines.flatMap((l) => of(l, "hist"));
      if (now) features.push(...of(now, "now"));
    } else {
      features = Object.entries(this.linesOf(frame)).filter(([, p]) => p.length > 1).map(([k, points]) => feature({ kind: k }, points));
    }
    this.map.getSource("iv-lines").setData({ type: "FeatureCollection", features });
  }

  removeFromMap() {
    const map = this.map;
    if (!map) return;
    if (this.onHoverMap) {
      for (const id of ["iv-hist", "iv-hist-dot"]) { map.off("mousemove", id, this.onHoverMap); map.off("mouseleave", id, this.onLeaveMap); }
      this.onHoverMap = null;
    }
    this.popup?.remove();
    for (const id of ["iv-corr", "iv-obs", "iv-year", "iv-casing", "iv-now", "iv-now-casing", "iv-hist-dot", "iv-hist",
      "iv-hist-casing", "iv-frame"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ["iv-lines", "iv-frame"]) if (map.getSource(id)) map.removeSource(id);
  }

  close() {
    this.stop();
    this.removeFromMap();
    this.seg = null;
    this.meta = null;
    this.busy = null;
  }
}
