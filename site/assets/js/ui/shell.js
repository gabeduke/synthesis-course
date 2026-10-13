// Fills in the header, the lesson rail and the previous/next links, so each
// lesson page only has to carry its own content.

import { LESSONS, EXTRAS } from './lessons.js';
import { el } from './controls.js';
import { fm1 } from '../hw/fm1.js';

const root = document.documentElement.dataset.root || '.';
const href = (file) => `${root}/${file}`;
const here = location.pathname.replace(/index\.html$/, '');
const isCurrent = (file) => here.endsWith(`/${file}`) || here.endsWith(`/${file.replace(/\.html$/, '')}`);

function visited() {
  try { return new Set(JSON.parse(localStorage.getItem('course.visited') || '[]')); } catch (_) { return new Set(); }
}
function markVisited(file) {
  try {
    const v = visited(); v.add(file);
    localStorage.setItem('course.visited', JSON.stringify([...v]));
  } catch (_) { /* storage blocked */ }
}

const WAVE_MARK = `<svg viewBox="0 0 34 18" aria-hidden="true"><path d="M1 13 L9 4 L9 13 L17 4 L17 13 L25 4 L25 13 L33 4" fill="none" stroke="var(--sound)" stroke-width="2.2" stroke-linejoin="round"/></svg>`;

function header() {
  const h = document.getElementById('site-header');
  if (!h) return;
  h.classList.add('site-header');
  const mark = el('a', { class: 'wordmark', href: href('index.html') });
  mark.innerHTML = `${WAVE_MARK}<span>Signal Path</span>`;
  h.replaceChildren(mark, el('div', { class: 'spacer' }), el('fm1-panel', { compact: true }));
}

function rail() {
  const nav = document.getElementById('rail');
  if (!nav) return;
  nav.classList.add('rail');
  nav.setAttribute('aria-label', 'Lessons');
  const seen = visited();
  const current = LESSONS.find((l) => isCurrent(l.file));
  const list = el('ol');
  for (const l of LESSONS) {
    const a = el('a', { href: href(l.file) }, [el('span', { class: 'node', text: String(l.n) }), el('span', { text: l.title })]);
    if (current === l) a.setAttribute('aria-current', 'page');
    if (seen.has(l.file)) a.setAttribute('data-visited', '');
    list.append(el('li', {}, a));
  }
  const extra = el('div', { class: 'extra' });
  for (const x of EXTRAS) {
    const a = el('a', { href: href(x.file), text: x.title });
    if (isCurrent(x.file)) a.setAttribute('aria-current', 'page');
    extra.append(a);
  }
  const details = el('details', {}, [el('summary', { text: current ? `Lesson ${current.n}: ${current.title}` : 'Lessons' }), list, extra]);
  if (window.matchMedia('(min-width: 961px)').matches) details.open = true;
  nav.replaceChildren(details);
  if (current) markVisited(current.file);
}

function pager() {
  const main = document.querySelector('main');
  const i = LESSONS.findIndex((l) => isCurrent(l.file));
  if (!main || i < 0) return;
  const prev = LESSONS[i - 1];
  const next = LESSONS[i + 1];
  const nav = el('nav', { class: 'pager', 'aria-label': 'Previous and next lesson' });
  if (prev) nav.append(el('a', { class: 'prev', href: href(prev.file) }, [el('span', { text: 'Previous' }), el('strong', { text: prev.title })]));
  if (next) nav.append(el('a', { class: 'next', href: href(next.file) }, [el('span', { text: 'Next' }), el('strong', { text: next.title })]));
  main.append(nav);
}

header();
rail();
pager();
fm1.autoConnect();
