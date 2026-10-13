// Shared AudioContext, master bus and small helpers used by every widget.
// The context is created lazily and resumed on the first user gesture, because
// browsers refuse to start audio until someone clicks or presses a key.

let ctx = null;
let master = null;
let noiseBuffer = null;

export function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

    // Gentle protection so stacked voices and resonance never blast anyone's ears.
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 12;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(dcBlock).connect(limiter).connect(ctx.destination);
  }
  return { ctx, master };
}

export async function resume() {
  const { ctx } = audio();
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch (_) { /* ignored: retried on next gesture */ }
  }
  return ctx;
}

// Resume on the first interaction anywhere on the page.
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => { if (ctx) resume(); }, { capture: true, passive: true });
}

export function noise() {
  const { ctx } = audio();
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

export const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const centsFromRatio = (r) => 1200 * Math.log2(r);

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (n) => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

// Exponential mapping from a 0–100 control to a time in seconds.
export const expTime = (v, min, max) => min * Math.pow(max / min, clamp(v, 0, 100) / 100);

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
