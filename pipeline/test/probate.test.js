import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProbateCase } from '../src/sources/court_probate.js';

const html = fs.readFileSync(new URL('./fixtures/probate_case.html', import.meta.url), 'utf8');
const nondecedentHtml = fs.readFileSync(new URL('./fixtures/probate_nondecedent.html', import.meta.url), 'utf8');

const CASE_NUMBER = 'PB2025-008844';

test('parseProbateCase returns a record for a decedent estate', () => {
  const rec = parseProbateCase(html, CASE_NUMBER);
  assert.ok(rec, 'should return a record');
  assert.equal(rec.externalId, CASE_NUMBER);
  assert.equal(rec.ownerName, 'Jane Doe');
  assert.equal(rec.eventDate, '2025-11-06');
  assert.equal(rec.apn, null);
  assert.ok(rec.sourceUrl.includes(CASE_NUMBER));
});

test('parseProbateCase returns null when no decedent party', () => {
  const result = parseProbateCase(nondecedentHtml, 'PB2025-000999');
  assert.equal(result, null);
});
