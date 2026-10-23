// Canvas helpers: one animation loop for the whole page, crisp HiDPI canvases,
// theme colors read from CSS, and the drawing the widgets share: the
// oscilloscope, the spectrum and its axes, the spectrogram, and the signal path.
//
// Text and line weights scale with the panel (kOf): a picture drawn for a
// 190-pixel lesson panel keeps its proportions and stays legible when Focus
// fills a large screen with it. Grids and axes, which change only with the
// size or the theme, are drawn once into a cached layer (layer()).

const subscribers = new Set();
let running = false;

// Draw only what's on screen, once per frame, from a single loop.
export function onFrame(el, fn) {
  const entry = { el, fn, visible: false };
  const io = new IntersectionObserver(([e]) => { entry.visible = e.isIntersecting; }, { rootMargin: '80px' });
  io.observe(el);
  subscribers.add(entry);
  if (!running) { running = true; requestAnimationFrame(tick); }
  return () => { subscribers.delete(entry); io.disconnect(); };
}

function tick(now) {
  for (const s of subscribers) if (s.visible) {
    try { s.fn(now); } catch (err) { console.error(err); }
  }
  requestAnimationFrame(tick);
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
// Decorative movement (crawling dashes) stops when the reader asks for less motion.
export const reducedMotion = () => !!motionQuery?.matches;

// How much bigger than in a lesson a canvas's text and lines are drawn: 1 in
// a lesson and on a phone; in Focus, the panel's own scale (ui/focus.js sets
// canvas._focusK, up to 1.6 on a large screen), so every picture in a panel
// matches, held back only for a very small canvas. Text sizes are multiplied
// by it, line weights by lineScale(). kOf(g) is a drawing context's scale.
const scaleFor = (canvas, w, h) => {
  const f = canvas._focusK || 1;
  return f <= 1 ? 1 : Math.max(1, Math.min(f, h / 90, w / 220));
};
export const kOf = (g) => g.canvas._k || 1;
// Where the drawing can start below the view's name and legend.
export const headBand = (g) => { const k = kOf(g); return Math.max(Math.round(26 * k), Math.round((g.canvas._head || 0) + 4 * k)); };
export const lineScale = (k) => 1 + (k - 1) * 0.75;

// Size a canvas to its box at device resolution. Returns a 2D context in CSS
// pixels, the box's size, and its scale (see scaleFor).
export function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = scaleFor(canvas, w, h);
  const box = canvas.parentElement?.classList.contains('viz') ? canvas.parentElement : null;
  // The box's HTML labels scale with the drawing (course.css reads --k).
  if (canvas._k !== k) {
    canvas._k = k;
    box?.style.setProperty('--k', k.toFixed(3));
  }
  // The view's name and legend sit in a header band the drawing leaves clear
  // (headBand): one line, or two when a long legend wraps in a narrow view.
  if (box) {
    let head = 0;
    for (const ch of box.children) if (ch !== canvas && ch.offsetHeight) head = Math.max(head, ch.offsetTop + ch.offsetHeight);
    canvas._head = head;
  }
  return { g, w, h, k, dpr };
}

export const FONT = 'Archivo, "Helvetica Neue", Arial, sans-serif';
export const font = (px, weight = 400) => `${weight} ${Math.round(px * 10) / 10}px ${FONT}`;

// ---------- Colors ----------
const rgbCache = new Map();
// Any CSS color the tokens use (#rgb, #rrggbb, rgb(), rgba()) as [r, g, b, a].
export function rgb(color) {
  let v = rgbCache.get(color);
  if (v) return v;
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(color))) {
    let hx = m[1];
    if (hx.length <= 4) hx = [...hx].map((ch) => ch + ch).join('');
    v = [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16), hx.length >= 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1];
  } else if ((m = /rgba?\(([^)]+)\)/i.exec(color))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    v = [p[0], p[1], p[2], p[3] ?? 1];
  } else v = [128, 128, 128, 1];
  rgbCache.set(color, v);
  return v;
}
export const alpha = (color, a) => { const [r, g, b, a0] = rgb(color); return `rgba(${r},${g},${b},${+(a0 * a).toFixed(3)})`; };
// A color part of the way from one to another.
export const mix = (c1, c2, t) => {
  const a = rgb(c1); const b = rgb(c2);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
};
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

let colorCache = null;
let colorStamp = 0;
export function colors() {
  const now = performance.now();
  if (!colorCache || now - colorStamp > 1000) {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const c = {
      sound: v('--sound'), time: v('--time'), move: v('--move'), space: v('--space'), hw: v('--hw'),
      ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), rule: v('--rule'), rule2: v('--rule-2'), grid: v('--grid'),
      surface: v('--surface'), surface2: v('--surface-2'), paper: v('--paper'),
    };
    c.key = Object.values(c).join('|');
    if (c.key !== colorCache?.key) {
      c.dark = luminance(rgb(c.surface)) < 0.45;
      // The zero line and the main divisions: a step stronger than the grid.
      c.axis = alpha(c.ink, c.dark ? 0.17 : 0.2);
      colorCache = c;
    }
    colorStamp = now;
  }
  return colorCache;
}

// The color behind a canvas (its .viz box), for text halos and dot rings.
const bgCache = new WeakMap();
export function backgroundOf(canvas) {
  const now = performance.now();
  let e = bgCache.get(canvas);
  if (!e || now - e.t > 600) {
    let bg = '';
    for (let el = canvas; el && el.nodeType === 1; el = el.parentElement) {
      const b = getComputedStyle(el).backgroundColor;
      if (b && b !== 'transparent' && rgb(b)[3] > 0.5) { bg = b; break; }
    }
    e = { t: now, bg: bg || colors().surface };
    bgCache.set(canvas, e);
  }
  return e.bg;
}

// ---------- Cached layers ----------
// Grids, axes and their labels change only with the canvas size, the theme
// or the fonts, so each is painted once into an offscreen canvas and copied.
let fontStamp = 0;
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.ready.then(() => { fontStamp++; });
  document.fonts.addEventListener?.('loadingdone', () => { fontStamp++; });
}
const layers = new WeakMap();
export function layer(g, w, h, id, paint) {
  const canvas = g.canvas;
  if (!canvas.width || !canvas.height) return;
  const dpr = canvas.width / Math.max(1, w);
  const key = `${canvas.width}x${canvas.height}|${canvas._head}|${colors().key}|${backgroundOf(canvas)}|${fontStamp}`;
  let per = layers.get(canvas);
  if (!per) layers.set(canvas, per = new Map());
  let L = per.get(id);
  if (!L) per.set(id, L = { c: document.createElement('canvas'), key: '' });
  if (L.key !== key) {
    L.c.width = canvas.width;
    L.c.height = canvas.height;
    const lg = L.c.getContext('2d');
    lg.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(lg, w, h, kOf(g));
    L.key = key;
  }
  g.drawImage(L.c, 0, 0, w, h);
}

const crisp = (v) => Math.round(v) + 0.5;

// Text that stays legible over a drawing: a ring of the background around it.
export function haloText(g, text, x, y, color, halo, width = 3) {
  g.lineJoin = 'round';
  g.strokeStyle = halo;
  g.lineWidth = width;
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

// A marker dot with a ring of the background, so it reads where it crosses a line.
export function dot(g, x, y, r, color, ring) {
  g.beginPath();
  g.arc(x, y, r + Math.max(1.5, r * 0.4), 0, Math.PI * 2);
  g.fillStyle = ring;
  g.fill();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
}

// A graticule: hairline divisions, and for a picture centred on zero
// (an even number of rows) a stronger zero line with small ticks along it.
export function grid(g, w, h, cols = 8, rows = 4, { axis = rows % 2 === 0, ticks = axis, top = 0, bottom = 0 } = {}) {
  layer(g, w, h, `grid:${cols}:${rows}:${axis}:${ticks}:${top}:${bottom}`, (lg, W, H, k) => {
    const c = colors();
    const y0 = top; const y1 = H - bottom;
    lg.lineWidth = 1;
    lg.strokeStyle = c.grid;
    lg.beginPath();
    for (let i = 1; i < cols; i++) { const x = crisp((i * W) / cols); lg.moveTo(x, y0); lg.lineTo(x, y1); }
    for (let j = 1; j < rows; j++) {
      if (axis && j * 2 === rows) continue;
      const y = crisp(y0 + (j * (y1 - y0)) / rows); lg.moveTo(0, y); lg.lineTo(W, y);
    }
    lg.stroke();
    if (!axis) return;
    const y = crisp((y0 + y1) / 2);
    lg.strokeStyle = c.axis;
    lg.beginPath();
    lg.moveTo(0, y); lg.lineTo(W, y);
    if (ticks) {
      const t = 2.5 * k;
      const n = cols * 5;
      for (let i = 1; i < n; i++) {
        if (i % 5 === 0) continue;
        const x = crisp((i * W) / n);
        lg.moveTo(x, y - t); lg.lineTo(x, y + t);
      }
    }
    lg.stroke();
  });
}

// A short note in the middle of an empty picture ("Play a key …").
export function idle(g, w, h, text, { y = h / 2 } = {}) {
  if (!text) return;
  const c = colors();
  const k = kOf(g);
  g.font = font(11.5 * k);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  haloText(g, text, w / 2, y, c.ink3, backgroundOf(g.canvas), 6 * k);
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
}

// A flat, dim trace for a picture with no sound yet.
export function flat(g, w, h, color) {
  const k = kOf(g);
  g.globalAlpha = 0.4;
  g.strokeStyle = color;
  g.lineWidth = 2 * lineScale(k);
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.globalAlpha = 1;
}

// Whether a picture has been quiet long enough (1.2 s) to show its hint.
// `state` is an object the caller keeps; `loud` is whether it sounds now.
export function quietFor(state, loud, now = performance.now()) {
  if (loud) state.at = now;
  else if (state.at === undefined) state.at = -Infinity;
  return now - state.at > 1200;
}

// The legend in a view's header: [label, color, dash] per series, where dash
// is 'dash' or 'dot' for a dashed or dotted line. Rebuilt only when it changes.
export function setLegend(node, items) {
  const key = items.map((i) => i.join(':')).join('|');
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.replaceChildren(...items.map(([label, color, dash]) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.setProperty('--c', color);
    if (dash) i.dataset.dash = dash;
    s.append(i, label);
    return s;
  }));
}

// A history, oldest at the left and newest at the right, as a line over a
// soft fill, with a dot at the newest value. `hist` is a ring buffer and
// `oldest` the index of its oldest value. Unipolar values (a level, 0–1 after
// `gain`) sit on the floor; bipolar ones (an LFO, −1 to 1) on the middle.
export function drawHistory(g, w, h, hist, oldest, { color, gain = 1, lineWidth = 2, bipolar = false, fill = true, top = 0, bottom = 0, end = true } = {}) {
  const c = colors();
  const k = kOf(g);
  const lw = lineWidth * lineScale(k);
  const n = hist.length;
  const y0 = top + lw; const y1 = h - bottom - lw;
  const base = bipolar ? (y0 + y1) / 2 : y1;
  const Y = (v) => (bipolar
    ? base - Math.max(-1, Math.min(1, v * gain)) * ((y1 - y0) / 2)
    : y1 - Math.max(0, Math.min(1, v * gain)) * (y1 - y0));
  const line = new Path2D();
  let x = 0; let y = base;
  for (let i = 0; i < n; i++) {
    x = (i / (n - 1)) * w;
    y = Y(hist[(oldest + i) % n]);
    if (i === 0) line.moveTo(x, y); else line.lineTo(x, y);
  }
  if (fill) {
    const area = new Path2D(line);
    area.lineTo(w, base); area.lineTo(0, base); area.closePath();
    const grad = g.createLinearGradient(0, y0, 0, y1);
    const a = c.dark ? 0.3 : 0.2;
    if (bipolar) { grad.addColorStop(0, alpha(color, a)); grad.addColorStop(0.5, alpha(color, 0.02)); grad.addColorStop(1, alpha(color, a)); }
    else { grad.addColorStop(0, alpha(color, a)); grad.addColorStop(1, alpha(color, 0.02)); }
    g.fillStyle = grad;
    g.fill(area);
  }
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.stroke(line);
  if (end) dot(g, x - lw, y, 3.5 * lineScale(k), color, backgroundOf(g.canvas));
}

// ---------- Oscilloscope ----------
// Find a rising zero crossing so a steady tone draws as a steady picture.
export function trigger(data, searchLen) {
  for (let i = 1; i < searchLen; i++) if (data[i - 1] < 0 && data[i] >= 0) return i;
  return 0;
}

// A steadier trigger for chords and drifting tones: of the first few rising
// zero crossings, take the one where the picture best matches the last frame.
const triggerMemory = new WeakMap(); // canvas -> Map(analyser -> last picture)
const MATCH = 64;
function steadyTrigger(canvas, analyser, data, n, peak) {
  const limit = data.length - n;
  const thr = peak * 0.03;
  const cands = [];
  let armed = false;
  for (let i = 1; i < limit && cands.length < 14; i++) {
    if (data[i] < -thr) armed = true;
    else if (armed && data[i - 1] < 0 && data[i] >= 0) { cands.push(i); armed = false; }
  }
  if (!cands.length) return trigger(data, limit);
  let per = triggerMemory.get(canvas);
  if (!per) triggerMemory.set(canvas, per = new WeakMap());
  let prev = per.get(analyser);
  if (!prev) per.set(analyser, prev = { pic: new Float32Array(MATCH), ok: false });
  const stride = (n - 1) / (MATCH - 1);
  let best = cands[0];
  if (prev.ok && cands.length > 1) {
    let bestScore = Infinity;
    for (const s of cands) {
      let score = 0;
      for (let j = 0; j < MATCH; j++) score += Math.abs(data[s + Math.round(j * stride)] - prev.pic[j]);
      if (score < bestScore) { bestScore = score; best = s; }
    }
  }
  for (let j = 0; j < MATCH; j++) prev.pic[j] = data[best + Math.round(j * stride)];
  prev.ok = true;
  return best;
}

const buffers = new WeakMap();
function bufFor(analyser, kind) {
  let b = buffers.get(analyser);
  if (!b) { b = {}; buffers.set(analyser, b); }
  const n = kind === 'time' ? analyser.fftSize : analyser.frequencyBinCount;
  if (!b[kind] || b[kind].length !== n) b[kind] = new Float32Array(n);
  return b[kind];
}

// Stroke the current path as a lit trace: a soft wide wash under a crisp line.
function trace(g, color, lw, { glow = true, dash = null, k = 1 } = {}) {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (glow && !dash) {
    g.strokeStyle = alpha(color, colors().dark ? 0.18 : 0.1);
    g.lineWidth = lw * 3;
    g.stroke();
  }
  g.setLineDash(dash ? dash.map((d) => d * k) : []);
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.stroke();
  g.setLineDash([]);
  g.lineCap = 'butt';
}

// Oscilloscope. `span` is how many samples fit across the width. Returns the
// block's peak level, 0–1.
export function drawWave(g, w, h, analyser, { color, span = 1024, gain = 1, lineWidth = 2, dash = null, glow = true } = {}) {
  const k = kOf(g);
  const data = bufFor(analyser, 'time');
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  const n = Math.min(span, data.length >> 1);
  const start = steadyTrigger(g.canvas, analyser, data, n, peak);
  const amp = gain * h * 0.46;
  const mid = h / 2;
  const lw = lineWidth * lineScale(k);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = Math.max(-lw, Math.min(h + lw, mid - data[start + i] * amp));
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  if (peak < 1e-4) g.globalAlpha = 0.4;
  trace(g, color, lw, { glow: glow && peak >= 1e-4, dash, k });
  g.globalAlpha = 1;
  return peak;
}

// ---------- Spectrum ----------
export const F_MIN = 20;
export const F_MAX = 20000;
export const xForFreq = (f, w) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
export const freqForX = (x, w) => F_MIN * Math.pow(F_MAX / F_MIN, x / w);
export const DB_MIN = -100;
export const DB_MAX = -10;
// The spectrum's plot area: a band at the top for the view's name and legend,
// and one at the bottom for the frequency labels.
export const specBox = (g) => ({ top: headBand(g), bottom: Math.round(18 * kOf(g)) });
// Without `box` this maps the whole height, as it always did.
export const yForDb = (db, h, box) => {
  const t = box?.top ?? 0; const b = box?.bottom ?? 0;
  return t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * (h - t - b);
};
const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

// The frequency axis: hairlines at 50, 100, 200 … 10k (stronger at each
// decade), loudness lines every 20 dB, and as many labels as fit.
export function freqGrid(g, w, h) {
  layer(g, w, h, 'freq', (lg, W, H, k) => {
    const c = colors();
    const box = specBox(g);
    const y0 = box.top; const y1 = H - box.bottom;
    lg.lineWidth = 1;
    lg.strokeStyle = c.grid;
    lg.beginPath();
    for (const f of [50, 200, 500, 2000, 5000]) { const x = crisp(xForFreq(f, W)); lg.moveTo(x, y0); lg.lineTo(x, y1); }
    for (let db = -20; db > DB_MIN; db -= 20) { const y = crisp(yForDb(db, H, box)); lg.moveTo(0, y); lg.lineTo(W, y); }
    lg.stroke();
    lg.strokeStyle = c.axis;
    lg.beginPath();
    for (const f of [100, 1000, 10000]) { const x = crisp(xForFreq(f, W)); lg.moveTo(x, y0); lg.lineTo(x, y1); }
    lg.moveTo(0, crisp(y1)); lg.lineTo(W, crisp(y1));
    lg.stroke();
    // Labels under the floor: the decades first, then the rest where they fit.
    lg.font = font(10 * k);
    lg.textBaseline = 'middle';
    lg.textAlign = 'center';
    const ly = y1 + box.bottom / 2 + 0.5;
    const placed = [];
    const unitW = lg.measureText('Hz').width + 10 * k;
    const tryLabel = (f, strong) => {
      const text = fmtHz(f);
      const x = xForFreq(f, W);
      const half = lg.measureText(text).width / 2 + 5 * k;
      if (x - half < 0 || x + half > W - unitW) return;
      if (placed.some(([a, b]) => x + half > a && x - half < b)) return;
      placed.push([x - half, x + half]);
      lg.fillStyle = strong ? c.ink2 : c.ink3;
      lg.fillText(text, x, ly);
    };
    for (const f of [100, 1000, 10000]) tryLabel(f, true);
    for (const f of [50, 200, 500, 2000, 5000]) tryLabel(f, false);
    lg.textAlign = 'right';
    lg.fillStyle = c.ink3;
    lg.fillText('Hz', W - 6 * k, ly);
    // Loudness labels at the left, where the lowest octave is usually empty,
    // when the picture is tall enough to need them.
    if (y1 - y0 > 150) {
      lg.font = font(9.5 * k);
      lg.textAlign = 'left';
      lg.textBaseline = 'bottom';
      for (let db = -20; db > DB_MIN; db -= 20) haloText(lg, `${db} dB`.replace('-', '−'), 5 * k, yForDb(db, H, box) - 2, c.ink3, backgroundOf(g.canvas), 3);
    }
    lg.textAlign = 'start';
    lg.textBaseline = 'alphabetic';
  });
}

const specScratch = new WeakMap();
// Spectrum on a log frequency axis: a smooth line over a soft fill. Between
// FFT bins (the low end) it interpolates; where many bins share a pixel (the
// top end) it keeps the loudest, so no harmonic is lost.
export function drawSpectrum(g, w, h, analyser, { color, fill = true, lineWidth = 1.5, dash = null } = {}) {
  const k = kOf(g);
  const box = specBox(g);
  const data = bufFor(analyser, 'freq');
  analyser.getFloatFrequencyData(data);
  const binHz = analyser.context.sampleRate / analyser.fftSize;
  const last = data.length - 1;
  const step = 2;
  const N = Math.ceil(w / step) + 1;
  let ys = specScratch.get(g);
  if (!ys || ys.length < N) specScratch.set(g, ys = new Float32Array(N + 16));
  const at = (b) => {
    const i = Math.min(last - 1, Math.max(1, Math.floor(b)));
    const t = Math.min(1, Math.max(0, b - i));
    return data[i] * (1 - t) + data[i + 1] * t;
  };
  for (let j = 0; j < N; j++) {
    const x = Math.min(w, j * step);
    const bA = freqForX(x - step / 2, w) / binHz;
    const bB = freqForX(x + step / 2, w) / binHz;
    let db;
    if (bB - bA < 1.5) db = at(freqForX(x, w) / binHz);
    else {
      db = -Infinity;
      for (let i = Math.max(1, Math.ceil(bA)), e = Math.min(last, Math.floor(bB)); i <= e; i++) if (data[i] > db) db = data[i];
    }
    if (!(db > DB_MIN)) db = DB_MIN;
    ys[j] = yForDb(Math.min(DB_MAX, db), h, box);
  }
  const line = new Path2D();
  line.moveTo(0, ys[0]);
  for (let j = 1; j < N - 1; j++) {
    const x = j * step;
    line.quadraticCurveTo(x, ys[j], x + step / 2, (ys[j] + ys[j + 1]) / 2);
  }
  line.lineTo(w, ys[N - 1]);
  const floor = h - box.bottom;
  if (fill) {
    const area = new Path2D(line);
    area.lineTo(w, floor); area.lineTo(0, floor); area.closePath();
    const grad = g.createLinearGradient(0, box.top, 0, floor);
    const dark = colors().dark;
    grad.addColorStop(0, alpha(color, dark ? 0.34 : 0.24));
    grad.addColorStop(0.55, alpha(color, dark ? 0.14 : 0.1));
    grad.addColorStop(1, alpha(color, 0.02));
    g.fillStyle = grad;
    g.fill(area);
  }
  g.lineJoin = 'round';
  g.setLineDash(dash ? dash.map((d) => d * k) : []);
  g.strokeStyle = color;
  g.lineWidth = lineWidth * lineScale(k);
  g.stroke(line);
  g.setLineDash([]);
}

// A filter's response over the spectrum, on its own scale (0 dB near the top),
// dashed, with a dot and a label at the cutoff. `mag(i)` is the gain at
// freqs[i], and `cutMag` the gain at the cutoff.
export function drawResponse(g, w, h, freqs, mag, cutoff, cutMag) {
  const c = colors();
  const box = specBox(g);
  const k = kOf(g);
  const lk = lineScale(k);
  const plotH = h - box.top - box.bottom;
  // 0 dB a fifth of the way down leaves room for a resonant peak of about +20 dB.
  const y0 = box.top + plotH * 0.2;
  const Y = (db) => Math.min(h - box.bottom, Math.max(box.top - 3 * k, y0 - db * (plotH / 100)));
  const line = new Path2D();
  for (let i = 0; i < freqs.length; i++) {
    const db = 20 * Math.log10(Math.max(1e-6, mag(i)));
    const x = xForFreq(freqs[i], w);
    if (i === 0) line.moveTo(x, Y(db)); else line.lineTo(x, Y(db));
  }
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = alpha(c.ink, 0.85); g.lineWidth = 1.6 * lk;
  g.setLineDash([6 * k, 4 * k]);
  g.stroke(line);
  g.setLineDash([]); g.lineCap = 'butt';
  // The cutoff: a dot on the curve, a hairline down to the axis and its frequency.
  const x = xForFreq(cutoff, w);
  const y = Y(20 * Math.log10(Math.max(1e-6, cutMag)));
  const bg = backgroundOf(g.canvas);
  g.strokeStyle = alpha(c.ink, 0.28); g.lineWidth = 1;
  g.beginPath(); g.moveTo(Math.round(x) + 0.5, y); g.lineTo(Math.round(x) + 0.5, h - box.bottom); g.stroke();
  dot(g, x, y, 3.5 * lk, c.ink, bg);
  const label = cutoff >= 1000 ? `${(cutoff / 1000).toFixed(cutoff >= 10000 ? 1 : 2)} kHz` : `${Math.round(cutoff)} Hz`;
  g.font = font(10.5 * k, 600);
  const tw = g.measureText(label).width;
  const right = x + 9 * k + tw < w - 4;
  const above = y - 18 * k > box.top; // under the dot when a peak reaches the top
  g.textAlign = right ? 'left' : 'right';
  g.textBaseline = above ? 'bottom' : 'top';
  haloText(g, label, right ? x + 8 * k : x - 8 * k, above ? y - 4 * k : y + 5 * k, c.ink2, bg, 3.5);
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';
}

// RMS level of an analyser's latest block, 0–1.
export function rms(analyser) {
  const data = bufFor(analyser, 'time');
  analyser.getFloatTimeDomainData(data);
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
}

export function makeAnalyser(ctx, fftSize = 4096, smoothing = 0.55) {
  const a = ctx.createAnalyser();
  a.fftSize = fftSize;
  a.smoothingTimeConstant = smoothing;
  return a;
}

// A small oscilloscope inside a box, scaled to fill its height whatever the
// level (the box's level bar shows how loud it really is). `agc` is an object
// the caller keeps between frames: the scale follows a louder signal at once
// and a quieter one slowly, so the picture doesn't pump.
export function drawMiniWave(g, x, y, w, h, analyser, { color, span = 512, agc = {}, lineWidth = 1.4 } = {}) {
  const data = bufFor(analyser, 'time');
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  const n = Math.min(span, data.length >> 1);
  const start = steadyTrigger(g.canvas, analyser, data, n, peak);
  const now = performance.now();
  const dt = agc.t ? Math.min(0.2, (now - agc.t) / 1000) : 1 / 60;
  agc.t = now;
  const target = Math.max(peak, 0.002);
  if (!agc.level) agc.level = target;
  else if (target > agc.level) agc.level += (target - agc.level) * Math.min(1, dt * 25);
  else agc.level += (target - agc.level) * (1 - Math.exp(-dt / 1.4));
  const gain = agc.level > 0.0025 ? (h * 0.44) / agc.level : 0;
  g.save();
  g.beginPath();
  g.rect(x - lineWidth, y - lineWidth, w + 2 * lineWidth, h + 2 * lineWidth);
  g.clip();
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x + (i / (n - 1)) * w;
    const py = y + h / 2 - data[start + i] * gain;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  if (peak < 0.0025) g.globalAlpha *= 0.5;
  trace(g, color, lineWidth, { glow: peak >= 0.0025 });
  g.restore();
  return peak;
}

// ---------- Spectrogram ----------
// Time runs from right to left, pitch from bottom to top on a log scale, and
// loudness is the strength of the color. It keeps its own scrolling picture
// (a ring of columns, one device pixel wide), so make one per canvas and call
// draw() once a frame with each source to paint, as { analyser, color }.
const SONO_LO = 30;
const SONO_HI = 16000;
const SONO_SPEED = 60; // CSS pixels per second: about ten seconds across a 600-pixel panel
const SONO_DB_LO = -98;
const SONO_DB_HI = -26;
export class Sonogram {
  constructor() {
    this.img = document.createElement('canvas');
    this.ig = this.img.getContext('2d');
    this.pos = 0;
    this.acc = 0;
    this.last = 0;
  }

  // The plot area inside the canvas: bands for the name above and the time below.
  static box(g) { return { top: headBand(g), bottom: Math.round(18 * kOf(g)) }; }

  // For each device row, the FFT bins it covers (or the point between two
  // bins it falls on), for one bin width.
  _rows(H, binHz, n) {
    const key = `${H}:${binHz}:${n}`;
    if (this._rowKey === key) return this._rowMap;
    const lo = new Float32Array(H); const hi = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const f = (t) => SONO_LO * Math.pow(SONO_HI / SONO_LO, 1 - t / H);
      lo[y] = f(y + 1) / binHz; // the row's bottom edge
      hi[y] = f(y) / binHz;
    }
    this._rowKey = key;
    this._rowMap = { lo, hi, n };
    return this._rowMap;
  }

  // 256 colors from silent (the background) to loudest, for one source:
  // the source's own color, deepening (light theme) or brightening (dark).
  _lut(color) {
    const c = colors();
    const key = `${color}|${c.key}`;
    this._luts ||= new Map();
    let lut = this._luts.get(key);
    if (lut) return lut;
    const base = rgb(color);
    const peak = c.dark ? mix(color, '#ffffff', 0.62) : mix(color, c.ink, 0.42);
    const top = rgb(peak);
    lut = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      const a = Math.min(1, Math.pow(v / 0.55, 1.15));
      const t = Math.max(0, (v - 0.55) / 0.45);
      lut[i * 4] = base[0] + (top[0] - base[0]) * t;
      lut[i * 4 + 1] = base[1] + (top[1] - base[1]) * t;
      lut[i * 4 + 2] = base[2] + (top[2] - base[2]) * t;
      lut[i * 4 + 3] = a;
    }
    this._luts.set(key, lut);
    return lut;
  }

  draw(canvas, g, w, h, sources, { hint } = {}) {
    const c = colors();
    if (!canvas.width || !canvas.height) return; // hidden (focus-only view, just closed)
    const k = kOf(g);
    const dpr = canvas.width / Math.max(1, w);
    const box = Sonogram.box(g);
    const ph = h - box.top - box.bottom;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(ph * dpr));
    const bg = backgroundOf(canvas);
    const bgc = rgb(bg);
    const { img, ig } = this;
    const bgKey = `${bg}|${c.key}`;
    if (img.width !== W || img.height !== H || this.bgKey !== bgKey) {
      // A new size (Focus on or off) keeps the history, newest at the right;
      // a new theme starts afresh.
      let old = null;
      if (this.bgKey === bgKey && img.width > 1) {
        old = document.createElement('canvas');
        old.width = img.width; old.height = img.height;
        const og = old.getContext('2d');
        const p = this.pos;
        og.drawImage(img, p, 0, img.width - p, img.height, 0, 0, img.width - p, img.height);
        if (p) og.drawImage(img, 0, 0, p, img.height, img.width - p, 0, p, img.height);
      }
      img.width = W;
      img.height = H;
      ig.fillStyle = bg;
      ig.fillRect(0, 0, W, H);
      if (old) {
        const ow = old.width * (dpr / (this.dpr || dpr));
        ig.drawImage(old, 0, 0, old.width, old.height, W - ow, 0, ow, H);
      }
      this.bgKey = bgKey;
      this.dpr = dpr;
      this.pos = 0;
      this.col = ig.createImageData(1, H);
      this.prev = new Float32Array(H * 3).fill(0);
      this.cur = new Float32Array(H * 3);
      for (let y = 0; y < H; y++) for (let j = 0; j < 3; j++) this.prev[y * 3 + j] = bgc[j];
    }
    // Advance by real time, not by frames, so the time axis is true at any frame rate.
    const now = performance.now();
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.acc += dt * SONO_SPEED * dpr;
    const adv = Math.min(W, Math.floor(this.acc));
    this.acc -= adv;
    if (adv > 0) {
      const cur = this.cur;
      for (let y = 0; y < H; y++) { cur[y * 3] = bgc[0]; cur[y * 3 + 1] = bgc[1]; cur[y * 3 + 2] = bgc[2]; }
      for (const { analyser, color } of sources) {
        if (!analyser) continue;
        const data = bufFor(analyser, 'freq');
        analyser.getFloatFrequencyData(data);
        const rows = this._rows(H, analyser.context.sampleRate / analyser.fftSize, data.length);
        const lut = this._lut(color);
        const last = data.length - 1;
        for (let y = 0; y < H; y++) {
          const a = rows.lo[y]; const b = rows.hi[y];
          let m;
          if (b - a < 1) {
            const mid = (a + b) / 2;
            const i = Math.min(last - 1, Math.max(1, Math.floor(mid)));
            const t = mid - i;
            m = data[i] * (1 - t) + data[i + 1] * t;
          } else {
            m = -Infinity;
            for (let i = Math.max(1, Math.ceil(a)), e = Math.min(last, Math.floor(b)); i <= e; i++) if (data[i] > m) m = data[i];
          }
          const v = (m - SONO_DB_LO) / (SONO_DB_HI - SONO_DB_LO);
          if (!(v > 0.02)) continue;
          const li = Math.min(255, Math.round(v * 255)) * 4;
          const al = lut[li + 3];
          const o = y * 3;
          cur[o] += (lut[li] - cur[o]) * al;
          cur[o + 1] += (lut[li + 1] - cur[o + 1]) * al;
          cur[o + 2] += (lut[li + 2] - cur[o + 2]) * al;
        }
      }
      // Write the new columns, easing from the last one so a big step looks smooth.
      const px = this.col.data; const prev = this.prev;
      for (let s = 1; s <= adv; s++) {
        const t = s / adv;
        for (let y = 0; y < H; y++) {
          const o = y * 3; const p = y * 4;
          px[p] = prev[o] + (cur[o] - prev[o]) * t;
          px[p + 1] = prev[o + 1] + (cur[o + 1] - prev[o + 1]) * t;
          px[p + 2] = prev[o + 2] + (cur[o + 2] - prev[o + 2]) * t;
          px[p + 3] = 255;
        }
        ig.putImageData(this.col, this.pos, 0);
        this.pos = (this.pos + 1) % W;
      }
      prev.set(cur);
    }
    // The ring, oldest column first.
    const p = this.pos;
    const left = (W - p) / dpr;
    g.imageSmoothingEnabled = false;
    if (W - p > 0) g.drawImage(img, p, 0, W - p, H, 0, box.top, left, ph);
    if (p > 0) g.drawImage(img, 0, 0, p, H, left, box.top, p / dpr, ph);
    g.imageSmoothingEnabled = true;
    this._axes(g, w, h, box, k);
    if (hint) idle(g, w, h, hint, { y: box.top + ph / 2 });
  }

  // Pitch lines and labels, and the time scale under the picture.
  _axes(g, w, h, box, k) {
    layer(g, w, h, 'sono', (lg, W, H) => {
      const c = colors();
      const bg = backgroundOf(g.canvas);
      const y0 = box.top; const y1 = H - box.bottom;
      const yFor = (f) => y0 + (y1 - y0) * (1 - Math.log(f / SONO_LO) / Math.log(SONO_HI / SONO_LO));
      lg.lineWidth = 1;
      lg.strokeStyle = alpha(c.ink, c.dark ? 0.12 : 0.1);
      lg.beginPath();
      for (const f of [100, 1000, 10000]) { const y = crisp(yFor(f)); lg.moveTo(0, y); lg.lineTo(W, y); }
      lg.stroke();
      lg.strokeStyle = c.axis;
      lg.beginPath();
      lg.moveTo(0, crisp(y0)); lg.lineTo(W, crisp(y0));
      lg.moveTo(0, crisp(y1)); lg.lineTo(W, crisp(y1));
      // Seconds, counted back from now at the right edge.
      const t = 3 * k;
      for (let s = 1; W - s * SONO_SPEED > 0; s++) { const x = crisp(W - s * SONO_SPEED); lg.moveTo(x, y1); lg.lineTo(x, y1 + t); }
      lg.stroke();
      lg.font = font(10 * k);
      lg.textBaseline = 'bottom';
      for (const [f, label] of [[100, '100 Hz'], [1000, '1 kHz'], [10000, '10 kHz']]) {
        const y = yFor(f);
        // Above its line, or below it when the line is near the top.
        const below = y - y0 < 14 * k;
        lg.textBaseline = below ? 'top' : 'bottom';
        if (y1 - y > 14 * k) haloText(lg, label, 6 * k, below ? y + 3 : y - 3, c.ink2, bg, 3);
      }
      lg.textBaseline = 'middle';
      lg.fillStyle = c.ink3;
      const ly = y1 + box.bottom / 2 + 1;
      lg.textAlign = 'right';
      lg.fillText('now', W - 4 * k, ly);
      const every = SONO_SPEED * 2 >= 70 * k ? 2 : 4;
      lg.textAlign = 'center';
      for (let s = every; W - s * SONO_SPEED > 24 * k; s += every) lg.fillText(`−${s} s`, W - s * SONO_SPEED, ly);
      lg.textAlign = 'start';
      lg.textBaseline = 'alphabetic';
    });
  }
}

// ---------- Signal path ----------
// A signal path: stages left to right, each with a small scope of the signal
// at that point and a bar under it for how loud it really is, and modulators
// above, with a line down to each stage they move.
//
//   stages  [{ id, name, color, tap, sub, dim, aside }]  aside: drawn apart at
//           the right with a dashed border (an instrument's real output)
//   mods    [{ id, name, color, over, at, land, targets: [[id, depth 0–1]],
//              rate, active }]  over/at: the stage and fraction of its width
//           the label sits above; land: where on a stage its lines arrive;
//           a target can be a stage, or a mod drawn earlier in the list;
//           rate (Hz) makes the line crawl like an LFO
//   state   an object kept between frames (scope scaling, hit boxes)
//   hover, pulse  stage or mod ids to outline
// Returns hit boxes [{ x, y, w, h, id }] for pointer handling.
export function drawFlow(g, w, h, now, { stages, mods = [], state, hover, pulse }) {
  const c = colors();
  const k = kOf(g);
  const lk = lineScale(k);
  const still = reducedMotion();
  state.agc ||= {};
  state.meter ||= {};
  const dt = state.t ? Math.min(0.2, (now - state.t) / 1000) : 1 / 60;
  state.t = now;
  const hits = [];
  const main = stages.filter((s) => !s.aside);
  const aside = stages.filter((s) => s.aside);
  const gap = (w < 480 ? 14 : 22) * Math.min(k, 1.25);
  const top = Math.round(30 * k);
  const bh = h - top - 8 * k;
  const bw = (w - 16 - gap * (stages.length - 1) - (aside.length ? gap : 0)) / stages.length;
  const boxes = {};
  const order = [...main, ...aside];
  const ring = backgroundOf(g.canvas);
  // One size for every stage's name, shrunk (to 8.5 px at least) so the
  // longest still fits a narrow box.
  g.font = font(11 * k, 600);
  const longest = Math.max(...order.map((st) => g.measureText(st.name).width));
  const nameFont = font(Math.max(8.5, 11 * k * Math.min(1, (bw - 24 * k) / Math.max(1, longest))), 600);
  let x = 8;
  for (const [i, st] of order.entries()) {
    if (st.aside && !order[i - 1]?.aside) x += gap;
    const b = { x, y: top, w: bw, h: bh, id: st.id };
    boxes[st.id] = b;
    hits.push(b);
    const lit = pulse === st.id || hover === st.id;
    g.globalAlpha = st.dim ? 0.5 : 1;
    g.fillStyle = c.surface;
    g.beginPath(); g.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 7 * k); g.fill();
    g.strokeStyle = lit ? st.color : c.rule;
    g.lineWidth = pulse === st.id ? 2 : 1;
    g.setLineDash(st.aside ? [4 * k, 3 * k] : []);
    g.stroke();
    g.setLineDash([]);
    // The stage's name, with a swatch of its color, and its main setting
    // at the right when there's room.
    const pad = 8 * k;
    const ny = b.y + 15 * k;
    g.fillStyle = st.color;
    g.beginPath(); g.roundRect(b.x + pad, ny - 7.5 * k, 3 * k, 9 * k, 1.5 * k); g.fill();
    g.font = nameFont;
    const nameW = g.measureText(st.name).width;
    g.fillStyle = c.ink;
    g.fillText(st.name, b.x + pad + 7 * k, ny);
    if (st.sub) {
      g.font = font(10 * k);
      const subW = g.measureText(st.sub).width;
      if (nameW + subW + pad * 2 + 14 * k < b.w) {
        g.fillStyle = c.ink3;
        g.fillText(st.sub, b.x + b.w - pad - subW, ny);
      }
    }
    // The scope, over a faint zero line.
    let level = 0;
    const sx = b.x + pad; const sw = b.w - pad * 2;
    const sy = b.y + 22 * k; const sh = b.h - 22 * k - 13 * k;
    g.strokeStyle = c.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(sx, crisp(sy + sh / 2)); g.lineTo(sx + sw, crisp(sy + sh / 2)); g.stroke();
    if (st.tap) {
      state.agc[st.id] ||= {};
      level = drawMiniWave(g, sx, sy, sw, sh, st.tap, { color: st.color, agc: state.agc[st.id], span: 384, lineWidth: 1.5 * lk });
    } else {
      g.globalAlpha *= 0.5;
      g.strokeStyle = st.color; g.lineWidth = 1.2 * lk;
      g.beginPath(); g.moveTo(sx, sy + sh / 2); g.lineTo(sx + sw, sy + sh / 2); g.stroke();
      g.globalAlpha = st.dim ? 0.5 : 1;
    }
    // Level meter: jumps up, falls back gently.
    const m = state.meter[st.id] ?? 0;
    const shown = level > m ? level : m + (level - m) * (1 - Math.exp(-dt / 0.25));
    state.meter[st.id] = shown;
    const mh = Math.max(2.5, 3 * k);
    const my = b.y + b.h - 8 * k - mh / 2;
    g.fillStyle = alpha(c.ink, c.dark ? 0.1 : 0.08);
    g.beginPath(); g.roundRect(sx, my, sw, mh, mh / 2); g.fill();
    const fillW = sw * Math.min(1, shown / 0.6);
    if (fillW > 0.5) { g.fillStyle = st.color; g.beginPath(); g.roundRect(sx, my, Math.max(mh, fillW), mh, mh / 2); g.fill(); }
    g.globalAlpha = 1;
    // Arrow to the next stage, with the signal flowing along it while it sounds.
    const next = order[i + 1];
    if (next && !next.aside && !st.aside) {
      const ax = b.x + b.w; const ay = sy + sh / 2;
      const live = level > 0.002;
      g.strokeStyle = live ? st.color : c.rule;
      g.lineWidth = 1.6 * lk;
      g.setLineDash([3 * k, 4 * k]);
      g.lineDashOffset = live && !still ? -(now / 40) % (7 * k) : 0;
      g.beginPath(); g.moveTo(ax + 3, ay); g.lineTo(ax + gap - 5 * k, ay); g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
      g.fillStyle = g.strokeStyle;
      const ah = 4 * k;
      g.beginPath(); g.moveTo(ax + gap - 2, ay); g.lineTo(ax + gap - 2 - ah * 1.3, ay - ah); g.lineTo(ax + gap - 2 - ah * 1.3, ay + ah); g.closePath(); g.fill();
    }
    x += bw + gap;
  }

  // Modulators: a tag above the stage, with a line down to each thing it moves.
  g.font = font(10 * k, 600);
  const pills = {};
  const py = 4 * k; const ph = 17 * k;
  const drawn = [];
  for (const md of mods) {
    const anchor = boxes[md.over];
    if (!anchor) continue;
    const used = md.targets.filter(([t, d]) => (boxes[t] || pills[t]) && d > 0.005);
    const lw = g.measureText(md.name).width + 16 * k;
    const lx = Math.min(Math.max(anchor.x + anchor.w * (md.at ?? 0.5) - lw / 2, 4), w - lw - 4);
    hits.push({ x: lx, y: py, w: lw, h: ph, id: md.id });
    pills[md.id] = { x: lx, w: lw };
    // Lines first, so the tags sit on top of them.
    for (const [t, depth] of used) {
      g.strokeStyle = md.color;
      g.lineWidth = (1 + Math.min(1, depth) * 2) * lk;
      g.globalAlpha = md.active === false ? 0.45 : 0.92;
      if (md.rate) { g.setLineDash([3 * k, 4 * k]); g.lineDashOffset = still ? 0 : -(now / 1000) * md.rate * 14 * k; }
      g.beginPath();
      const from = lx + lw / 2;
      if (boxes[t]) {
        const b = boxes[t];
        const tx = b.x + b.w * (md.land ?? 0.5);
        g.moveTo(from, py + ph);
        g.bezierCurveTo(from, py + ph + 7 * k, tx, top - 8 * k, tx, top);
      } else {
        // Another modulator: a loop under the tags, from this one to that one.
        const p = pills[t];
        const to = p.x + p.w / 2;
        g.moveTo(from, py + ph);
        g.bezierCurveTo(from, py + ph + 8 * k, to, py + ph + 8 * k, to, py + ph);
      }
      g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }
    g.globalAlpha = 1;
    drawn.push([md, lx, lw, used.length]);
  }
  for (const [md, lx, lw, n] of drawn) {
    g.globalAlpha = n ? 1 : 0.45;
    g.fillStyle = ring;
    g.beginPath(); g.roundRect(lx, py, lw, ph, ph / 2); g.fill();
    g.fillStyle = alpha(md.color, c.dark ? 0.2 : 0.12);
    g.fill();
    g.strokeStyle = md.color;
    g.lineWidth = pulse === md.id || hover === md.id ? 2 : 1;
    g.stroke();
    g.fillStyle = c.ink;
    g.textBaseline = 'middle';
    g.fillText(md.name, lx + 8 * k, py + ph / 2 + 0.5);
    g.textBaseline = 'alphabetic';
  }
  g.globalAlpha = 1;
  return hits;
}

// Pointer handling for a drawFlow canvas: `hits()` returns the boxes from the
// last frame; onHover(id or null) and onClick(id) are called with the stage
// or modulator under the pointer.
export function flowPointer(canvas, hits, { onHover, onClick }) {
  let over = null;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left; const y = e.clientY - r.top;
    return hits().find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.id ?? null;
  };
  canvas.addEventListener('pointermove', (e) => {
    const id = at(e);
    canvas.style.cursor = id ? 'pointer' : '';
    if (id !== over) { over = id; onHover(id); }
  });
  canvas.addEventListener('pointerleave', () => { if (over) { over = null; onHover(null); } });
  canvas.addEventListener('click', (e) => { const id = at(e); if (id) onClick(id); });
}
