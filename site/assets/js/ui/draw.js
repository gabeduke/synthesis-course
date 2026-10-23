// Canvas helpers: one animation loop for the whole page, crisp HiDPI canvases,
// theme colors read from CSS, and the oscilloscope / spectrum drawing code.

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

// Size a canvas to its box at device resolution. Returns a 2D context in CSS pixels.
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
  return { g, w, h };
}

let colorCache = null;
let colorStamp = 0;
export function colors() {
  const now = performance.now();
  if (!colorCache || now - colorStamp > 1000) {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colorCache = {
      sound: v('--sound'), time: v('--time'), move: v('--move'), space: v('--space'), hw: v('--hw'),
      ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), rule: v('--rule'), grid: v('--grid'),
      surface: v('--surface'), surface2: v('--surface-2'),
    };
    colorStamp = now;
  }
  return colorCache;
}

export function grid(g, w, h, cols = 8, rows = 4) {
  const c = colors();
  g.strokeStyle = c.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < cols; i++) { const x = Math.round((i * w) / cols) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
  for (let j = 1; j < rows; j++) { const y = Math.round((j * h) / rows) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();
}

// Find a rising zero crossing so a steady tone draws as a steady picture.
export function trigger(data, searchLen) {
  for (let i = 1; i < searchLen; i++) if (data[i - 1] < 0 && data[i] >= 0) return i;
  return 0;
}

const buffers = new WeakMap();
function bufFor(analyser, kind) {
  let b = buffers.get(analyser);
  if (!b) { b = {}; buffers.set(analyser, b); }
  const n = kind === 'time' ? analyser.fftSize : analyser.frequencyBinCount;
  if (!b[kind] || b[kind].length !== n) b[kind] = new Float32Array(n);
  return b[kind];
}

// Oscilloscope. `span` is how many samples fit across the width.
export function drawWave(g, w, h, analyser, { color, span = 1024, gain = 1, lineWidth = 2, dash = null } = {}) {
  const data = bufFor(analyser, 'time');
  analyser.getFloatTimeDomainData(data);
  const n = Math.min(span, data.length >> 1);
  const start = trigger(data, data.length - n);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'round';
  g.setLineDash(dash || []);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 - data[start + i] * gain * (h * 0.46);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.setLineDash([]);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

export const F_MIN = 20;
export const F_MAX = 20000;
export const xForFreq = (f, w) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
export const freqForX = (x, w) => F_MIN * Math.pow(F_MAX / F_MIN, x / w);
export const DB_MIN = -100;
export const DB_MAX = -10;
export const yForDb = (db, h) => h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h;

export function freqGrid(g, w, h) {
  const c = colors();
  g.strokeStyle = c.grid;
  g.fillStyle = c.ink3;
  g.font = '10px Archivo, sans-serif';
  g.lineWidth = 1;
  g.beginPath();
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xForFreq(f, w)) + 0.5;
    g.moveTo(x, 0); g.lineTo(x, h);
  }
  g.stroke();
  for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
    g.fillText(label, xForFreq(f, w) + 4, h - 6);
  }
}

// Spectrum on a log frequency axis, as a filled line.
export function drawSpectrum(g, w, h, analyser, { color, fill = true, lineWidth = 1.5, dash = null } = {}) {
  const data = bufFor(analyser, 'freq');
  analyser.getFloatFrequencyData(data);
  const sr = analyser.context.sampleRate;
  const binHz = sr / analyser.fftSize;
  g.beginPath();
  let started = false;
  const step = 1.5;
  for (let x = 0; x <= w; x += step) {
    const f0 = freqForX(x, w);
    const f1 = freqForX(x + step, w);
    const i0 = Math.max(1, Math.floor(f0 / binHz));
    const i1 = Math.max(i0, Math.min(data.length - 1, Math.floor(f1 / binHz)));
    let m = -Infinity;
    for (let i = i0; i <= i1; i++) m = Math.max(m, data[i]);
    const y = yForDb(Math.max(DB_MIN, Math.min(DB_MAX, m)), h);
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.setLineDash(dash || []);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.stroke();
  g.setLineDash([]);
  if (fill) {
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    g.globalAlpha = 0.12;
    g.fillStyle = color;
    g.fill();
    g.globalAlpha = 1;
  }
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
// the caller keeps between frames so the scale moves smoothly.
export function drawMiniWave(g, x, y, w, h, analyser, { color, span = 512, agc = {}, lineWidth = 1.4 } = {}) {
  const data = bufFor(analyser, 'time');
  analyser.getFloatTimeDomainData(data);
  const n = Math.min(span, data.length >> 1);
  const start = trigger(data, data.length - n);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  agc.peak = Math.max(peak, (agc.peak || 0) * 0.94);
  const gain = agc.peak > 0.002 ? (h * 0.44) / agc.peak : 0;
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x + (i / (n - 1)) * w;
    const py = y + h / 2 - data[start + i] * gain;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.stroke();
  return peak;
}

// Spectrogram: time runs from right to left, pitch from bottom to top on a
// log scale, and loudness is the strength of the color. It keeps its own
// scrolling picture, so make one per canvas and call draw() once a frame
// with each source to paint, as { analyser, color }.
const SONO_LO = 30;
const SONO_HI = 16000;
export class Sonogram {
  constructor() {
    this.img = document.createElement('canvas');
    this.ig = this.img.getContext('2d');
  }

  draw(canvas, g, w, h, sources) {
    const c = colors();
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return; // hidden (focus-only view, just closed)
    const dpr = W / Math.max(1, w);
    const { img, ig } = this;
    if (img.width !== W || img.height !== H) {
      img.width = W;
      img.height = H;
      ig.fillStyle = c.surface2;
      ig.fillRect(0, 0, W, H);
    }
    // One CSS pixel a frame: about ten seconds across a 600-pixel panel.
    const dx = Math.max(1, Math.round(dpr));
    ig.globalAlpha = 1;
    ig.drawImage(img, -dx, 0);
    ig.fillStyle = c.surface2;
    ig.fillRect(W - dx, 0, dx, H);
    const step = Math.max(1, Math.round(dpr * 1.5));
    for (const { analyser, color } of sources) {
      if (!analyser) continue;
      const data = bufFor(analyser, 'freq');
      analyser.getFloatFrequencyData(data);
      const binHz = analyser.context.sampleRate / analyser.fftSize;
      ig.fillStyle = color;
      for (let py = 0; py < H; py += step) {
        const fTop = SONO_LO * Math.pow(SONO_HI / SONO_LO, 1 - py / H);
        const fBot = SONO_LO * Math.pow(SONO_HI / SONO_LO, 1 - (py + step) / H);
        const i0 = Math.max(1, Math.floor(fBot / binHz));
        const i1 = Math.max(i0, Math.min(data.length - 1, Math.ceil(fTop / binHz)));
        let m = -Infinity;
        for (let i = i0; i <= i1; i++) m = Math.max(m, data[i]);
        const t = (m + 92) / 70;
        if (!(t > 0.03)) continue;
        ig.globalAlpha = Math.min(1, t) ** 1.6;
        ig.fillRect(W - dx, py, dx, step);
      }
    }
    ig.globalAlpha = 1;
    g.drawImage(img, 0, 0, w, h);
    // Pitch marks on the left edge.
    g.fillStyle = c.ink3;
    g.strokeStyle = c.grid;
    g.font = '10px Archivo, sans-serif';
    g.lineWidth = 1;
    g.beginPath();
    for (const [f, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
      const y = Math.round(h * (1 - Math.log(f / SONO_LO) / Math.log(SONO_HI / SONO_LO))) + 0.5;
      g.moveTo(0, y); g.lineTo(w, y);
      if (y > 34) g.fillText(label, 6, y - 3); // none under the view's name
    }
    g.stroke();
  }
}

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
  state.agc ||= {};
  const hits = [];
  const main = stages.filter((s) => !s.aside);
  const aside = stages.filter((s) => s.aside);
  const gap = w < 480 ? 14 : 22;
  const top = 30;
  const bh = h - top - 8;
  const bw = (w - 16 - gap * (stages.length - 1) - (aside.length ? gap : 0)) / stages.length;
  const boxes = {};
  const order = [...main, ...aside];
  let x = 8;
  for (const [i, st] of order.entries()) {
    if (st.aside && !order[i - 1]?.aside) x += gap;
    const b = { x, y: top, w: bw, h: bh, id: st.id };
    boxes[st.id] = b;
    hits.push(b);
    g.globalAlpha = st.dim ? 0.45 : 1;
    g.fillStyle = c.surface;
    g.strokeStyle = pulse === st.id || hover === st.id ? st.color : c.rule;
    g.lineWidth = pulse === st.id ? 2 : 1;
    g.setLineDash(st.aside ? [4, 3] : []);
    g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 6); g.fill(); g.stroke();
    g.setLineDash([]);
    g.font = '600 11px Archivo, sans-serif';
    g.fillStyle = st.color;
    g.fillText(st.name, b.x + 7, b.y + 14);
    // The stage's main setting, when there's room beside its name.
    const nameW = g.measureText(st.name).width;
    g.font = '10px Archivo, sans-serif';
    const subW = st.sub ? g.measureText(st.sub).width : 0;
    if (st.sub && nameW + subW + 24 < b.w) {
      g.fillStyle = c.ink3;
      g.fillText(st.sub, b.x + b.w - 7 - subW, b.y + 14);
    }
    let level = 0;
    const sy = b.y + 20; const sh = b.h - 30;
    if (st.tap) {
      state.agc[st.id] ||= {};
      level = drawMiniWave(g, b.x + 6, sy, b.w - 12, sh, st.tap, { color: st.color, agc: state.agc[st.id], span: 384 });
    } else {
      g.strokeStyle = st.color; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(b.x + 6, sy + sh / 2); g.lineTo(b.x + b.w - 6, sy + sh / 2); g.stroke();
    }
    g.fillStyle = c.rule;
    g.fillRect(b.x + 6, b.y + b.h - 7, b.w - 12, 3);
    g.fillStyle = st.color;
    g.fillRect(b.x + 6, b.y + b.h - 7, (b.w - 12) * Math.min(1, level / 0.6), 3);
    g.globalAlpha = 1;
    // Arrow to the next stage, with the signal flowing along it while it sounds.
    const next = order[i + 1];
    if (next && !next.aside && !st.aside) {
      const ax = b.x + b.w; const ay = b.y + b.h / 2;
      const live = level > 0.002;
      g.strokeStyle = live ? st.color : c.rule;
      g.lineWidth = 1.6;
      g.setLineDash([4, 4]);
      g.lineDashOffset = live ? -(now / 40) % 8 : 0;
      g.beginPath(); g.moveTo(ax + 2, ay); g.lineTo(ax + gap - 4, ay); g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
      g.fillStyle = g.strokeStyle;
      g.beginPath(); g.moveTo(ax + gap - 2, ay); g.lineTo(ax + gap - 7, ay - 4); g.lineTo(ax + gap - 7, ay + 4); g.fill();
    }
    x += bw + gap;
  }

  g.font = '600 10px Archivo, sans-serif';
  const pills = {};
  for (const m of mods) {
    const anchor = boxes[m.over];
    if (!anchor) continue;
    const used = m.targets.filter(([t, d]) => (boxes[t] || pills[t]) && d > 0.005);
    const lw = g.measureText(m.name).width + 14;
    const lx = Math.min(Math.max(anchor.x + anchor.w * (m.at ?? 0.5) - lw / 2, 4), w - lw - 4);
    g.globalAlpha = used.length ? 1 : 0.4;
    g.strokeStyle = m.color; g.fillStyle = c.surface;
    g.lineWidth = pulse === m.id || hover === m.id ? 2 : 1;
    g.beginPath(); g.roundRect(lx, 4, lw, 16, 8); g.fill(); g.stroke();
    g.fillStyle = m.color;
    g.fillText(m.name, lx + 7, 15.5);
    hits.push({ x: lx, y: 4, w: lw, h: 16, id: m.id });
    pills[m.id] = { x: lx, w: lw };
    for (const [t, depth] of used) {
      g.strokeStyle = m.color;
      g.lineWidth = 1 + Math.min(1, depth) * 2;
      g.globalAlpha = m.active === false ? 0.45 : 0.92;
      if (m.rate) { g.setLineDash([3, 4]); g.lineDashOffset = -(now / 1000) * m.rate * 14; }
      g.beginPath();
      if (boxes[t]) {
        const b = boxes[t];
        const tx = b.x + b.w * (m.land ?? 0.5);
        g.moveTo(lx + lw / 2, 20);
        g.bezierCurveTo(lx + lw / 2, 27, tx, 22, tx, b.y);
      } else {
        // Another modulator: a loop under the labels, from this one to that one.
        const p = pills[t];
        const from = lx + lw / 2; const to = p.x + p.w / 2;
        g.moveTo(from, 20);
        g.bezierCurveTo(from, 28, to, 28, to, 20);
      }
      g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }
    g.globalAlpha = 1;
  }
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
