// Sample codes for each format the scanner understands. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateUid, normalizeEui, parseScan } from './codes.js';

test('normalizeEui accepts common EUI spellings', () => {
  assert.equal(normalizeEui('a8404199de8cdce7'), 'A8404199DE8CDCE7');
  assert.equal(normalizeEui('A8:40:41:99:DE:8C:DC:E7'), 'A8404199DE8CDCE7');
  assert.equal(normalizeEui('a8-40-41-99-de-8c-dc-e7'), 'A8404199DE8CDCE7');
  assert.equal(normalizeEui(' A840 4199 DE8C DCE7 '), 'A8404199DE8CDCE7');
  assert.equal(normalizeEui('A8404199DE8CDC'), null); // too short
  assert.equal(normalizeEui('G8404199DE8CDCE7'), null); // not hex
  assert.equal(normalizeEui(null), null);
});

test('generateUid makes readable JSP- ids', () => {
  for (let i = 0; i < 200; i++) assert.match(generateUid(), /^JSP-[0-9A-HJKMNP-TV-Z]{8}$/);
});

test('Jasper label URLs and bare ids', () => {
  assert.deepEqual(pick(parseScan('https://inventory.jasper.tools/u/JSP-W39FJ2EE')), { format: 'jasper-label', uid: 'JSP-W39FJ2EE' });
  assert.deepEqual(pick(parseScan('jsp-w39fj2ee')), { format: 'jasper-label', uid: 'JSP-W39FJ2EE' });
  // EUI-keyed devices' labels carry the EUI as the uid
  assert.deepEqual(pick(parseScan('https://inventory.jasper.tools/u/A8404199DE8CDCE7')), { format: 'jasper-label', uid: 'A8404199DE8CDCE7' });
});

test('LoRa Alliance TR005 codes', () => {
  const p = parseScan('LW:D0:70B3D57ED0000001:A8404199DE8CDCE7:01020304:OABCD:SXYZ');
  assert.equal(p.format, 'lora-tr005');
  assert.equal(p.join_eui, '70B3D57ED0000001');
  assert.equal(p.eui, 'A8404199DE8CDCE7');
  assert.equal(parseScan('lw:d0:70b3d57ed0000001:a8404199de8cdce7:0').eui, 'A8404199DE8CDCE7');
});

test('vendor JSON payloads', () => {
  const p = parseScan('{"DevEUI":"a8404199de8cdce7","AppEUI":"70B3D57ED0000001","SN":"6136A12345"}');
  assert.equal(p.format, 'json');
  assert.equal(p.eui, 'A8404199DE8CDCE7');
  assert.equal(p.join_eui, '70B3D57ED0000001');
  assert.equal(p.serial, '6136A12345');
  assert.equal(parseScan('{"dev_eui":"A8-40-41-99-DE-8C-DC-E7"}').eui, 'A8404199DE8CDCE7');
  assert.equal(parseScan('{"gateway_eui":"24E124FFFEF00001"}').eui, '24E124FFFEF00001');
  // JSON without an EUI or serial falls through to plain text
  assert.equal(parseScan('{"foo":1}').format, 'text');
});

test('labelled text', () => {
  const p = parseScan('Model: EM300-TH\nDevEUI: 24:E1:24:13:6B:00:12:34\nAppEUI: 24E124C0002A0001\nS/N: 6136B05012');
  assert.equal(p.format, 'text-eui');
  assert.equal(p.eui, '24E124136B001234');
  assert.equal(p.join_eui, '24E124C0002A0001');
  assert.equal(p.serial, '6136B05012');
  assert.equal(parseScan('Gateway EUI 24e124fffef00001').eui, '24E124FFFEF00001');
});

test('bare EUI, serials and empty input', () => {
  assert.deepEqual(pick(parseScan('a8404199de8cdce7')), { format: 'eui', eui: 'A8404199DE8CDCE7' });
  const s = parseScan('  6136B05012 ');
  assert.equal(s.format, 'text');
  assert.equal(s.serial, '6136B05012');
  assert.equal(parseScan('').serial, null);
  assert.equal(parseScan(undefined).raw, '');
});

// just the fields a test cares about
function pick(p) {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => v != null && k !== 'raw'));
}
