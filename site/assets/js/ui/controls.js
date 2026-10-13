// Builds labelled sliders, segmented choices and switches from the PARAMS
// schema. Each control reports changes through onChange(key, value) and can be
// moved from outside with control.update(value).

import { PARAMS, formatValue } from './params.js';

let uid = 0;
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
};
export { el };

// Log sliders run 0–1000 internally.
const toPos = (def, v) => def.type === 'log'
  ? Math.round((Math.log(v / def.min) / Math.log(def.max / def.min)) * 1000) : v;
const fromPos = (def, p) => def.type === 'log'
  ? def.min * Math.pow(def.max / def.min, p / 1000) : p;

export function makeControl(key, value, onChange, { label, def: override } = {}) {
  const def = { ...PARAMS[key], ...(override || {}) };
  if (!def.label && !label) throw new Error(`Unknown control: ${key}`);
  const id = `ctl-${++uid}`;
  const wrap = el('div', { class: 'ctl', 'data-kind': def.kind || 'sound', 'data-key': key });
  const name = label || def.label;

  if (def.type === 'choice') {
    const labelEl = el('span', { class: 'ctl-name', id, text: name });
    const seg = el('div', { class: 'seg', role: 'group', 'aria-labelledby': id });
    const buttons = def.options.map((opt, i) => {
      const b = el('button', { type: 'button', text: def.names[i], 'aria-pressed': String(opt === value) });
      b.addEventListener('click', () => { update(opt); onChange(key, opt); });
      seg.append(b);
      return b;
    });
    const update = (v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(def.options[i] === v)));
    wrap.append(el('div', { class: 'ctl-top' }, [labelEl]), seg);
    wrap.update = update;
    return wrap;
  }

  if (def.type === 'bool') {
    const input = el('input', { type: 'checkbox', id, role: 'switch' });
    input.checked = !!value;
    input.addEventListener('change', () => onChange(key, input.checked));
    const lab = el('label', { class: 'switch', for: id }, [input, el('span', { text: name })]);
    wrap.append(lab);
    wrap.update = (v) => { input.checked = !!v; };
    return wrap;
  }

  const input = el('input', {
    type: 'range', id,
    min: def.type === 'log' ? 0 : def.min,
    max: def.type === 'log' ? 1000 : def.max,
    step: def.step ?? 1,
  });
  const out = el('output', { for: id });
  const paint = (v) => {
    const pos = toPos(def, v);
    const lo = Number(input.min); const hi = Number(input.max);
    input.style.setProperty('--fill', `${((pos - lo) / (hi - lo)) * 100}%`);
    out.textContent = formatValue(key, v) ?? '';
    if (def.format && !PARAMS[key]) out.textContent = def.format(v);
  };
  input.value = toPos(def, value);
  paint(value);
  input.addEventListener('input', () => {
    const v = fromPos(def, Number(input.value));
    paint(v);
    onChange(key, v);
  });
  wrap.append(el('div', { class: 'ctl-top' }, [el('label', { for: id, text: name }), out]), input);
  wrap.update = (v) => { input.value = toPos(def, v); paint(v); };
  return wrap;
}
