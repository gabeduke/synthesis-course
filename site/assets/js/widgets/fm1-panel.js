// <fm1-panel> — connect an FM-1 over USB. Two forms:
//   <fm1-panel compact>  status lights + a button that opens the full panel
//   <fm1-panel>          the full panel inline (used in "Start here")

import { fm1 } from '../hw/fm1.js';
import { noteName, resume } from '../audio/core.js';
import { el } from '../ui/controls.js';

let popoverCount = 0;

function body(panel) {
  const msg = el('p', { class: 'msg', role: 'status' });
  const say = (text, error = false) => { msg.textContent = text; msg.toggleAttribute('data-error', error); };

  // MIDI
  const midiBtn = el('button', { class: 'btn hw', type: 'button', text: 'Connect MIDI' });
  const midiState = el('span', { class: 'light' }, el('span', { text: 'Not connected' }));
  const inSel = el('select', { 'aria-label': 'MIDI input (FM-1 keys into the page)' });
  const outSel = el('select', { 'aria-label': 'MIDI output (page to FM-1)' });
  const ports = el('div', { class: 'pair' }, [
    el('label', {}, [el('span', { text: 'From FM-1 (input)' }), inSel]),
    el('label', {}, [el('span', { text: 'To FM-1 (output)' }), outSel]),
  ]);

  // Audio
  const audioBtn = el('button', { class: 'btn hw', type: 'button', text: 'Listen to its audio' });
  const audioState = el('span', { class: 'light' }, el('span', { text: 'Not listening' }));
  const devSel = el('select', { 'aria-label': 'Audio input' });
  const monitor = el('input', { type: 'checkbox', id: `mon-${++popoverCount}` });
  const monitorLab = el('label', { class: 'switch', for: monitor.id, style: '--c: var(--hw)' }, [monitor, el('span', { text: 'Also play it through this page (use headphones)' })]);

  // Settings
  const midiCh = el('input', { type: 'number', min: 1, max: 16, value: fm1.midiChannel });
  const fxCh = el('input', { type: 'number', min: 1, max: 16, value: fm1.fxChannel });
  const keysPlay = el('input', { type: 'checkbox', id: `kp-${popoverCount}` });
  keysPlay.checked = fm1.keysPlayPage;
  const keysPlayLab = el('label', { class: 'switch', for: keysPlay.id, style: '--c: var(--hw)' }, [keysPlay, el('span', { text: 'FM-1 keys also play the page’s synth' })]);
  const testBtn = el('button', { class: 'btn', type: 'button', text: 'Play a test note on the FM-1' });
  const lastKey = el('span', { class: 'msg', text: '' });

  const refresh = async () => {
    const s = fm1.status;
    midiState.toggleAttribute('data-on', s.midiIn || s.midiOut);
    midiState.firstChild.textContent = s.midiIn || s.midiOut
      ? `Connected${s.outputName ? `: ${s.outputName}` : ''}` : (fm1.access ? 'No FM-1 port selected' : 'Not connected');
    midiBtn.hidden = !!fm1.access;
    ports.hidden = !fm1.access;
    const { inputs, outputs } = fm1.ports();
    const fill = (sel, list, current) => {
      sel.replaceChildren(el('option', { value: '', text: 'None' }), ...list.map((p) => el('option', { value: p.id, text: p.name })));
      sel.value = current?.id || '';
    };
    fill(inSel, inputs, fm1.input);
    fill(outSel, outputs, fm1.output);

    audioState.toggleAttribute('data-on', s.audio);
    audioState.firstChild.textContent = s.audio ? `Listening: ${s.audioName || 'audio input'}` : 'Not listening';
    audioBtn.textContent = s.audio ? 'Stop listening' : 'Listen to its audio';
    monitorLab.hidden = !s.audio;
    devSel.parentElement.hidden = !s.audio;
    if (s.audio) {
      const devs = await fm1.audioInputs();
      const current = fm1.stream?.getAudioTracks()[0]?.getSettings().deviceId;
      devSel.replaceChildren(...devs.map((d, i) => el('option', { value: d.deviceId, text: d.label || `Input ${i + 1}` })));
      devSel.value = current || '';
    }
    testBtn.disabled = !s.midiOut;
  };

  midiBtn.addEventListener('click', async () => {
    try {
      await fm1.connectMidi();
      say(fm1.output ? 'Found the FM-1. Turning a slider with “Mirror to FM-1” on now moves its sound.' : 'MIDI is on, but no FM-1 port was found. Plug it in, or pick its port below.');
    } catch (err) { say(err.message || 'MIDI permission was refused.', true); }
  });
  inSel.addEventListener('change', () => fm1.selectInput(inSel.value || null));
  outSel.addEventListener('change', () => fm1.selectOutput(outSel.value || null));

  audioBtn.addEventListener('click', async () => {
    if (fm1.stream) { fm1.disconnectAudio(); return; }
    try {
      await resume();
      await fm1.connectAudio();
      const label = fm1.status.audioName || '';
      say(/fm-?1/i.test(label) ? 'Listening to the FM-1. Its signal draws in purple on every scope.' : `Listening to “${label}”. If that isn’t the FM-1, pick it from the list.`);
    } catch (err) {
      say(err.name === 'NotAllowedError' ? 'Audio permission was refused. Allow microphone access for this site to listen.' : (err.message || 'Couldn’t open the audio input.'), true);
    }
  });
  devSel.addEventListener('change', async () => {
    try { await fm1.connectAudio(devSel.value); } catch (err) { say(err.message, true); }
  });
  monitor.addEventListener('change', () => fm1.monitor(monitor.checked));
  const setCh = () => fm1.setChannels(midiCh.value, fxCh.value);
  midiCh.addEventListener('change', setCh);
  fxCh.addEventListener('change', setCh);
  keysPlay.addEventListener('change', () => fm1.setKeysPlayPage(keysPlay.checked));
  testBtn.addEventListener('click', () => {
    fm1.noteOn(60, 0.8);
    setTimeout(() => fm1.noteOff(60), 600);
    say('Sent middle C. If the FM-1 played it, the output port is right.');
  });

  fm1.addEventListener('change', refresh);
  fm1.addEventListener('noteon', (e) => { lastKey.textContent = `Last key from the FM-1: ${noteName(e.detail.note)}`; });

  const node = el('div', { class: 'fm1-body' }, [
    el('h3', { text: 'Connect an FM-1' }),
    el('p', { text: 'Plug it in with a USB-C data cable. MIDI lets the page play the FM-1 and set its Virtual Analog controls; audio lets the page draw what the FM-1 is really doing. Both are optional.' }),
    el('div', { class: 'fm1-row' }, [el('div', { class: 'row-head' }, [el('strong', { text: 'MIDI' }), midiState]), midiBtn, ports]),
    el('hr'),
    el('div', { class: 'fm1-row' }, [el('div', { class: 'row-head' }, [el('strong', { text: 'Audio' }), audioState]), audioBtn, el('label', { class: 'pair', style: 'grid-template-columns:1fr' }, [devSel]), monitorLab]),
    el('hr'),
    el('div', { class: 'fm1-row' }, [
      el('strong', { text: 'Settings' }),
      el('div', { class: 'pair' }, [
        el('label', {}, [el('span', { text: 'MIDI channel' }), midiCh]),
        el('label', {}, [el('span', { text: 'FX channel' }), fxCh]),
      ]),
      el('p', { text: 'These match GLO › MIDI on the FM-1. The defaults (All and 2) work without changes.' }),
      keysPlayLab,
      el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, [testBtn, lastKey]),
    ]),
    msg,
  ]);
  if (!fm1.supported.midi) say('This browser has no Web MIDI. Chrome, Edge or Firefox on a computer will work.', true);
  refresh();
  return node;
}

class FM1Panel extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    if (this.hasAttribute('compact')) this._compact();
    else {
      this.classList.add('inline');
      const wrap = el('section', { class: 'instrument' }, body(this));
      this.append(wrap);
    }
  }

  _compact() {
    const midi = el('span', { class: 'light' }, el('span', { text: 'MIDI' }));
    const aud = el('span', { class: 'light' }, el('span', { text: 'Audio' }));
    const id = `fm1-pop-${++popoverCount}`;
    const btn = el('button', { class: 'btn hw', type: 'button', popovertarget: id, text: 'FM-1' });
    const pop = el('div', { id, popover: 'auto', class: 'fm1-popover' }, body(this));
    this.append(el('div', { class: 'fm1-chip' }, [el('span', { class: 'lights', 'aria-label': 'FM-1 status' }, [midi, aud]), btn]), pop);
    const update = () => {
      const s = fm1.status;
      midi.toggleAttribute('data-on', s.midiIn || s.midiOut);
      aud.toggleAttribute('data-on', s.audio);
      btn.textContent = s.midiOut || s.audio ? 'FM-1' : 'Connect FM-1';
    };
    fm1.addEventListener('change', update);
    fm1.addEventListener('noteon', () => {
      midi.setAttribute('data-flash', '');
      clearTimeout(this._flash);
      this._flash = setTimeout(() => midi.removeAttribute('data-flash'), 120);
    });
    update();
  }
}

customElements.define('fm1-panel', FM1Panel);
