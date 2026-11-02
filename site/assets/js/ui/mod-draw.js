// Drawing for the Jam page's modulators, in the style of the LFO lesson's
// view: the shape as a trace scrolling by (the past solid with a soft fill, the
// coming moments faint and dashed, since a shape is a function of time and
// can be asked for ahead), a dot where it is now, and beside it a short track
// showing where the parameter is in its range and how far this modulator
// reaches. It only draws: the page gives it the time and the values, and
// knows nothing here about MIDI.

import { colors, kOf, lineScale, font, alpha, dot, grid, haloText, backgroundOf } from './draw.js';
import { value, rateHz, place, norm } from '../audio/modulation.js';

const STRIP = 34; // the width of the track, in px
const NOW = 0.7; // how far across the trace "now" sits

// How much time the trace shows: a few cycles, so the shape is readable at
// any rate (a very slow one shows as much as a minute).
export const traceSpan = (mod) => Math.min(60, Math.max(8, 2.6 / rateHz(mod.rate)));

// o: { mod, t, base, now, label, readout, sending, selected }
//   t        the page's clock in seconds (the same one the sound runs on)
//   base     the target's resting value (the panel's)
//   now      the target's value this instant, with every modulator added (what is sent)
//   sending  whether it is going out over MIDI (the marker takes the instrument's color)
export function drawModulator(g, w, h, { mod, t, base, now, label, readout, sending, selected }) {
  const c = colors();
  const k = kOf(g);
  const lw = 2 * lineScale(k);
  const bg = backgroundOf(g.canvas);
  const on = mod.on && mod.depth > 0;
  const tw = w - STRIP;
  const y0 = 8 * k; const y1 = h - 8 * k;
  const mid = (y0 + y1) / 2;
  const amp = (y1 - y0) / 2;

  g.clearRect(0, 0, w, h);
  grid(g, tw, h, 6, 2);
  g.globalAlpha = on ? 1 : 0.38;

  // The trace: the shape times its depth, so depth is the height.
  const span = traceSpan(mod);
  const n = Math.max(24, Math.round(tw / 3));
  const X = (i) => (i / n) * tw;
  const Y = (i) => mid - value(mod, t + (i / n - NOW) * span) * (mod.depth / 100) * amp;
  const nowI = Math.round(NOW * n);
  const past = new Path2D();
  const ahead = new Path2D();
  for (let i = 0; i <= nowI; i++) { if (i === 0) past.moveTo(X(i), Y(i)); else past.lineTo(X(i), Y(i)); }
  for (let i = nowI; i <= n; i++) { if (i === nowI) ahead.moveTo(X(i), Y(i)); else ahead.lineTo(X(i), Y(i)); }
  const fill = new Path2D(past);
  fill.lineTo(X(nowI), mid); fill.lineTo(0, mid); fill.closePath();
  const grad = g.createLinearGradient(0, y0, 0, y1);
  const a = c.dark ? 0.3 : 0.2;
  grad.addColorStop(0, alpha(c.move, a)); grad.addColorStop(0.5, alpha(c.move, 0.02)); grad.addColorStop(1, alpha(c.move, a));
  g.fillStyle = grad;
  g.fill(fill);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = alpha(c.move, 0.5);
  g.lineWidth = 1.6 * lineScale(k);
  g.setLineDash([2 * k * 2, 4 * k]);
  g.stroke(ahead);
  g.setLineDash([]);
  g.strokeStyle = c.move;
  g.lineWidth = lw;
  g.stroke(past);
  if (on) dot(g, X(nowI), Y(nowI), 4 * lineScale(k), c.move, bg);
  g.globalAlpha = 1;

  // The name and where it is now.
  g.font = font(11.5 * k, 560);
  g.textBaseline = 'alphabetic';
  haloText(g, label, 10 * k, 16 * k, selected ? c.ink : c.ink2, bg, 4 * k);
  g.textAlign = 'right';
  g.font = font(11.5 * k, 500);
  haloText(g, on ? readout : 'off', tw - 8 * k, 16 * k, c.ink3, bg, 4 * k);
  g.textAlign = 'start';

  // The track: the parameter's range, the part this modulator reaches (its
  // swing either way from the resting value), and a marker where it is.
  const sx = tw + STRIP / 2;
  const ty0 = 9 * k; const ty1 = h - 9 * k;
  const Yn = (v) => ty1 - v * (ty1 - ty0);
  g.fillStyle = bg;
  g.fillRect(tw, 0, STRIP, h);
  g.strokeStyle = c.rule;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(tw + 0.5, 0); g.lineTo(tw + 0.5, h); g.stroke();
  g.lineCap = 'round';
  g.strokeStyle = alpha(c.ink3, 0.45);
  g.lineWidth = 3 * k;
  g.beginPath(); g.moveTo(sx, ty0); g.lineTo(sx, ty1); g.stroke();
  if (on) {
    const lo = norm(mod.target, place(mod.target, base, -mod.depth / 100));
    const hi = norm(mod.target, place(mod.target, base, mod.depth / 100));
    g.strokeStyle = alpha(c.move, c.dark ? 0.5 : 0.4);
    g.beginPath(); g.moveTo(sx, Yn(lo)); g.lineTo(sx, Yn(hi)); g.stroke();
    g.strokeStyle = alpha(c.ink2, 0.7);
    g.lineWidth = 1.5;
    const yb = Yn(norm(mod.target, base));
    g.beginPath(); g.moveTo(sx - 6 * k, yb); g.lineTo(sx + 6 * k, yb); g.stroke();
    dot(g, sx, Yn(norm(mod.target, now ?? base)), 4.5 * lineScale(k), sending ? c.hw : c.move, bg);
  }
  g.lineCap = 'butt';
}
