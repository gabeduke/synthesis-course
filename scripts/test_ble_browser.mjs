// Browser test for Bluetooth MIDI in the connection panel, against a fake
// Web Bluetooth device. Also checks the USB (Web MIDI) path with a fake port,
// and that every lesson loads without console errors on both devices.
//
//     NODE_PATH=$(npm root -g) node scripts/test_ble_browser.mjs
//
// Needs Playwright with a Chromium build (set PW_CHROMIUM to its executable
// if Playwright can't find one). Serves site/ itself on a free port.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(SITE, p);
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

// ---- fakes, installed before any page script runs ----
function fakeBluetooth(opts) {
  const SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
  const log = { writes: [], requests: [], connects: 0, overlaps: 0 };
  window.__ble = log;
  window.__bleOpts = opts;
  // Short waits so the retry loop is quick to test (the page reads these).
  window.__bleRetryDelays = [20, 20, 20];
  window.__bleAttemptTimeout = opts.attemptTimeout;
  if (opts.absent) {
    Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => undefined, configurable: true });
    return;
  }
  class Char extends EventTarget {
    constructor() { super(); this.value = null; this.busy = false; }
    async startNotifications() { log.notifying = true; return this; }
    async stopNotifications() { log.notifying = false; return this; }
    async writeValueWithoutResponse(buf) {
      // Mimic Chrome: overlapping GATT operations fail.
      if (this.busy) log.overlaps++;
      if (this.busy) throw new DOMException('GATT operation already in progress.', 'NetworkError');
      this.busy = true;
      await new Promise((r) => setTimeout(r, 2));
      this.busy = false;
      log.writes.push([...new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength)]);
    }
  }
  const ch = new Char();
  const device = new EventTarget();
  device.id = 'fake-ble-1';
  device.name = opts.name || 'SMK-37 BLE';
  device.gatt = {
    connected: false,
    device,
    async connect() {
      log.connects++;
      if (opts.failConnect) throw new DOMException('Connection attempt failed.', 'NetworkError');
      if (opts.failReconnect && log.connects > 1) throw new DOMException('Connection failed for unknown reason.', 'NetworkError');
      if (opts.failReconnectsUntil && log.connects > 1 && log.connects <= opts.failReconnectsUntil) throw new DOMException('Connection failed for unknown reason.', 'NetworkError');
      if (opts.hangReconnect && log.connects > 1) return new Promise(() => {});
      this.connected = true;
      return this;
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      setTimeout(() => device.dispatchEvent(new Event('gattserverdisconnected')), 0);
    },
    async getPrimaryService(uuid) {
      if (opts.noService || uuid !== SERVICE) throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, 'NotFoundError');
      return { async getCharacteristic() { return ch; } };
    },
  };
  window.__bleNotify = (bytes) => {
    ch.value = new DataView(new Uint8Array(bytes).buffer);
    ch.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  window.__bleDrop = () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); };
  const bt = {
    async requestDevice(o) {
      log.requests.push(JSON.parse(JSON.stringify(o)));
      if (opts.cancel) throw new DOMException('User cancelled the requestDevice() chooser.', opts.cancel);
      return device;
    },
  };
  Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => bt, configurable: true });
}

function fakeMidi() {
  const sent = [];
  window.__usbSent = sent;
  const input = { id: 'in1', name: 'SMK-37 MIDI', state: 'connected', type: 'input', onmidimessage: null };
  const output = { id: 'out1', name: 'SMK-37 MIDI', state: 'connected', type: 'output', send: (d) => sent.push([...d]) };
  window.__usbIn = (bytes) => input.onmidimessage?.({ data: new Uint8Array(bytes) });
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), onstatechange: null });
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
let failures = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(`ok   ${name}`); console.log(`ok   ${name}`); }
  catch (err) { failures++; results.push(`FAIL ${name}`); console.error(`FAIL ${name}\n  ${err.stack || err}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

async function open(url, bt = {}, { midi = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => { if (!/fonts\./.test(r.url())) errors.push(`request failed: ${r.url()}`); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.addInitScript(fakeBluetooth, bt);
  if (midi) await page.addInitScript(fakeMidi);
  await page.goto(BASE + url);
  await page.waitForFunction(() => customElements.get('fm1-panel'));
  return { page, ctx, errors };
}
const panel = (page) => page.locator('fm1-panel.inline');
const msgText = (page) => panel(page).locator('.msg[role=status]').textContent();
const msgIsError = (page) => panel(page).locator('.msg[role=status]').evaluate((n) => n.hasAttribute('data-error'));
const bleLight = (page) => panel(page).locator('.fm1-row', { hasText: 'Bluetooth MIDI' }).locator('.row-head .light').textContent();
const bleBtn = (page) => panel(page).getByRole('button', { name: /over Bluetooth|Disconnect Bluetooth|Reconnect Bluetooth|Connecting/ });

await check('button and SMK-37 hint shown when navigator.bluetooth exists', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37');
  assert(await bleBtn(page).isVisible(), 'button not visible');
  assert(await panel(page).locator('.ble-hint').isVisible(), 'SMK hint not visible');
  assert(!(await panel(page).locator('.ble-note').isVisible()), 'unsupported note visible');
  // Keyboard accessible: it's a real <button> and reachable by Tab.
  eq(await bleBtn(page).evaluate((b) => b.tagName), 'BUTTON', 'tag');
  await bleBtn(page).focus();
  eq(await page.evaluate(() => document.activeElement.textContent), 'Connect over Bluetooth', 'focus');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('hint hidden for the FM-1', async () => {
  const { page, ctx } = await open('/lessons/00-start.html?device=fm1');
  assert(await bleBtn(page).isVisible(), 'button not visible');
  assert(!(await panel(page).locator('.ble-hint').isVisible()), 'SMK hint visible on FM-1');
  await ctx.close();
});

await check('unsupported-browser note when navigator.bluetooth is absent', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { absent: true });
  assert(!(await bleBtn(page).isVisible()), 'button visible');
  const note = panel(page).locator('.ble-note');
  assert(await note.isVisible(), 'note hidden');
  assert(/can’t connect over Bluetooth; try Chrome on Android/.test(await note.textContent()), 'note text');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('connect, notes and CCs in, panel state, disconnect (keyboard-activated)', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37');
  await bleBtn(page).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  const req = await page.evaluate(() => window.__ble.requests[0]);
  eq(req, { filters: [{ services: ['03b80e5a-ede8-4b33-a751-6ce34ec4c700'] }], optionalServices: ['03b80e5a-ede8-4b33-a751-6ce34ec4c700'] }, 'requestDevice options');
  eq(await bleLight(page), 'Bluetooth: SMK-37 BLE', 'light');
  assert(/Connected: Bluetooth: SMK-37 BLE/.test(await panel(page).textContent()), 'MIDI row status');
  eq(await bleBtn(page).textContent(), 'Disconnect Bluetooth', 'button text');
  assert(/Connect SMK-37|SMK-37/.test(await page.locator('fm1-panel[compact] .fm1-chip button').textContent()), 'chip');
  assert(await page.locator('fm1-panel[compact] .lights .light').first().evaluate((n) => n.hasAttribute('data-on')), 'chip MIDI light on');

  // Spy on the link's events (same module instance as the page's).
  await page.evaluate(async () => {
    const { fm1 } = await import('/assets/js/hw/fm1.js');
    window.__ev = [];
    for (const t of ['noteon', 'noteoff', 'cc']) fm1.addEventListener(t, (e) => window.__ev.push([t, e.detail]));
  });
  // Let the page's synth hear the keys, and start audio with a click.
  await panel(page).getByText('keys also play the page’s synth').click();
  await page.locator('synth-lab').first().click({ position: { x: 5, y: 5 } });
  // Note on (middle C), then a CC, then note off, in separate packets; then
  // two messages in one packet with running status.
  await page.evaluate(() => {
    window.__bleNotify([0x80, 0x81, 0x90, 60, 100]);
    window.__bleNotify([0x80, 0x82, 0xb0, 74, 64]);
  });
  await page.waitForFunction(() => window.__ev.length >= 2);
  assert(/Last key from the SMK-37: C4/.test(await panel(page).textContent()), 'last key text');
  const lit = await page.locator('synth-lab .keys [data-hw]').count();
  assert(lit >= 1, 'hardware key not lit on the drawn keyboard');
  await page.evaluate(() => window.__bleNotify([0x80, 0x83, 0x80, 60, 0, 0x84, 0x90, 64, 90, 64, 0]));
  await page.waitForFunction(() => window.__ev.length >= 5);
  const ev = await page.evaluate(() => window.__ev);
  eq(ev, [['noteon', { note: 60, velocity: 100 / 127 }], ['cc', { cc: 74, value: 64, channel: 1 }], ['noteoff', { note: 60 }], ['noteon', { note: 64, velocity: 90 / 127 }], ['noteoff', { note: 64 }]], 'events');
  eq(await page.locator('synth-lab .keys [data-hw]').count(), 0, 'keys released');

  // Test note button writes a note on as a BLE packet.
  await page.evaluate(() => { window.__ble.writes.length = 0; });
  await panel(page).getByRole('button', { name: /Play a test note/ }).click();
  await page.waitForFunction(() => window.__ble.writes.length >= 1);
  const w = await page.evaluate(() => window.__ble.writes[0]);
  assert((w[0] & 0xc0) === 0x80 && (w[1] & 0x80) === 0x80, `header/timestamp bytes: ${w}`);
  eq(w.slice(2), [0x90, 60, 102], 'note-on bytes');

  // Unexpected drop with a successful quiet reconnect.
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Reconnected'));
  eq(await bleLight(page), 'Bluetooth: SMK-37 BLE', 'light after reconnect');

  // Manual disconnect: All Notes Off goes out over Bluetooth first.
  await page.evaluate(() => { window.__ble.writes.length = 0; });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Disconnected the SMK-37'));
  const last = await page.evaluate(() => window.__ble.writes.flat());
  assert(last.join(',').includes([0xb0, 123, 0].join(',')), `no All Notes Off before disconnect: ${last}`);
  eq(await bleLight(page), 'Not connected', 'light after manual disconnect');
  eq(await bleBtn(page).textContent(), 'Connect over Bluetooth', 'button after disconnect');
  assert(!(await msgIsError(page)), 'manual disconnect shown as error');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('connection log records connects, drops and retries, and survives a page change', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { failReconnectsUntil: 2 });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleNotify([0x80, 0x80, 0x90, 60, 100]));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Reconnected'));
  const text = await panel(page).locator('.ble-log-text').textContent();
  for (const want of ['-- page 00-start.html --', 'Picked SMK-37 BLE', 'Connected', 'First MIDI data on this link', 'Link dropped (was connected)', 'Retry 1 of 3', 'Retry 1 failed', 'Reconnected on retry 2']) {
    assert(text.includes(want), `log is missing "${want}":\n${text}`);
  }
  // A fresh page load sees the same log (stored in the browser).
  await page.goto(BASE + '/lessons/00-start.html?device=smk37&again=1');
  await page.waitForFunction(() => customElements.get('fm1-panel'));
  assert((await panel(page).locator('.ble-log-text').textContent()).includes('Reconnected on retry 2'), 'log not kept across pages');
  // Clear empties it.
  await panel(page).locator('.ble-log summary').click();
  await panel(page).getByRole('button', { name: 'Clear log' }).click();
  eq(await panel(page).locator('.ble-log-text').textContent(), 'Nothing yet.', 'cleared log');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('lost connection that cannot reconnect is reported', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { failReconnect: true });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('disconnected from Bluetooth'));
  eq(await bleLight(page), 'Disconnected', 'light');
  assert(await msgIsError(page), 'should be an error');
  eq(await bleBtn(page).textContent(), 'Reconnect Bluetooth', 'button');
  const synthHw = await page.locator('synth-lab .instrument-foot input[type=checkbox]').first().isDisabled();
  assert(synthHw, 'mirror should be disabled with no link');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('several retries, with waits, bring a dropped link back', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { failReconnectsUntil: 3 });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Reconnected'));
  eq(await page.evaluate(() => window.__ble.connects), 4, 'connect attempts (1 first + 2 failed + 1 good)');
  eq(await bleLight(page), 'Bluetooth: SMK-37 BLE', 'light');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('after giving up, one tap reconnects with no chooser', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { failReconnect: true });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Tap Reconnect Bluetooth'));
  // Still unreachable: the tap says so and the next tap opens the chooser.
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Still can’t reach'));
  eq(await bleBtn(page).textContent(), 'Connect over Bluetooth', 'button after a failed resume');
  eq(await page.evaluate(() => window.__ble.requests.length), 1, 'chooser not opened by the failed resume');
  // Reachable again, after another loss.
  await page.evaluate(() => { window.__bleOpts.failReconnect = false; });
  await bleBtn(page).click(); // chooser again
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => { window.__bleOpts.failReconnect = true; window.__bleDrop(); });
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Tap Reconnect Bluetooth'));
  await page.evaluate(() => { window.__bleOpts.failReconnect = false; });
  const requests = await page.evaluate(() => window.__ble.requests.length);
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Reconnected'));
  eq(await page.evaluate(() => window.__ble.requests.length), requests, 'resume used no chooser');
  eq(await bleLight(page), 'Bluetooth: SMK-37 BLE', 'light');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('a connection attempt that hangs is given up on', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { hangReconnect: true, attemptTimeout: 100 });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Tap Reconnect Bluetooth'), null, { timeout: 5000 });
  eq(await bleLight(page), 'Disconnected', 'light');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('coming back to the page tries a lost link again', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { failReconnect: true });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => window.__bleDrop());
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Tap Reconnect Bluetooth'));
  await page.evaluate(() => { window.__bleOpts.failReconnect = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.includes('Reconnected'));
  eq(await bleLight(page), 'Bluetooth: SMK-37 BLE', 'light');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('slider with Mirror on writes well-formed BLE packets (patch burst + CC 74)', async () => {
  const { page, ctx, errors } = await open('/lessons/03-filters.html?device=smk37');
  await page.locator('fm1-panel[compact] .fm1-chip button').click();
  await page.locator('.fm1-popover').getByRole('button', { name: 'Connect over Bluetooth' }).click();
  await page.waitForFunction(() => document.querySelector('.fm1-popover').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.keyboard.press('Escape');
  const lab = page.locator('synth-lab').first();
  await page.evaluate(() => { window.__ble.writes.length = 0; });
  await lab.getByText(/Mirror to/).click(); // sends the whole patch first
  await page.waitForTimeout(300);
  const burst = await page.evaluate(() => window.__ble.writes.splice(0));
  assert(burst.length >= 2, `patch burst should take several packets, got ${burst.length}`);
  for (const p of burst) {
    assert(p.length <= 20, `packet too long: ${p.length}`);
    assert((p[0] & 0xc0) === 0x80, 'header');
    for (let i = 1; i < p.length; i += 4) {
      assert((p[i] & 0x80) && (p[i + 1] & 0xf0) === 0xb0 && !(p[i + 2] & 0x80) && !(p[i + 3] & 0x80), `bad message in ${p}`);
    }
  }
  // Move Cutoff to 20 kHz: CC 74 = 127 on channel 1.
  const slider = lab.locator('input[type=range]').first();
  await slider.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.__ble.writes.length >= 1);
  await page.waitForTimeout(100);
  const w = await page.evaluate(() => window.__ble.writes);
  const msgs = w.flatMap((p) => { const out = []; for (let i = 1; i < p.length; i += 4) out.push(p.slice(i + 1, i + 4)); return out; });
  assert(msgs.some((m) => m[0] === 0xb0 && m[1] === 74 && m[2] === 127), `no CC 74 = 127 in ${JSON.stringify(w)}`);
  eq(await page.evaluate(() => window.__ble.overlaps), 0, 'overlapping GATT writes');
  eq(errors, [], 'console errors');
  await ctx.close();
});

for (const [kind, label] of [['NotFoundError', 'NotFoundError'], ['NotAllowedError', 'NotAllowedError']]) {
  await check(`user cancelling the chooser (${label}) is not an error`, async () => {
    const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', { cancel: kind });
    await bleBtn(page).click();
    await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.length > 0);
    assert(!(await msgIsError(page)), 'shown as error');
    eq(await msgText(page), 'No Bluetooth device chosen.', 'message');
    eq(await bleLight(page), 'Not connected', 'light');
    eq(errors, [], 'console errors');
    await ctx.close();
  });
}

await check('device without the BLE MIDI service gets a clear error', async () => {
  const { page, ctx } = await open('/lessons/00-start.html?device=smk37', { noService: true, name: 'Headphones' });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.length > 0);
  assert(await msgIsError(page), 'not an error');
  eq(await msgText(page), '“Headphones” doesn’t offer standard Bluetooth MIDI.', 'message');
  eq(await bleLight(page), 'Not connected', 'light');
  await ctx.close();
});

await check('GATT connect failure gets a clear error', async () => {
  const { page, ctx } = await open('/lessons/00-start.html?device=smk37', { failConnect: true });
  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline .msg[role=status]').textContent.length > 0);
  assert(await msgIsError(page), 'not an error');
  assert(/^Couldn’t connect to “SMK-37 BLE” over Bluetooth/.test(await msgText(page)), await msgText(page));
  eq(await bleLight(page), 'Not connected', 'light');
  eq(await bleBtn(page).isDisabled(), false, 'button usable again');
  await ctx.close();
});

await check('USB path unchanged, and USB + Bluetooth never double-send', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', {}, { midi: true });
  await panel(page).getByRole('button', { name: 'Connect MIDI' }).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Connected: SMK-37 MIDI'));
  await page.evaluate(async () => {
    const { fm1 } = await import('/assets/js/hw/fm1.js');
    window.__ev = [];
    fm1.addEventListener('noteon', (e) => window.__ev.push(e.detail.note));
  });
  await panel(page).getByRole('button', { name: /Play a test note/ }).click();
  eq(await page.evaluate(() => window.__usbSent[0]), [0x90, 60, 102], 'USB note on');
  await page.evaluate(() => window.__usbIn([0x90, 48, 100]));
  eq(await page.evaluate(() => window.__ev), [48], 'USB input');

  await bleBtn(page).click();
  await page.waitForFunction(() => document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  assert(await panel(page).getByText('These USB ports take over again').isVisible(), 'USB note not shown');
  await page.evaluate(() => { window.__usbSent.length = 0; window.__ble.writes.length = 0; window.__ev.length = 0; });
  await panel(page).getByRole('button', { name: /Play a test note/ }).click();
  await page.waitForFunction(() => window.__ble.writes.length >= 1);
  eq(await page.evaluate(() => window.__usbSent), [], 'nothing to USB while Bluetooth is the link');
  await page.evaluate(() => { window.__usbIn([0x90, 50, 100]); window.__bleNotify([0x80, 0x80, 0x90, 52, 100]); });
  eq(await page.evaluate(() => window.__ev), [52], 'only Bluetooth input heard');

  await bleBtn(page).click();
  await page.waitForFunction(() => !document.querySelector('fm1-panel.inline').textContent.includes('Bluetooth: SMK-37 BLE'));
  await page.evaluate(() => { window.__usbSent.length = 0; });
  await page.waitForTimeout(700); // let the earlier test note's note-off land
  await page.evaluate(() => { window.__usbSent.length = 0; window.__ble.writes.length = 0; });
  await panel(page).getByRole('button', { name: /Play a test note/ }).click();
  eq(await page.evaluate(() => window.__usbSent[0]), [0x90, 60, 102], 'USB takes over again');
  eq(await page.evaluate(() => window.__ble.writes.length), 0, 'nothing over Bluetooth after disconnect');
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('CC values survive the trip to the instrument and back', async () => {
  const { page, ctx } = await open('/lessons/00-start.html?device=smk37');
  const bad = await page.evaluate(async () => {
    const { VA_CC, ccValue, valueFromCc, paramFromCc } = await import('/assets/js/hw/fm1.js');
    const out = [];
    for (const key of Object.keys(VA_CC)) {
      if (key === 'filterShape') continue;
      for (let raw = 0; raw < 128; raw += 7) {
        const v = valueFromCc(key, raw);
        const back = ccValue(key, v);
        // Lists and Key Tracking come back as their band's middle; numbers within one step.
        const ok = typeof v === 'string' || key === 'keyTrack' ? valueFromCc(key, back) === v : Math.abs(back - raw) <= 1;
        if (!ok) out.push(`${key} ${raw} -> ${v} -> ${back}`);
      }
      const p = paramFromCc(VA_CC[key], 64, 1, 2);
      if (p?.key !== key) out.push(`paramFromCc(${VA_CC[key]}) = ${p?.key}`);
    }
    const fx = paramFromCc(7, 55, 2, 2);
    if (fx?.key !== 'fx.reverb.mix' || fx.value !== 55) out.push(`FX CC 7 = ${JSON.stringify(fx)}`);
    const on = paramFromCc(16, 127, 2, 2);
    if (on?.key !== 'fx.chorus.on' || on.value !== true) out.push(`FX CC 16 = ${JSON.stringify(on)}`);
    const fader = paramFromCc(91, 127, 1, 2);
    if (fader?.key !== 'fx.reverb.mix' || fader.value !== 100) out.push(`CC 91 = ${JSON.stringify(fader)}`);
    if (paramFromCc(10, 64, 1, 2) !== null) out.push('CC 10 (pan) should move nothing');
    return out;
  });
  eq(bad, [], 'round trips');
  await ctx.close();
});

await check('the instrument’s knobs, wheels and pedal move the panel it plays', async () => {
  const { page, ctx, errors } = await open('/lessons/03-filters.html?device=smk37', {}, { midi: true });
  await page.evaluate(async () => { const { fm1 } = await import('/assets/js/hw/fm1.js'); await fm1.connectMidi(); fm1.setKeysPlayPage(true); });
  const lab = page.locator('synth-lab').first();
  await lab.locator('.keys').click({ position: { x: 20, y: 70 } }); // make it the active panel
  await page.evaluate(() => { window.__usbSent.length = 0; window.__usbIn([0xb0, 74, 64]); });
  await page.waitForFunction(() => document.querySelector('synth-lab .ctl[data-key="cutoff"][data-hw-touch]'));
  const cutoff = await lab.evaluate((el) => el.params.cutoff);
  assert(Math.abs(cutoff - 20 * Math.pow(1000, 64 / 127)) < 1, `cutoff ${cutoff}`);
  assert(/From the SMK-37: Cutoff/.test(await lab.locator('.where').first().textContent()), 'where line');
  eq(await page.evaluate(() => window.__usbSent.filter((m) => (m[0] & 0xf0) === 0xb0 && m[1] === 74)), [], 'not echoed');
  // With Mirror on, a knob the instrument turned still isn't sent back to it.
  await lab.locator('.instrument-foot input[type=checkbox]').check();
  await page.evaluate(() => { window.__usbSent.length = 0; window.__usbIn([0xb0, 71, 100]); });
  await page.waitForTimeout(50);
  eq(await page.evaluate(() => window.__usbSent.filter((m) => (m[0] & 0xf0) === 0xb0 && m[1] === 71)), [], 'not mirrored back');
  eq(await lab.evaluate((el) => el.params.resonance), 79, 'resonance');
  // FX channel, wheels.
  await page.evaluate(() => { window.__usbIn([0xb1, 7, 55]); window.__usbIn([0xe0, 0x7f, 0x7f]); window.__usbIn([0xb0, 1, 127]); });
  eq(await lab.evaluate((el) => [el.params.fx.reverb.mix, Math.round(el.bendAmount * 100), el.modAmount]), [55, 100, 1], 'reverb mix, bend, mod');
  assert(await lab.locator('.wheels').isVisible(), 'wheels shown');
  // Sustain: a key let go while the pedal is down keeps sounding until it comes up.
  await page.evaluate(() => { window.__usbIn([0xb0, 64, 127]); window.__usbIn([0x90, 60, 100]); window.__usbIn([0x80, 60, 0]); });
  eq(await lab.evaluate((el) => [...el.pedalNotes.keys()]), [60], 'held by the pedal');
  await page.evaluate(() => window.__usbIn([0xb0, 64, 0]));
  eq(await lab.evaluate((el) => [el.pedalNotes.size, el.held.size]), [0, 0], 'released with the pedal');
  // Follow off: knobs leave the page alone.
  await page.evaluate(async () => { (await import('/assets/js/hw/fm1.js')).fm1.setFollowHw(false); window.__usbIn([0xb0, 74, 127]); });
  assert(Math.abs((await lab.evaluate((el) => el.params.cutoff)) - cutoff) < 1, 'cutoff moved with follow off');
  await page.evaluate(async () => (await import('/assets/js/hw/fm1.js')).fm1.setFollowHw(true));
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('MIDI monitor decodes what arrives', async () => {
  const { page, ctx, errors } = await open('/lessons/00-start.html?device=smk37', {}, { midi: true });
  await panel(page).getByRole('button', { name: 'Connect MIDI' }).click();
  await panel(page).locator('details', { hasText: 'MIDI from the' }).locator('summary').click();
  await page.evaluate(() => { window.__usbIn([0x90, 60, 100]); window.__usbIn([0xb0, 74, 64]); window.__usbIn([0xe0, 0, 0x50]); window.__usbIn([0xf8]); });
  await page.waitForTimeout(100);
  const text = await panel(page).locator('.midi-mon').textContent();
  for (const want of ['Note on  C4  velocity 100', 'CC 74 = 64  cutoff', 'Pitch bend +2048', '(1 clock messages)']) assert(text.includes(want), `missing “${want}” in:\n${text}`);
  eq(errors, [], 'console errors');
  await ctx.close();
});

await check('signal path points at controls; focus opens and Escape closes it', async () => {
  const { page, ctx, errors } = await open('/lessons/03-filters.html');
  // "Key tracking" shows only a spectrum, so Focus has views to add.
  const lab = page.locator('synth-lab', { has: page.locator('h3', { hasText: 'Key tracking' }) });
  await lab.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200); // the strip draws (and learns where its stages are) once on screen
  const box = await lab.locator('.viz.flow canvas').boundingBox();
  // The filter is the second of four stages.
  await page.mouse.click(box.x + box.width * 0.375, box.y + box.height * 0.65);
  assert(await lab.locator('.ctl[data-key="cutoff"][data-flash]').count(), 'cutoff not pointed at');
  assert(/^Filter: /.test(await lab.locator('.where').first().textContent()), 'where line');
  await lab.locator('.focus-btn').click();
  assert(await lab.locator('.instrument[data-focus]').count(), 'not in focus');
  assert(await lab.locator('.viz[data-view="sono"]').isVisible(), 'spectrogram hidden in focus');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  eq(await lab.locator('.instrument[data-focus]').count(), 0, 'still in focus');
  assert(!(await lab.locator('.viz[data-view="sono"]').isVisible()), 'spectrogram shown outside focus');
  eq(errors, [], 'console errors');
  await ctx.close();
});

// Every page, both devices: no console errors, with Bluetooth present.
const pages = ['/index.html', '/history.html', ...fs.readdirSync(path.join(SITE, 'lessons')).filter((f) => f.endsWith('.html')).map((f) => `/lessons/${f}`)];
for (const dev of ['fm1', 'smk37']) {
  await check(`all ${pages.length} pages load cleanly (${dev})`, async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await ctx.addInitScript(fakeBluetooth, {});
    const bad = [];
    for (const p of pages) {
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.|Failed to load resource/.test(m.text())) bad.push(`${p}: ${m.text()}`); });
      page.on('pageerror', (e) => bad.push(`${p}: ${e}`));
      await page.goto(`${BASE}${p}?device=${dev}`, { waitUntil: 'load' });
      await page.waitForTimeout(150);
      await page.close();
    }
    eq(bad, [], 'errors');
  });
}

await browser.close();
server.close();
console.log(`\n${results.length - failures}/${results.length} browser checks passed`);
process.exit(failures ? 1 : 0);
