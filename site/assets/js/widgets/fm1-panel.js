// <fm1-panel> — connect the instrument over USB or Bluetooth MIDI. Named for the FM-1, but its
// labels follow the selected device (ui/device.js). Two forms:
//   <fm1-panel compact>  status lights + a button that opens the full panel
//   <fm1-panel>          the full panel inline (used in "Start here")

import { fm1 } from '../hw/fm1.js';
import { bleErrorKind } from '../hw/ble-midi.js';
import { noteName, resume } from '../audio/core.js';
import { el } from '../ui/controls.js';
import { device, deviceLabel, devName, ctl, onDeviceChange } from '../ui/device.js';

let popoverCount = 0;

function body(panel) {
  const msg = el('p', { class: 'msg', role: 'status' });
  const say = (text, error = false) => { msg.textContent = text; msg.toggleAttribute('data-error', error); };

  // MIDI
  const midiBtn = el('button', { class: 'btn hw', type: 'button', text: 'Connect MIDI' });
  const midiState = el('span', { class: 'light' }, el('span', { text: 'Not connected' }));
  const inSel = el('select', { 'aria-label': 'MIDI input (instrument keys into the page)' });
  const outSel = el('select', { 'aria-label': 'MIDI output (page to instrument)' });
  const ports = el('div', { class: 'pair' }, [
    el('label', {}, [el('span', {}, ['From ', devName(), ' (input)']), inSel]),
    el('label', {}, [el('span', {}, ['To ', devName(), ' (output)']), outSel]),
  ]);

  // Bluetooth MIDI. Web Bluetooth only exists in secure contexts, and only
  // in Chromium browsers; elsewhere the row is a one-line note instead.
  const bleBtn = el('button', { class: 'btn hw', type: 'button', text: 'Connect over Bluetooth' });
  const bleState = el('span', { class: 'light' }, el('span', { text: 'Not connected' }));
  const bleAbout = el('p');
  const bleHint = el('p', { 'data-device': 'smk37', class: 'ble-hint' },
    'On the SMK-37, switch Bluetooth on with the BT button first (check on your unit whether it needs to be in Device mode), and unpair it in the tablet’s Bluetooth settings if the list comes up empty.');
  const bleNote = el('p', { class: 'ble-note' });
  const usbNote = el('p', { text: 'Bluetooth is connected, so the page sends and listens over Bluetooth only. These USB ports take over again when it disconnects.' });
  const bleCan = fm1.supported.bluetooth;
  if (!bleCan) {
    bleNote.textContent = window.isSecureContext === false
      ? 'Bluetooth needs a secure page: open the course over https (or localhost) to connect over Bluetooth.'
      : 'This browser can’t connect over Bluetooth; try Chrome on Android, Windows, macOS or ChromeOS.';
  }
  bleBtn.hidden = !bleCan;
  bleAbout.hidden = !bleCan;
  bleHint.hidden = !bleCan;
  bleNote.hidden = bleCan;
  bleState.hidden = !bleCan;

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
  const keysPlayLab = el('label', { class: 'switch', for: keysPlay.id, style: '--c: var(--hw)' }, [keysPlay, el('span', {}, [devName(), ' keys also play the page’s synth'])]);
  const testBtn = el('button', { class: 'btn', type: 'button' }, ['Play a test note on the ', devName()]);
  const lastKey = el('span', { class: 'msg', text: '' });

  const refresh = async () => {
    const s = fm1.status;
    midiState.toggleAttribute('data-on', s.midiIn || s.midiOut);
    midiState.firstChild.textContent = s.midiIn || s.midiOut
      ? `Connected${s.outputName ? `: ${s.outputName}` : ''}` : (fm1.access ? `No ${deviceLabel()} port selected` : 'Not connected');
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

    const b = s.bluetooth;
    bleState.toggleAttribute('data-on', b === 'connected');
    bleState.firstChild.textContent = b === 'connected' ? `Bluetooth: ${s.bluetoothName}`
      : b === 'connecting' ? 'Connecting…' : b === 'reconnecting' ? 'Reconnecting…'
        : b === 'disconnected' ? 'Disconnected' : 'Not connected';
    const busy = b === 'connecting' || b === 'reconnecting';
    bleBtn.textContent = b === 'connected' ? 'Disconnect Bluetooth' : busy ? 'Connecting…' : 'Connect over Bluetooth';
    bleBtn.disabled = busy;
    usbNote.hidden = !(b === 'connected' && (fm1.input || fm1.output));
  };

  midiBtn.addEventListener('click', async () => {
    try {
      await fm1.connectMidi();
      say(fm1.output
        ? `Found the ${deviceLabel()}. Turning a slider with “Mirror to ${deviceLabel()}” on now moves its sound.`
        : `MIDI is on, but no ${deviceLabel()} port was found. Plug it in, or pick its port below.`);
    } catch (err) { say(err.message || 'MIDI permission was refused.', true); }
  });
  // Keep this handler free of awaits before connectBluetooth(): the chooser
  // only opens while the click still counts as a user gesture.
  bleBtn.addEventListener('click', () => {
    if (fm1.bleActive) {
      bleBtn.disabled = true;
      fm1.disconnectBluetooth().then(() => say(`Disconnected the ${deviceLabel()} from Bluetooth.`));
      return;
    }
    say('');
    fm1.connectBluetooth().then(() => {
      say(`Connected to ${fm1.ble.name} over Bluetooth. The page now plays the ${deviceLabel()} and moves its settings without a cable.`);
    }, (err) => {
      const name = fm1.ble?.device?.name;
      switch (bleErrorKind(err)) {
        case 'cancelled': say('No Bluetooth device chosen.'); break;
        case 'no-service': say(`${name ? `“${name}”` : 'This device'} doesn’t offer standard Bluetooth MIDI.`, true); break;
        case 'insecure': say('The browser blocked Bluetooth here. It needs a secure (https) page and a tap on the button.', true); break;
        default: say(`Couldn’t connect to ${name ? `“${name}”` : `the ${deviceLabel()}`} over Bluetooth. Check it’s switched on, nearby and not connected to another app, then try again.`, true);
      }
    });
  });
  fm1.addEventListener('bluetooth', (e) => {
    const { state, reason, name } = e.detail;
    if (state === 'reconnecting') say(`Lost the Bluetooth connection to ${name}. Reconnecting…`);
    else if (state === 'connected' && reason === 'reconnected') say(`Reconnected to ${name} over Bluetooth.`);
    else if (state === 'disconnected') say(`${name} disconnected from Bluetooth. Press Connect over Bluetooth to try again.`, true);
  });
  inSel.addEventListener('change', () => fm1.selectInput(inSel.value || null));
  outSel.addEventListener('change', () => fm1.selectOutput(outSel.value || null));

  audioBtn.addEventListener('click', async () => {
    if (fm1.stream) { fm1.disconnectAudio(); return; }
    try {
      await resume();
      await fm1.connectAudio();
      const label = fm1.status.audioName || '';
      say(fm1.isDeviceAudio ? `Listening to the ${deviceLabel()}. Its signal draws in purple on every scope.` : `Listening to “${label}”. If that isn’t the ${deviceLabel()}, pick it from the list.`);
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
    say(`Sent middle C. If the ${deviceLabel()} played it, the output port is right.`);
  });

  fm1.addEventListener('change', refresh);
  fm1.addEventListener('noteon', (e) => { lastKey.textContent = `Last key from the ${deviceLabel()}: ${noteName(e.detail.note)}`; });

  const heading = el('h3');
  const intro = el('p');
  const chNote = el('p');
  const words = () => {
    const d = deviceLabel();
    heading.textContent = `Connect ${device().article || 'a'} ${d}`;
    intro.textContent = `Plug it in with a ${device().cable || 'USB'} data cable. MIDI lets the page play the ${d} and set its Virtual Analog controls; audio lets the page draw what the ${d} is really doing. Both are optional.`;
    bleAbout.textContent = `No cable needed: if the ${d} has Bluetooth MIDI, the page can connect to it directly. While Bluetooth is connected the page uses it instead of USB.`;
    chNote.textContent = d === 'FM-1'
      ? 'These match GLO › MIDI on the FM-1. The defaults (All and 2) work without changes.'
      : `These match ${ctl('GLO')} › MIDI on the ${d}. If notes play but settings don’t move, check the channels there.`;
  };
  words();
  onDeviceChange(() => { words(); refresh(); });

  const node = el('div', { class: 'fm1-body' }, [
    heading,
    intro,
    el('div', { class: 'fm1-row' }, [el('div', { class: 'row-head' }, [el('strong', { text: 'MIDI' }), midiState]), midiBtn, ports, usbNote]),
    el('hr'),
    el('div', { class: 'fm1-row' }, [el('div', { class: 'row-head' }, [el('strong', { text: 'Bluetooth MIDI' }), bleState]), bleAbout, bleBtn, bleHint, bleNote]),
    el('hr'),
    el('div', { class: 'fm1-row' }, [el('div', { class: 'row-head' }, [el('strong', { text: 'Audio' }), audioState]), audioBtn, el('label', { class: 'pair', style: 'grid-template-columns:1fr' }, [devSel]), monitorLab]),
    el('hr'),
    el('div', { class: 'fm1-row' }, [
      el('strong', { text: 'Settings' }),
      el('div', { class: 'pair' }, [
        el('label', {}, [el('span', { text: 'MIDI channel' }), midiCh]),
        el('label', {}, [el('span', { text: 'FX channel' }), fxCh]),
      ]),
      chNote,
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
    const btn = el('button', { class: 'btn hw', type: 'button', popovertarget: id, text: deviceLabel() });
    const pop = el('div', { id, popover: 'auto', class: 'fm1-popover' }, body(this));
    const lights = el('span', { class: 'lights' }, [midi, aud]);
    this.append(el('div', { class: 'fm1-chip' }, [lights, btn]), pop);
    const update = () => {
      const s = fm1.status;
      const d = deviceLabel();
      midi.toggleAttribute('data-on', s.midiIn || s.midiOut);
      aud.toggleAttribute('data-on', s.audio);
      btn.textContent = s.midiOut || s.audio ? d : `Connect ${d}`;
      lights.setAttribute('aria-label', `${d} status`);
    };
    fm1.addEventListener('change', update);
    onDeviceChange(update);
    fm1.addEventListener('noteon', () => {
      midi.setAttribute('data-flash', '');
      clearTimeout(this._flash);
      this._flash = setTimeout(() => midi.removeAttribute('data-flash'), 120);
    });
    update();
  }
}

customElements.define('fm1-panel', FM1Panel);
