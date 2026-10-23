// Unit tests for the Bluetooth MIDI packet parser and builder.
//
//     node scripts/test_ble_midi.mjs
//
// No dependencies; exits non-zero on the first failure.

import assert from 'node:assert/strict';
import {
  parseBlePacket, createParserState, buildBlePackets, bleTimestamp, bleErrorKind, BLE_PACKET_SIZE,
} from '../site/assets/js/hw/ble-midi.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exit(1); }
}

const msgs = (packet, state) => parseBlePacket(Uint8Array.from(packet), state).map((m) => [...m.data]);
const times = (packet, state) => parseBlePacket(Uint8Array.from(packet), state).map((m) => m.time);

test('note on and note off', () => {
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60, 100]), [[0x90, 60, 100]]);
  assert.deepEqual(msgs([0x80, 0x81, 0x80, 60, 0]), [[0x80, 60, 0]]);
  // Note on with velocity 0 passes through as is; fm1.js treats it as off.
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60, 0]), [[0x90, 60, 0]]);
});

test('CC with running status, with and without a fresh timestamp', () => {
  // ts B0 74 10 | 74 20 (no ts) | ts 74 30 (new ts, running status)
  assert.deepEqual(msgs([0x80, 0x81, 0xb0, 74, 10, 74, 20, 0x82, 74, 30]),
    [[0xb0, 74, 10], [0xb0, 74, 20], [0xb0, 74, 30]]);
});

test('running status carries over to the next packet', () => {
  const st = createParserState();
  msgs([0x80, 0x81, 0xb0, 7, 1], st);
  assert.deepEqual(msgs([0x80, 0x81, 7, 2], st), [[0xb0, 7, 2]]);
});

test('two messages in one packet', () => {
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60, 100, 0x82, 0xb1, 71, 64]),
    [[0x90, 60, 100], [0xb1, 71, 64]]);
});

test('one-data-byte messages (program change, channel pressure)', () => {
  assert.deepEqual(msgs([0x80, 0x81, 0xc0, 5, 0x81, 0xd0, 40, 41]), [[0xc0, 5], [0xd0, 40], [0xd0, 41]]);
});

test('SysEx split across two packets with a real-time byte in the middle', () => {
  const st = createParserState();
  // packet 1: ts F0 7E 7F | ts F8 (clock inside SysEx) | 06 01 (continues)
  const a = msgs([0x80, 0x81, 0xf0, 0x7e, 0x7f, 0x82, 0xf8, 0x06], st);
  assert.deepEqual(a, [[0xf8]]);
  // packet 2: header, continuation data straight away, then ts F7, then a note
  const b = msgs([0x80, 0x01, 0x02, 0x83, 0xf7, 0x84, 0x90, 64, 90], st);
  assert.deepEqual(b, [[0xf0, 0x7e, 0x7f, 0x06, 0x01, 0x02, 0xf7], [0x90, 64, 90]]);
  assert.equal(st.sysex, null);
});

test('real-time byte between running-status messages keeps running status', () => {
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60, 100, 0x81, 0xf8, 0x81, 62, 100]),
    [[0x90, 60, 100], [0xf8], [0x90, 62, 100]]);
});

test('timestamps: 13-bit value and wraparound of the low byte', () => {
  // header high = 5, low = 0x7f then 0x02: low went backwards so high -> 6
  const t = times([0x85, 0xff, 0x90, 60, 1, 0x82, 0x90, 61, 1]);
  assert.deepEqual(t, [(5 << 7) | 0x7f, (6 << 7) | 0x02]);
  // high wraps 63 -> 0
  const t2 = times([0xbf, 0xff, 0xf8, 0x80, 0xf8]);
  assert.deepEqual(t2, [0x1fff, 0]);
});

test('malformed and short packets never throw', () => {
  const bad = [
    [], [0x80], [0x00, 0x90, 1, 2], [0x80, 0x81], [0x80, 0x81, 0x90], [0x80, 0x81, 0x90, 60],
    [0x80, 0x81, 0x90, 60, 0x90], [0x80, 0x45, 0x12], [0x80, 0x81, 0xf7], [0x80, 0x81, 0xf4],
    [0xff, 0xff, 0xff, 0xff], [0x80, 0x81, 0xb0, 74], new Array(200).fill(0x80),
  ];
  for (const p of bad) assert.doesNotThrow(() => parseBlePacket(Uint8Array.from(p), createParserState()));
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60]), []);
  assert.deepEqual(msgs([0x00, 0x90, 1, 2]), []);
  assert.doesNotThrow(() => parseBlePacket(null));
  assert.doesNotThrow(() => parseBlePacket(undefined));
  assert.doesNotThrow(() => parseBlePacket(new DataView(new ArrayBuffer(3))));
  // A truncated message doesn't swallow what came before it.
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 60, 100, 0x82, 0xb0, 7]), [[0x90, 60, 100]]);
});

test('an over-long SysEx is dropped, not buffered forever', () => {
  const st = createParserState();
  msgs([0x80, 0x81, 0xf0, 1], st);
  for (let k = 0; k < 400; k++) msgs([0x80, ...new Array(18).fill(0x11)], st);
  assert.equal(st.sysex, null);
  assert.deepEqual(msgs([0x80, 0x81, 0x90, 1, 2], st), [[0x90, 1, 2]]);
});

test('builder: one 3-byte message', () => {
  const p = buildBlePackets([[0xb0, 74, 64]], 0x1234);
  assert.equal(p.length, 1);
  assert.deepEqual([...p[0]], [0x80 | (0x1234 >> 7 & 0x3f), 0x80 | (0x1234 & 0x7f), 0xb0, 74, 64]);
  assert.deepEqual(msgs(p[0]), [[0xb0, 74, 64]]);
});

test('builder: a burst of 10 messages chunks to <= 20 bytes and round-trips', () => {
  const burst = Array.from({ length: 10 }, (_, k) => [0xb0, 20 + k, k * 10]);
  const packets = buildBlePackets(burst, 100);
  // header + 4 bytes per message: 4 messages (17 bytes) per packet -> 4, 4, 2
  assert.deepEqual(packets.map((p) => p.length), [17, 17, 9]);
  for (const p of packets) assert.ok(p.length <= BLE_PACKET_SIZE);
  const back = packets.flatMap((p) => msgs(p));
  assert.deepEqual(back, burst);
});

test('builder: mixed lengths, real-time, and invalid input skipped', () => {
  const packets = buildBlePackets([[0xc0, 3], [0xf8], [0xf0, 1, 0xf7], [0x40, 1, 2], [], [0x90, 60], [0x90, 60, 100]], 0);
  assert.deepEqual(packets.flatMap((p) => msgs(p)), [[0xc0, 3], [0xf8], [0x90, 60, 100]]);
  assert.deepEqual(buildBlePackets([]), []);
});

test('bleTimestamp is 13 bits', () => {
  assert.equal(bleTimestamp(8192 + 5.7), 5);
  assert.ok(bleTimestamp() >= 0 && bleTimestamp() < 8192);
});

test('error classification', () => {
  const e = (name, blePhase) => Object.assign(new Error('x'), { name, blePhase });
  assert.equal(bleErrorKind(e('NotFoundError', 'pick')), 'cancelled');
  assert.equal(bleErrorKind(e('NotAllowedError', 'pick')), 'cancelled');
  assert.equal(bleErrorKind(e('SecurityError', 'pick')), 'insecure');
  assert.equal(bleErrorKind(e('NotFoundError', 'service')), 'no-service');
  assert.equal(bleErrorKind(e('NetworkError', 'gatt')), 'gatt');
});

console.log(`\n${passed} tests passed`);
