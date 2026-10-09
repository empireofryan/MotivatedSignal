import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMatches } from '../src/resolve.js';
import { streetOnly, sortedNameKey } from '../src/normalize.js';
import { query, pool } from '../src/db.js';

test('classifyMatches: unique → assign', () => {
  const r = classifyMatches(['12345678'], 'probable');
  assert.equal(r.apn, '12345678');
  assert.equal(r.confidence, 'probable');
});

test('classifyMatches: multiple → ambiguous, no apn', () => {
  const r = classifyMatches(['A', 'B', 'C'], 'probable');
  assert.equal(r.apn, null);
  assert.equal(r.confidence, 'ambiguous');
});

test('classifyMatches: none → none', () => {
  const r = classifyMatches([], 'probable');
  assert.equal(r.apn, null);
  assert.equal(r.confidence, 'none');
});

// streetOnly tests
test('streetOnly: strips trailing single-word city', () => {
  assert.equal(streetOnly('5932 W Pasadena Ave Glendale'), '5932 W PASADENA AVE');
});
test('streetOnly: strips trailing two-word city', () => {
  assert.equal(streetOnly('123 Main St Cave Creek'), '123 MAIN ST');
});
test('streetOnly: does NOT strip city mid-street', () => {
  // "GLENDALE" is not the last token — "AVE" is
  assert.equal(streetOnly('9405 W Glendale Ave'), '9405 W GLENDALE AVE');
});
test('streetOnly: no city → normalizeAddress only', () => {
  assert.equal(streetOnly('123 Oak St'), '123 OAK ST');
});

// sortedNameKey tests
test('sortedNameKey: order-independent match', () => {
  assert.equal(sortedNameKey('Robert L Stark'), sortedNameKey('STARK ROBERT L'));
});
test('sortedNameKey: normalized output', () => {
  assert.equal(sortedNameKey('STARK ROBERT L'), 'L ROBERT STARK');
});

after(async () => {
  await query("DELETE FROM signals WHERE source LIKE 'test\\_%'");
  await pool.end();
});
