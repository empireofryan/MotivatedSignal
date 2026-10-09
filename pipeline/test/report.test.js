// pipeline/test/report.test.js — pure regex tests (no DB). These exercise the
// exact pattern strings interpolated into the enriched-CTE SQL in report.js,
// so a pass here means the SQL's `~* '<pattern>'` behaves the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITY_REGEX, PLACEHOLDER_OWNER_REGEX, formatSitusAddress, renderMarkdown } from '../src/report.js';

const entityRe = new RegExp(ENTITY_REGEX, 'i');
const placeholderRe = new RegExp(PLACEHOLDER_OWNER_REGEX, 'i');

test('ENTITY_REGEX matches associations, HOAs, and the ASSOC abbreviation', () => {
  assert.ok(entityRe.test('Homestead Homewoners Assoc'), 'ASSOC abbreviation should match');
  assert.ok(entityRe.test('11TH ST VILLAS HOMEOWNERS ASSOC INC'));
  assert.ok(entityRe.test('LAVEEN MEADOWS HOMEOWNERS ASSOCIATION INC'));
  assert.ok(entityRe.test('Some HOA'));
  assert.ok(entityRe.test('Sunset Condominium'));
  assert.ok(entityRe.test('Oak Grove Community'));
});

test('ENTITY_REGEX matches government/school/district/church bodies', () => {
  assert.ok(entityRe.test('CITY OF PHOENIX'));
  assert.ok(entityRe.test('MARICOPA COUNTY'));
  assert.ok(entityRe.test('STATE OF ARIZONA'));
  assert.ok(entityRe.test('FLOOD CONTROL DISTRICT OF MARICOPA COUNTY'));
  assert.ok(entityRe.test('ALMA SCHOOL DISTRICT'));
  assert.ok(entityRe.test('First Baptist Church'));
});

test('ENTITY_REGEX still matches existing LLC/corp/bank patterns', () => {
  assert.ok(entityRe.test('ACME HOLDINGS LLC'));
  assert.ok(entityRe.test('BIG BANK N A'));
  assert.ok(entityRe.test('WELLS CORP'));
});

test('ENTITY_REGEX does NOT match family/revocable/living trusts or Estate Of', () => {
  assert.ok(!entityRe.test('Smith Family Trust'));
  assert.ok(!entityRe.test('John Doe Revocable Trust'));
  assert.ok(!entityRe.test('Jane Doe Living Trust'));
  assert.ok(!entityRe.test('Estate Of John Smith'));
});

test('ENTITY_REGEX does NOT match ordinary homeowner names', () => {
  assert.ok(!entityRe.test('STEWART PAYTON KATHLEEN'));
  assert.ok(!entityRe.test('FOLLOWAY JAMES H'));
  assert.ok(!entityRe.test('PERTSOV BORIS'));
});

test('PLACEHOLDER_OWNER_REGEX matches assessor data-entry placeholders', () => {
  assert.ok(placeholderRe.test('TOFOLLOW'));
  assert.ok(placeholderRe.test('TO FOLLOW'));
  assert.ok(placeholderRe.test('N/A'));
  assert.ok(placeholderRe.test('NA'));
  assert.ok(placeholderRe.test('UNKNOWN'));
  assert.ok(placeholderRe.test('OWNER UNKNOWN'));
});

test('PLACEHOLDER_OWNER_REGEX does NOT match real names containing substrings', () => {
  assert.ok(!placeholderRe.test('NANCY ALLEN'));
  assert.ok(!placeholderRe.test('FOLLOWILL SHAUN'));
  assert.ok(!placeholderRe.test('UNKNOWN HEIRS OF JOHN SMITH'));
});

test('formatSitusAddress collapses a duplicated trailing unit and formats it as #NNNN', () => {
  assert.equal(formatSitusAddress('1730 W EMELITA AVE 2026 2026'), '1730 W EMELITA AVE #2026');
  assert.equal(formatSitusAddress('1360 E BROWN RD 21 21'), '1360 E BROWN RD #21');
  assert.equal(formatSitusAddress('8601 N 103RD AVE 68 68'), '8601 N 103RD AVE #68');
});

test('formatSitusAddress formats a single (already-fixed) trailing unit the same way', () => {
  assert.equal(formatSitusAddress('1730 W EMELITA AVE 1020'), '1730 W EMELITA AVE #1020');
});

test('formatSitusAddress leaves a plain address (no unit) unchanged', () => {
  assert.equal(formatSitusAddress('1919 E FLORIAN AVE'), '1919 E FLORIAN AVE');
});

test('formatSitusAddress passes through null/empty', () => {
  assert.equal(formatSitusAddress(null), null);
  assert.equal(formatSitusAddress(''), '');
});

test('renderMarkdown headline counts new (fresh-filed) signals, with a backfill note', () => {
  const counts = [
    { signal_type: 'code_violation', n: 2, older_n: 50, freshest: '2026-10-02' },
    { signal_type: 'divorce', n: 1, older_n: 10, freshest: '2026-10-01' },
    { signal_type: 'trustee_sale', n: 0, older_n: 0, freshest: null },
  ];
  const md = renderMarkdown([], counts, { hours: 24, homeownersOnly: true });
  assert.match(md, /3 new signals in the last 24h, homeowners only\./);
  assert.match(md, /plus 60 older filings newly detected \(backfill\), hidden below\./);
  assert.match(md, /- code_violation: 2/);
  assert.match(md, /- divorce: 1/);
  assert.doesNotMatch(md, /- trustee_sale/);
  assert.match(md, /Freshest filings: code violation Oct 2 and divorce Oct 1\./);
});

test('renderMarkdown omits the backfill note when there are none', () => {
  const counts = [{ signal_type: 'probate', n: 5, older_n: 0, freshest: '2026-10-03' }];
  const md = renderMarkdown([], counts, { hours: 24 });
  assert.doesNotMatch(md, /newly detected/);
});

test('renderMarkdown omits the freshest-filings line when no type has a fresh filing', () => {
  const counts = [{ signal_type: 'probate', n: 0, older_n: 5, freshest: null }];
  const md = renderMarkdown([], counts, { hours: 24 });
  assert.doesNotMatch(md, /Freshest filings/);
});

test('renderMarkdown has no em dash characters anywhere in its output', () => {
  const counts = [
    { signal_type: 'code_violation', n: 2, older_n: 50, freshest: '2026-10-02' },
  ];
  const rows = [
    { apn: null, signal_type: 'probate', situs_address: null, situs_city: null, owner_name: null, absentee: null, assessed_value: null, years_owned: null, mailing_address: null, score: null, event_date: null, est_auction_date: null },
  ];
  const md = renderMarkdown(rows, counts, { hours: 24 });
  assert.ok(!md.includes('—'), 'markdown output must not contain an em dash');
});

test('renderMarkdown distinguishes "no situs on file" (apn present) from "(unresolved)" (apn null)', () => {
  const rows = [
    { apn: '123', signal_type: 'probate', situs_address: null, situs_city: null, owner_name: 'A', absentee: null, assessed_value: null, years_owned: null, mailing_address: null },
    { apn: null, signal_type: 'probate', situs_address: null, situs_city: null, owner_name: 'B', absentee: null, assessed_value: null, years_owned: null, mailing_address: null },
  ];
  const md = renderMarkdown(rows, [], { hours: 24 });
  assert.match(md, /\(no situs on file\)/);
  assert.match(md, /\(unresolved\)/);
});
