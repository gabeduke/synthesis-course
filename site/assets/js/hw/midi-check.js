// What happened the last time the page asked for USB MIDI, in words for the
// screen: what Chrome answered, what it can see, and what to try next. Facts
// in, text out, so it is tested in Node; hw/fm1.js gathers the facts.
//
// facts: {
//   midi        the browser has Web MIDI
//   app         running as the installed app, not in a tab
//   browser     'Chrome 142 · Android 15 · Pixel 8', or '' if unknown
//   permission  'granted', 'denied', 'prompt', or undefined (can't ask)
//   attempt     null, or { state: 'waiting' | 'ok' | 'failed', slow, ms,
//               tries, at (a Date.now() time), error: { name, message } }
//   inputs, outputs  [{ name, manufacturer, state }]
//   using       the name of the output port in use, or null
//   device      the instrument's name ('FM-1')
//   sound       whether this phone is making sound itself
// }
//
// Returns null before the first attempt, otherwise { level, title, steps,
// stamp, details }. level is 'ok', 'wait' (still asking) or 'problem' (wants
// a Try again); details is plain text to copy.

const live = (p) => p.state === 'connected';
const time = (at) => new Date(at).toTimeString().slice(0, 8);

export function explainConnect(f) {
  const a = f.attempt;
  if (f.midi && !a) return null;
  const outs = (f.outputs || []).filter(live);
  const device = f.device || 'instrument';
  let level = 'problem';
  let title;
  let steps = [];

  if (!f.midi) {
    title = 'This browser has no Web MIDI.';
    steps = ['Open the page in Chrome. On a phone that means Chrome on Android: iPhones can’t do USB MIDI in a browser.'];
  } else if (a.state === 'waiting' && !a.slow) {
    level = 'wait';
    title = 'Asking Chrome for MIDI…';
  } else if (a.state === 'waiting') {
    title = 'Chrome hasn’t answered.';
    steps = [
      'Look for a question from Chrome about MIDI devices, at the top or bottom of the screen, and allow it.',
      f.app
        ? 'If there isn’t one, open the page in a Chrome tab, allow MIDI there, then come back to the app.'
        : 'If there isn’t one, tap the icon at the left of the address bar and allow MIDI devices.',
      'If that doesn’t help, close Chrome completely (swipe it away from recent apps), open the page again and tap Try again.',
    ];
  } else if (a.state === 'failed') {
    const { name, message } = a.error;
    if (name === 'NotAllowedError' || name === 'SecurityError' || f.permission === 'denied') {
      title = 'Chrome is blocking MIDI for this page.';
      steps = [
        f.app
          ? 'In Chrome, open ⋮ › Settings › Site settings, find MIDI and allow this site.'
          : 'Tap the icon at the left of the address bar, then Permissions, and allow MIDI devices.',
        'Then tap Try again.',
      ];
    } else if (name === 'UnknownError' || /initiali[sz]ation failed/i.test(message)) {
      // On Android, Chrome asks the system's MIDI service for the devices and
      // opens each one; this is that service failing (Chromium's
      // MidiManagerAndroid.java), before the page sees any port.
      title = 'Android’s MIDI service failed when Chrome asked it for MIDI devices.';
      steps = [
        `Unplug the ${device}. Close Chrome completely (swipe it away from recent apps, and the installed app too).`,
        `Plug the ${device} back in, open the page again and tap Try again.`,
        `If the ${device} itself lags or freezes while it’s plugged in, the trouble is between the phone and the ${device}, not this page. Play over Bluetooth for now.`,
        f.app
          ? 'If it still fails, try the page in a Chrome tab and see whether it says the same.'
          : 'If it still fails, try the installed app and see whether it says the same.',
      ];
    } else {
      title = `Chrome refused MIDI (${name}).`;
      steps = ['Tap Try again. If it says the same, close Chrome completely and open the page again.'];
    }
  } else if (f.using) {
    level = 'ok';
    title = `Connected over USB: ${f.using}.`;
  } else if (!outs.length) {
    title = 'Chrome has MIDI, but sees nothing plugged in.';
    steps = [
      `Check the ${device} is switched on.`,
      'Use a cable that carries data: many USB-C cables only charge. One that moves files to a computer will do.',
      'If Android shows a USB notification, open it and set “USB controlled by” to “This device”.',
      'Unplug it and plug it back in. The page picks it up by itself.',
    ];
  } else {
    title = `Chrome sees ${outs.length === 1 ? 'a MIDI port' : `${outs.length} MIDI ports`}, but none named ${device}.`;
    steps = ['Choose it under MIDI port.'];
  }

  // Which try this is, so a tap that gets the same answer still shows it was heard.
  const stamp = a ? `Try ${a.tries}, ${time(a.at)}` : '';
  return { level, title, steps, stamp, details: details(f) };
}

// The facts as plain lines, for the Copy details button.
function details(f) {
  const a = f.attempt;
  const lines = [`MIDI check${a ? `, ${time(a.at)}` : ''}`];
  lines.push([f.browser || 'Browser unknown', f.app ? 'installed app' : 'tab'].join(' · '));
  lines.push(`Web MIDI: ${f.midi ? 'yes' : 'no'} · permission: ${f.permission ?? 'unknown'}`);
  if (a) {
    const took = a.ms === undefined ? '' : ` after ${a.ms} ms`;
    const what = { waiting: `waiting${a.slow ? ', no answer yet' : ''}`, ok: `ok${took}`, failed: `failed${took}` }[a.state];
    lines.push(`Try ${a.tries}: ${what}`);
    if (a.error) lines.push(`  ${a.error.name}: ${a.error.message}`);
  }
  const port = (p) => {
    const extra = [p.manufacturer, live(p) ? '' : p.state].filter(Boolean).join(', ');
    return `  ${p.name || '(no name)'}${extra ? ` (${extra})` : ''}${p.name && p.name === f.using ? ' ← in use' : ''}`;
  };
  for (const [label, list] of [['Outputs', f.outputs], ['Inputs', f.inputs]]) {
    lines.push(`${label}: ${list?.length ? '' : 'none'}`.trimEnd());
    for (const p of list || []) lines.push(port(p));
  }
  lines.push(`This phone making sound: ${f.sound ? 'yes' : 'no'}`);
  return lines.join('\n');
}
