// pipeline/test/assessor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAssessorRows, parseOneLine } from '../src/sources/assessor.js';

const csv = fs.readFileSync(new URL('./fixtures/assessor_sample.csv', import.meta.url), 'utf8');

test('parseAssessorRows returns normalized property rows', () => {
  const rows = parseAssessorRows(csv);
  assert.ok(rows.length > 0, 'should parse at least 1 row');
  const r = rows[0];
  // APN normalized: no dashes, no trailing suffix letter (Maricopa uses 9-digit APNs)
  assert.match(r.apn, /^[0-9A-Z]+$/, 'apn must be normalized alphanumeric');
  assert.ok('ownerName' in r && 'situsAddress' in r && 'mailingAddress' in r, 'required fields present');
  assert.equal(typeof r.absentee, 'boolean', 'absentee must be boolean');
  assert.equal(r.ownerNameNorm, r.ownerNameNorm.toUpperCase(), 'ownerNameNorm must be uppercase');
});

test('parseAssessorRows returns ~50 rows from fixture', () => {
  const rows = parseAssessorRows(csv);
  assert.ok(rows.length >= 40, `expected >=40 rows, got ${rows.length}`);
});

test('parseAssessorRows maps assessedValue as number', () => {
  const rows = parseAssessorRows(csv);
  const withValue = rows.filter((r) => r.assessedValue !== null);
  assert.ok(withValue.length > 0, 'some rows should have assessedValue');
  for (const r of withValue) {
    assert.equal(typeof r.assessedValue, 'number', 'assessedValue must be number');
  }
});

test('parseAssessorRows includes absentee rows', () => {
  const rows = parseAssessorRows(csv);
  // Fixture (first 51 rows of BK100) contains absentee owners: mailing != situs
  const absentees = rows.filter((r) => r.absentee);
  assert.ok(absentees.length > 0, 'fixture should include absentee rows');
});

test('parseAssessorRows sets situsCity and situsZip', () => {
  const rows = parseAssessorRows(csv);
  const withCity = rows.filter((r) => r.situsCity && r.situsCity.length > 0);
  assert.ok(withCity.length > 0, 'some rows should have situsCity');
});

test('parseAssessorRows maps legalClass from Land_Class field', () => {
  const rows = parseAssessorRows(csv);
  const withClass = rows.filter((r) => r.legalClass !== null);
  assert.ok(withClass.length > 0, 'some rows should have legalClass');
});

test('parseOneLine: mailing street same as situs except punctuation/spacing → absentee false', () => {
  // 39-field row; mailAddr1 (col 2) and situsAddr (col 8) differ only in punctuation/spacing
  // normalizeAddress strips punctuation and collapses spaces, so these should normalize equal
  const cells = [
    '10101001C',          // col 0: PARCEL
    'OWNER NAME',         // col 1: OWNER_NAME
    '123 MAIN ST.',       // col 2: MAIL_ADDR1  (has trailing period)
    '',                   // col 3: MAIL_ADDR2
    'PHOENIX',            // col 4: MAIL_CITY
    'AZ',                 // col 5: MAIL_STATE
    '85001',              // col 6: MAIL_ZIP
    'USA',                // col 7: MAIL_COUNTRY
    '123 MAIN ST',        // col 8: SITUS_ADDR  (no trailing period)
    '',                   // col 9: SITUS_SUITE
    'PHOENIX',            // col 10: SITUS_CITY
    '85001',              // col 11: SITUS_ZIP
    'RESIDENTIAL',        // col 12: PROP_TYPE
    ...Array(26).fill(''),// cols 13-38: remaining fields (need exactly 39 total)
  ];
  // Verify cell count is correct
  assert.equal(cells.length, 39);
  const row = parseOneLine(cells);
  assert.ok(row !== null, 'should parse successfully');
  assert.equal(row.absentee, false, 'same street (modulo punctuation) should not be absentee');
});

test('parseOneLine: Situs_Suite duplicating the trailing unit already in Situs_Address is not re-appended', () => {
  // Real assessor export row shape: SITUS_ADDR already ends with the unit
  // number, and SITUS_SUITE repeats it — previously produced "... AVE 1020 1020".
  const cells = [
    '00000001A', 'DOE JANE', '100 N TEST LN', '', 'TEST CITY', 'AZ', '85143', 'USA',
    '1730 W EMELITA AVE 1020', '1020', 'MESA', '85202', 'RESIDENTIAL',
    ...Array(26).fill(''),
  ];
  assert.equal(cells.length, 39);
  const row = parseOneLine(cells);
  assert.equal(row.situsAddress, '1730 W EMELITA AVE 1020');
});

test('parseOneLine: Situs_Suite appended when Situs_Address does not already include it', () => {
  const cells = [
    '00000001A', 'OWNER NAME', '123 MAIN ST', '', 'MESA', 'AZ', '85202', 'USA',
    '1730 W EMELITA AVE', '1020', 'MESA', '85202', 'RESIDENTIAL',
    ...Array(26).fill(''),
  ];
  assert.equal(cells.length, 39);
  const row = parseOneLine(cells);
  assert.equal(row.situsAddress, '1730 W EMELITA AVE 1020');
});

test('parseOneLine: absentee uses addressMatchKey (directional/suffix/abbreviation differences are not absentee)', () => {
  const cells = [
    '10101001C', 'OWNER NAME',
    '1919 E FLORIAN', '', 'MESA', 'AZ', '85204', 'USA',  // mailing: no suffix
    '1919 E FLORIAN AVE', '', 'MESA', '85204', 'RESIDENTIAL',
    ...Array(26).fill(''),
  ];
  assert.equal(cells.length, 39);
  const row = parseOneLine(cells);
  assert.equal(row.absentee, false);
});

test('parseOneLine: a genuinely different mailing address is still absentee', () => {
  const cells = [
    '10101001C', 'OWNER NAME',
    '456 OAK AVE', '', 'TUCSON', 'AZ', '85701', 'USA',
    '1919 E FLORIAN AVE', '', 'MESA', '85204', 'RESIDENTIAL',
    ...Array(26).fill(''),
  ];
  assert.equal(cells.length, 39);
  const row = parseOneLine(cells);
  assert.equal(row.absentee, true);
});

test('parseDeedDate handles MMDDYYYY and rejects junk', async () => {
  const { parseDeedDate } = await import('../src/sources/assessor.js');
  assert.equal(parseDeedDate('03092005'), '2005-03-09');
  assert.equal(parseDeedDate('12312012'), '2012-12-31');
  assert.equal(parseDeedDate(''), null);
  assert.equal(parseDeedDate('13012005'), null);
});
