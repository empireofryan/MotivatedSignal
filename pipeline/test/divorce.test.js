import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDivorceCase } from '../src/sources/court_divorce.js';

const html = fs.readFileSync(new URL('./fixtures/divorce_case.html', import.meta.url), 'utf8');
const nonDissolutionHtml = fs.readFileSync(
  new URL('./fixtures/divorce_nondissolution.html', import.meta.url),
  'utf8'
);

const CASE_NUMBER = 'FC2026-001100';

test('parseDivorceCase returns a record for a dissolution case', () => {
  const rec = parseDivorceCase(html, CASE_NUMBER);
  assert.ok(rec, 'should return a record');
  assert.equal(rec.externalId, CASE_NUMBER);
  assert.equal(rec.ownerName, 'Jane Doe');
  assert.equal(rec.raw.petitioner, 'Jane Doe');
  assert.equal(rec.raw.respondent, 'John Michael Doe');
  assert.equal(rec.eventDate, '2026-03-16');
  assert.equal(rec.apn, null);
  assert.ok(rec.sourceUrl.includes(CASE_NUMBER));
});

test('parseDivorceCase returns null for a non-dissolution family case', () => {
  assert.equal(parseDivorceCase(nonDissolutionHtml, 'FC2026-000123'), null);
});
