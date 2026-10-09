import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeApn,
  normalizeOwnerName,
  normalizeAddress,
  addressMatchKey,
  zip5,
  sameStreetAddress,
} from '../src/normalize.js';

test('normalizeApn strips dashes/spaces and uppercases', () => {
  assert.equal(normalizeApn('123-45-678 A'), '12345678A');
  assert.equal(normalizeApn('  301-22-115  '), '30122115');
});

test('normalizeOwnerName uppercases, collapses spaces, strips punctuation/suffixes', () => {
  assert.equal(normalizeOwnerName('Smith, John A.'), 'SMITH JOHN A');
  assert.equal(normalizeOwnerName('ACME Holdings, LLC'), 'ACME HOLDINGS');
  assert.equal(normalizeOwnerName('Doe Family Trust'), 'DOE FAMILY');
});

test('normalizeAddress uppercases, expands nothing but collapses whitespace/punct', () => {
  assert.equal(normalizeAddress('123 N. Main St.'), '123 N MAIN ST');
});

test('addressMatchKey drops directionals and street-type suffixes', () => {
  assert.equal(addressMatchKey('1919 E Florian'), '1919 FLORIAN');
  assert.equal(addressMatchKey('1919 E Florian Ave'), '1919 FLORIAN');
  assert.equal(addressMatchKey('15321 White Horse Dr'), '15321 WHITE HORSE');
  assert.equal(addressMatchKey('15321 W White Horse Dr'), '15321 WHITE HORSE');
  assert.equal(addressMatchKey('2031 E Taxidea Wy'), '2031 TAXIDEA');
  assert.equal(addressMatchKey('2031 E Taxidea Way'), '2031 TAXIDEA');
});

test('addressMatchKey expands the VW→VIEW street-name abbreviation before suffix-stripping', () => {
  assert.equal(addressMatchKey('8601 E Valley Vw'), addressMatchKey('8601 E Valley View Rd'));
  assert.equal(addressMatchKey('8601 E Valley Vw'), '8601 VALLEY VIEW');
});

test('addressMatchKey drops unit markers and everything after them', () => {
  assert.equal(addressMatchKey('123 Main St Apt 4'), addressMatchKey('123 Main St'));
  assert.equal(addressMatchKey('123 Main St Unit B'), '123 MAIN');
  assert.equal(addressMatchKey('123 Main St # 200'), '123 MAIN');
});

test('zip5 extracts the first 5-digit run or null', () => {
  assert.equal(zip5('85201-1234'), '85201');
  assert.equal(zip5('85201'), '85201');
  assert.equal(zip5(''), null);
  assert.equal(zip5(null), null);
});

test('sameStreetAddress: the reported false-positive absentee pairs are now equal (no city given, falls back to ZIP)', () => {
  assert.equal(sameStreetAddress('1919 E FLORIAN', null, '85204', '1919 E FLORIAN AVE', null, '85204'), true);
  assert.equal(sameStreetAddress('15321 WHITE HORSE DR', null, '85375', '15321 W WHITE HORSE DR', null, '85375'), true);
  assert.equal(sameStreetAddress('2031 E TAXIDEA WY', null, '85048', '2031 E TAXIDEA WAY', null, '85048'), true);
  assert.equal(sameStreetAddress('8601 E VALLEY VW', null, '85022', '8601 E VALLEY VIEW RD', null, '85022'), true);
});

test('sameStreetAddress: matches when a ZIP is missing, rejects when both ZIPs differ (no city given)', () => {
  assert.equal(sameStreetAddress('123 MAIN ST', null, null, '123 MAIN ST', null, '85001'), true);
  assert.equal(sameStreetAddress('123 MAIN ST', null, '85001', '123 MAIN ST', null, '85002'), false);
});

test('sameStreetAddress: a genuinely different address is not absentee-false-positive-proof', () => {
  assert.equal(sameStreetAddress('123 MAIN ST', null, '85001', '456 OAK AVE', null, '85001'), false);
});

test('sameStreetAddress: same street + same city but typo mailing ZIP is NOT absentee (city wins over ZIP)', () => {
  // 712 N NORFOLK CIR, MESA — situs ZIP 85205 vs mailing ZIP typo 85201
  assert.equal(
    sameStreetAddress('712 N NORFOLK CIR', 'MESA', '85205', '712 N NORFOLK CIR', 'MESA', '85201'),
    true
  );
  // 6611 N 46TH DR, GLENDALE — situs ZIP 85301 vs mailing ZIP typo 85031
  assert.equal(
    sameStreetAddress('6611 N 46TH DR', 'GLENDALE', '85301', '6611 N 46TH DR', 'GLENDALE', '85031'),
    true
  );
  // 3102 W BANFF LN, PHOENIX — situs ZIP 85053 vs mailing ZIP typo 85023
  assert.equal(
    sameStreetAddress('3102 W BANFF LN', 'PHOENIX', '85053', '3102 W BANFF LN', 'PHOENIX', '85023'),
    true
  );
  // 10210 E JONES AVE, MESA — situs ZIP 85208 vs mailing ZIP typo 85220
  assert.equal(
    sameStreetAddress('10210 E JONES AVE', 'MESA', '85208', '10210 E JONES AVE', 'MESA', '85220'),
    true
  );
});

test('sameStreetAddress: same house number but a genuinely different city stays absentee even if ZIP matches', () => {
  assert.equal(
    sameStreetAddress('712 N NORFOLK CIR', 'MESA', '85205', '712 N NORFOLK CIR', 'TEMPE', '85205'),
    false
  );
});

test('sameStreetAddress: a PO Box mailing address stays absentee', () => {
  assert.equal(
    sameStreetAddress('712 N NORFOLK CIR', 'MESA', '85205', 'PO BOX 1234', 'MESA', '85205'),
    false
  );
});

test('sameStreetAddress: city match is case-insensitive', () => {
  assert.equal(
    sameStreetAddress('123 MAIN ST', 'Mesa', '85201', '123 MAIN ST', 'MESA', '85205'),
    true
  );
});
