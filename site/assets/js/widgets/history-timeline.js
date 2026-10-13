// <history-timeline> — the course's history notes in one filterable list.
// Dates were checked against primary or well-sourced references; where sources
// disagree, the entry gives the range.

import { el } from '../ui/controls.js';

const FAMILIES = {
  theory: { label: 'Theory', color: 'var(--ink-2)' },
  additive: { label: 'Additive', color: 'var(--sound)' },
  subtractive: { label: 'Subtractive', color: 'var(--sound)' },
  modulation: { label: 'Modulation', color: 'var(--move)' },
  space: { label: 'Effects and space', color: 'var(--space)' },
  fm: { label: 'FM', color: 'var(--hw)' },
  digital: { label: 'Digital and VA', color: 'var(--time)' },
  chip: { label: '8-Bit', color: 'var(--time)' },
};

export const EVENTS = [
  { year: '1822', fam: 'theory', title: 'Fourier', text: 'Joseph Fourier’s Analytical Theory of Heat shows that repeating signals can be written as sums of sine waves. Every spectrum in this course rests on it.', lesson: 1 },
  { year: '1863', fam: 'theory', title: 'Helmholtz on tone', text: 'Hermann von Helmholtz uses tuned resonators to pick out the partials in a sound and argues that timbre is the mix of those partials.', lesson: 1 },
  { year: '1897–1906', fam: 'additive', title: 'The Telharmonium', text: 'Thaddeus Cahill’s 200-ton machine builds tones from spinning electrical alternators, adding harmonics together: additive synthesis, decades early.', lesson: 1 },
  { year: '1900', fam: 'space', title: 'Sabine and reverberation', text: 'Wallace Sabine publishes his formula for how long a room rings, founding architectural acoustics.', lesson: 7 },
  { year: '1935', fam: 'additive', title: 'Hammond organ', text: 'Each drawbar sets the level of one tonewheel partial, so players mix harmonics by hand.', lesson: 2 },
  { year: '1941', fam: 'modulation', title: 'The Leslie speaker', text: 'A rotating speaker adds swirling pitch and loudness movement, a mechanical cousin of the LFO.', lesson: 5 },
  { year: '1947', fam: 'space', title: 'The bathroom echo chamber', text: 'Bill Putnam uses a studio washroom as an echo chamber on “Peg o’ My Heart”. Studios soon build dedicated chambers.', lesson: 7 },
  { year: '1957', fam: 'space', title: 'EMT 140 plate', text: 'A large steel plate set vibrating by the signal becomes the studio reverb of the era.', lesson: 7 },
  { year: '1959', fam: 'space', title: 'Echoplex', text: 'A tape loop with movable heads makes echo portable for performers.', lesson: 7 },
  { year: '1964', fam: 'subtractive', title: 'Moog’s voltage-controlled modules', text: 'Robert Moog presents voltage-controlled modules at the AES convention. Oscillators, filters and amplifiers that control each other become the standard synth.', lesson: 2 },
  { year: '1963–66', fam: 'subtractive', title: 'Buchla 100 series', text: 'Don Buchla’s first modular instruments start a separate tradition, later called West Coast synthesis. By the 1970s his complex oscillators and wavefolders shape tone at the source rather than carving it with filters.', lesson: 3 },
  { year: '1965', fam: 'subtractive', title: 'The ADSR envelope', text: 'Vladimir Ussachevsky specifies a four-stage envelope for Moog, built as the 911 module. ARP later popularizes the name ADSR.', lesson: 4 },
  { year: '1966–69', fam: 'subtractive', title: 'The Moog ladder filter', text: 'Filed in 1966 and granted in 1969, the four-stage, 24 dB per octave low-pass becomes the most imitated filter in synthesis.', lesson: 3 },
  { year: '1967–73', fam: 'fm', title: 'Chowning discovers FM', text: 'At Stanford, John Chowning finds that very fast vibrato produces new tones. His 1973 paper, “The Synthesis of Complex Audio Spectra by Means of Frequency Modulation”, lays it out, and Stanford licenses it to Yamaha the following year.', lesson: 8 },
  { year: '1970–71', fam: 'subtractive', title: 'Minimoog Model D', text: 'A portable, prewired synth. Musicians who never touched a patch cable start playing synthesizers on stage.', lesson: 3 },
  { year: '1974', fam: 'modulation', title: 'String machines', text: 'The Solina String Ensemble passes its tone through modulated bucket-brigade delays, the “ensemble” effect behind countless string pads.', lesson: 7 },
  { year: '1974', fam: 'space', title: 'Roland Space Echo', text: 'The RE-201 tape echo, with spring reverb built in, becomes a staple of dub, reggae and much else.', lesson: 7 },
  { year: '1975–76', fam: 'modulation', title: 'Chorus', text: 'Roland’s JC-120 amp (1975) and Boss CE-1 pedal (1976) bring chorus to guitarists, then to everyone.', lesson: 7 },
  { year: '1976–78', fam: 'space', title: 'Digital reverb', text: 'The EMT 250 (1976) and Lexicon 224 (1978) replace plates and chambers with computed rooms.', lesson: 7 },
  { year: '1978', fam: 'subtractive', title: 'Prophet-5', text: 'Sequential Circuits’ five-voice synth stores whole patches in memory. Early units drift in tuning; later revisions are steadier but are sometimes called colder.', lesson: 6 },
  { year: '1981–84', fam: 'subtractive', title: 'Roland TB-303', text: 'A commercial flop as a bass accompanist, its squelching resonant filter later defines acid house: Phuture’s “Acid Tracks”, recorded 1985, released 1987.', lesson: 3 },
  { year: '1982', fam: 'modulation', title: 'Juno chorus', text: 'The Juno-6 and Juno-60 put a two-speed bucket-brigade chorus on a single-oscillator synth, and it sounds enormous.', lesson: 7 },
  { year: '1983', fam: 'fm', title: 'Yamaha DX7', text: 'Six operators, 32 algorithms, and the electric piano and bell sounds of the decade. The FM-1’s FM engine follows the same layout.', lesson: 8 },
  { year: '1983–85', fam: 'chip', title: 'Famicom and NES', text: 'Nintendo’s console sound chip offers two pulse channels with four widths, a stepped triangle and a noise channel. Composers fake chords with fast arpeggios.', lesson: 9 },
  { year: '1989', fam: 'chip', title: 'Game Boy', text: 'Adds a wave channel that plays any 32-step, 4-bit waveform. The FM-1’s GB waves are modeled on it.', lesson: 9 },
  { year: '1995', fam: 'digital', title: 'Nord Lead', text: 'Clavia’s virtual analog synth computes analog-style oscillators and filters in software, and popularizes the term.', lesson: 2 },
  { year: '1996', fam: 'digital', title: 'Roland JP-8000 Super Saw', text: 'Seven detuned saws in one oscillator. Trance producers make it the sound of the late 1990s. The FM-1+VA’s Super models its curves on a ’90s virtual analog synth with the same seven-copy recipe.', lesson: 6 },
  { year: '2001', fam: 'digital', title: 'Band-limited steps', text: 'Eli Brandt describes BLEP, a way to draw sharp-edged digital waveforms without harsh aliasing. The FM-1+VA’s oscillators use the technique.', lesson: 2 },
  { year: '2010', fam: 'digital', title: 'The Super Saw, measured', text: 'Adam Szabo’s thesis maps the JP-8000’s detune and mix curves. This course’s Super model uses his measurements.', lesson: 6 },
];

class HistoryTimeline extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    const root = document.documentElement.dataset.root || '.';
    const filters = el('div', { class: 'timeline-filter seg neutral', role: 'group', 'aria-label': 'Show' });
    let active = 'all';
    const list = el('div', { class: 'lanes' });
    const render = () => {
      list.replaceChildren(...EVENTS.filter((e) => active === 'all' || e.fam === active).map((e) => {
        const fam = FAMILIES[e.fam];
        const lesson = String(e.lesson).padStart(2, '0');
        return el('article', { class: 'era' }, [
          el('div', { class: 'year', text: e.year }),
          el('div', { class: 'ev' }, [
            Object.assign(el('span', { class: 'tag', text: fam.label }), { style: `background:${fam.color}` }),
            el('strong', { text: e.title }),
            el('p', { text: e.text }),
            el('a', { href: `${root}/lessons/${lesson}-${['start', 'sound', 'oscillators', 'filters', 'envelopes', 'lfo', 'unison', 'space', 'fm', '8bit'][e.lesson]}.html`, text: `Lesson ${e.lesson}`, style: 'font-size:0.85rem' }),
          ]),
        ]);
      }));
    };
    for (const [key, label] of [['all', 'Everything'], ...Object.entries(FAMILIES).map(([k, v]) => [k, v.label])]) {
      const b = el('button', { type: 'button', text: label, 'aria-pressed': String(key === active) });
      b.addEventListener('click', () => {
        active = key;
        for (const x of filters.children) x.setAttribute('aria-pressed', String(x === b));
        render();
      });
      filters.append(b);
    }
    render();
    this.append(el('div', { class: 'timeline' }, [filters, list]));
  }
}

customElements.define('history-timeline', HistoryTimeline);
