// Shared AudioContext, master bus and small helpers used by every widget.
// The context is created lazily and resumed on the first user gesture, because
// browsers refuse to start audio until someone clicks or presses a key.

let ctx = null;
let master = null;
let noiseBuffer = null;
let levelMeter = null;

// Where the page's sound goes. Chrome and Edge can send it to any output
// (AudioContext.setSinkId), such as an instrument that is also a USB audio
// interface; elsewhere it's always the system default. '' is the default.
export const canChooseOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
let sinkId = '';
let sinkLabel = '';
try {
  sinkId = localStorage.getItem('course.sink') || '';
  sinkLabel = localStorage.getItem('course.sinkLabel') || '';
} catch (_) { /* storage blocked */ }

export function outputId() { return sinkId; }
// The chosen output's name, kept so it can be shown (and undone) before the
// browser will list outputs by name.
export function outputLabel() { return sinkLabel; }

// Switch outputs. Only remembered once the browser has accepted it; throws
// (and keeps the old one) if it can't.
export async function setOutput(id, label = '') {
  if (ctx && canChooseOutput) await ctx.setSinkId(id || '');
  sinkId = id || '';
  sinkLabel = sinkId ? label : '';
  try {
    localStorage.setItem('course.sink', sinkId);
    localStorage.setItem('course.sinkLabel', sinkLabel);
  } catch (_) { /* storage blocked */ }
}

export function audio() {
  if (!ctx) {
    // iPhones mute web audio with the ring/silent switch unless told otherwise.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* not supported */ }
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

    // An output chosen last time; if it's gone (unplugged), the default stays.
    if (sinkId && canChooseOutput) ctx.setSinkId(sinkId).catch(() => {});

    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(dcBlock).connect(limiter).connect(ctx.destination);

    // A small meter on everything the page plays, so the app can tell when
    // you're making sound (to keep the screen awake while you practice).
    levelMeter = ctx.createAnalyser();
    levelMeter.fftSize = 512;
    master.connect(levelMeter);
  }
  return { ctx, master };
}

// How loud the page is right now (RMS, 0–1). 0 before any audio has started.
const meterBuf = new Float32Array(512);
export function playingLevel() {
  if (!ctx || !levelMeter || ctx.state !== 'running') return 0;
  levelMeter.getFloatTimeDomainData(meterBuf);
  let s = 0;
  for (let i = 0; i < meterBuf.length; i++) s += meterBuf[i] * meterBuf[i];
  return Math.sqrt(s / meterBuf.length);
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
