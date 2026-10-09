import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRecorderDetail, parseListPage } from '../src/sources/recorder_nots.js';
import {
  arizonaNow,
  toRecorderDate,
  filterAlreadyStored,
  splitDateWindowIntoChunks,
  collectChunkRecNums,
} from '../src/sources/recorder_common.js';

// Fixture is a recorder detail page for recording number 20260346190 (NS doc type)
const html = readFileSync(new URL('./fixtures/recorder_results.html', import.meta.url), 'utf8');

test('parseRecorderDetail returns an array', () => {
  const rows = parseRecorderDetail(html);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0, 'should have at least one row');
});

test('externalId matches doc number pattern', () => {
  const rows = parseRecorderDetail(html);
  for (const r of rows) {
    assert.match(r.externalId, /^\d{4}\d+$/, `bad externalId: ${r.externalId}`);
  }
});

test('ownerName is populated', () => {
  const rows = parseRecorderDetail(html);
  for (const r of rows) {
    assert.ok(r.ownerName && r.ownerName.length > 0, 'ownerName should not be empty');
  }
});

test('eventDate is ISO date string', () => {
  const rows = parseRecorderDetail(html);
  for (const r of rows) {
    assert.match(r.eventDate, /^\d{4}-\d{2}-\d{2}$/, `bad eventDate: ${r.eventDate}`);
  }
});

test('raw contains docType', () => {
  const rows = parseRecorderDetail(html);
  for (const r of rows) {
    assert.ok(r.raw && r.raw.docType, `raw.docType should exist, got: ${JSON.stringify(r.raw)}`);
    // Should be NS or N/TR SALE variant
    assert.ok(
      /NS|N\/TR SALE/i.test(r.raw.docType),
      `docType should be NS-related, got: ${r.raw.docType}`
    );
  }
});

test('status is active', () => {
  const rows = parseRecorderDetail(html);
  for (const r of rows) {
    assert.equal(r.status, 'active', `status should be active`);
  }
});

// ── parseListPage tests ───────────────────────────────────────────────────────

// Minimal HTML fixture that mirrors the structure parseListPage expects:
//   table#ctl00_ContentPlaceHolder1_Grid1 with tbody rows containing a link per recording number.
//   A "Next Page" button text signals hasMore=true.
//   A hidden input #ctl00_ContentPlaceHolder1_hiddenrec carries the cursor value.
const LIST_HTML_WITH_MORE = `
<html><body>
  <table id="ctl00_ContentPlaceHolder1_Grid1">
    <tbody>
      <tr><td><a href="#">20260346190</a></td></tr>
      <tr><td><a href="#">20260346191</a></td></tr>
      <tr><td><a href="#">20260346192</a></td></tr>
    </tbody>
  </table>
  <input type="hidden" id="ctl00_ContentPlaceHolder1_hiddenrec" value="20260346192" />
  <input type="submit" id="btnNextPage" value=">Next Page<" />
  >Next Page<
</body></html>
`;

const LIST_HTML_LAST_PAGE = `
<html><body>
  <table id="ctl00_ContentPlaceHolder1_Grid1">
    <tbody>
      <tr><td><a href="#">20260346200</a></td></tr>
      <tr><td><a href="#">20260346201</a></td></tr>
    </tbody>
  </table>
  <input type="hidden" id="ctl00_ContentPlaceHolder1_hiddenrec" value="20260346201" />
</body></html>
`;

const LIST_HTML_EMPTY = `
<html><body>
  <div>No results found.</div>
</body></html>
`;

test('parseListPage returns correct recNums array', () => {
  const { recNums } = parseListPage(LIST_HTML_WITH_MORE);
  assert.deepEqual(recNums, ['20260346190', '20260346191', '20260346192']);
});

test('parseListPage hasMore is true when Next Page button present', () => {
  const { hasMore } = parseListPage(LIST_HTML_WITH_MORE);
  assert.equal(hasMore, true);
});

test('parseListPage hasMore is false on last page', () => {
  const { hasMore } = parseListPage(LIST_HTML_LAST_PAGE);
  assert.equal(hasMore, false);
});

test('parseListPage returns correct recNums on last page', () => {
  const { recNums } = parseListPage(LIST_HTML_LAST_PAGE);
  assert.deepEqual(recNums, ['20260346200', '20260346201']);
});

test('parseListPage returns empty recNums when no table', () => {
  const { recNums, hasMore } = parseListPage(LIST_HTML_EMPTY);
  assert.deepEqual(recNums, []);
  assert.equal(hasMore, false);
});

// ── arizonaNow / toRecorderDate ────────────────────────────────────────────────
//
// Regression test for the 2026-10-02 "0 results on GitHub Actions" incident:
// `new Date()` + local getters returns the calendar date in the PROCESS's
// timezone, not Arizona's. GitHub Actions runners are UTC, which is 7 hours
// ahead of Arizona (fixed, no DST) — so any run executing between ~5pm and
// midnight Arizona time computed an `edt` one calendar day in the future.
// The recorder site rejects a future end date with "The End date is not a
// valid date.", producing an empty (but HTTP 200) Phase 1 result that looked
// exactly like a bot block. See pipeline/scripts/probe-sources.mjs.

test('arizonaNow matches Arizona wall-clock date for a fixed instant, independent of host TZ', () => {
  // 2026-10-02T23:30:00-07:00 (Arizona evening) == 2026-10-03T06:30:00Z —
  // a UTC-timezone host would compute "today" as Oct 3rd; Arizona's is Oct 2nd.
  const ref = new Date('2026-10-03T06:30:00Z');
  const az = arizonaNow(ref);
  assert.equal(az.getUTCFullYear(), 2026);
  assert.equal(az.getUTCMonth(), 9); // 0-indexed → October
  assert.equal(az.getUTCDate(), 2);
  assert.equal(toRecorderDate(az), '10/02/2026');
});

test('arizonaNow rolls over at the correct Arizona midnight boundary', () => {
  // One minute later, Arizona has rolled to Oct 3rd too.
  const ref = new Date('2026-10-03T07:01:00Z'); // 2026-10-03T00:01:00-07:00
  const az = arizonaNow(ref);
  assert.equal(toRecorderDate(az), '10/03/2026');
});

// ── filterAlreadyStored() ────────────────────────────────────────────────────
//
// Pure skip-check logic for Phase 2: given Phase 1's recording numbers and an
// injected lookup, decide which ones already exist in `signals` and don't need
// a detail-page fetch. Injectable so this runs with no DB and no Playwright.

test('filterAlreadyStored fetches everything when nothing is already stored', async () => {
  const lookup = async () => new Set();
  const { toFetch, alreadyStored } = await filterAlreadyStored(
    'recorder_nots',
    ['1001', '1002', '1003'],
    lookup
  );
  assert.deepEqual(toFetch, ['1001', '1002', '1003']);
  assert.equal(alreadyStored, 0);
});

test('filterAlreadyStored skips recording numbers the lookup reports as existing', async () => {
  const lookup = async (source, ids) => {
    assert.equal(source, 'recorder_nots');
    assert.deepEqual(ids, ['1001', '1002', '1003']);
    return new Set(['1001', '1002']);
  };
  const { toFetch, alreadyStored } = await filterAlreadyStored(
    'recorder_nots',
    ['1001', '1002', '1003'],
    lookup
  );
  assert.deepEqual(toFetch, ['1003']);
  assert.equal(alreadyStored, 2);
});

test('filterAlreadyStored returns toFetch: [] when every recording number is already stored', async () => {
  const lookup = async () => new Set(['1001', '1002']);
  const { toFetch, alreadyStored } = await filterAlreadyStored('recorder_lp', ['1001', '1002'], lookup);
  assert.deepEqual(toFetch, []);
  assert.equal(alreadyStored, 2);
});

test('filterAlreadyStored short-circuits on an empty input without calling the lookup', async () => {
  let called = false;
  const lookup = async () => {
    called = true;
    return new Set();
  };
  const { toFetch, alreadyStored } = await filterAlreadyStored('recorder_nots', [], lookup);
  assert.deepEqual(toFetch, []);
  assert.equal(alreadyStored, 0);
  assert.equal(called, false);
});

test('filterAlreadyStored falls back to fetching everything when the lookup throws', async () => {
  const lookup = async () => {
    throw new Error('DB unreachable');
  };
  const { toFetch, alreadyStored } = await filterAlreadyStored(
    'recorder_nots',
    ['1001', '1002', '1003'],
    lookup
  );
  assert.deepEqual(toFetch, ['1001', '1002', '1003']);
  assert.equal(alreadyStored, 0);
});

test('filterAlreadyStored falls back to fetching everything when the lookup rejects asynchronously', async () => {
  const lookup = () => Promise.reject(new Error('timeout'));
  const { toFetch, alreadyStored } = await filterAlreadyStored('recorder_nots', ['1001'], lookup);
  assert.deepEqual(toFetch, ['1001']);
  assert.equal(alreadyStored, 0);
});

// ── splitDateWindowIntoChunks() ──────────────────────────────────────────────
//
// Regression coverage for the 2026-10-05 "250 found every run" bug: a single
// GetRecDataRecentPgDn.aspx request over a full 14-day window can return more
// rows than `max` (confirmed live: 297 NS records vs max=250), and the site
// sorts oldest-first, so the truncation silently drops the newest notices.
// Chunking the window keeps each request's real result count far under the cap.

test('splitDateWindowIntoChunks covers the full window with no gaps or overlaps', () => {
  const start = new Date('2026-09-21T00:00:00Z');
  const end = new Date('2026-10-05T00:00:00Z'); // 15 calendar days inclusive
  const chunks = splitDateWindowIntoChunks(start, end, 3);

  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].start.toISOString(), start.toISOString());
  assert.equal(chunks[chunks.length - 1].end.toISOString(), end.toISOString());

  // No gaps/overlaps: each chunk's end + 1 day == next chunk's start.
  for (let i = 0; i < chunks.length - 1; i++) {
    const nextExpectedStart = new Date(chunks[i].end);
    nextExpectedStart.setUTCDate(nextExpectedStart.getUTCDate() + 1);
    assert.equal(chunks[i + 1].start.toISOString(), nextExpectedStart.toISOString());
  }
  // Every chunk is exactly 3 days (start..end inclusive) except possibly the last.
  for (const c of chunks.slice(0, -1)) {
    const days = Math.round((c.end - c.start) / 86_400_000) + 1;
    assert.equal(days, 3);
  }
});

test('splitDateWindowIntoChunks handles a window shorter than chunkDays as a single chunk', () => {
  const start = new Date('2026-10-03T00:00:00Z');
  const end = new Date('2026-10-05T00:00:00Z'); // 3-day window, chunkDays=14
  const chunks = splitDateWindowIntoChunks(start, end, 14);
  assert.deepEqual(chunks, [{ start, end }]);
});

test('splitDateWindowIntoChunks handles a window not evenly divisible by chunkDays', () => {
  const start = new Date('2026-09-21T00:00:00Z');
  const end = new Date('2026-10-05T00:00:00Z'); // 15 days / chunkDays=4 -> 4,4,4,3
  const chunks = splitDateWindowIntoChunks(start, end, 4);
  const lengths = chunks.map((c) => Math.round((c.end - c.start) / 86_400_000) + 1);
  assert.deepEqual(lengths, [4, 4, 4, 3]);
  assert.equal(chunks[chunks.length - 1].end.toISOString(), end.toISOString());
});

test('splitDateWindowIntoChunks a single day (start === end) returns one 1-day chunk', () => {
  const d = new Date('2026-10-05T00:00:00Z');
  const chunks = splitDateWindowIntoChunks(d, d, 3);
  assert.deepEqual(chunks, [{ start: d, end: d }]);
});

test('splitDateWindowIntoChunks rejects chunkDays < 1', () => {
  const d = new Date('2026-10-05T00:00:00Z');
  assert.throws(() => splitDateWindowIntoChunks(d, d, 0));
});

// ── collectChunkRecNums() ────────────────────────────────────────────────────
//
// Pure pagination/dedup logic for one chunk, with an injected fetchPage so this
// runs with no Playwright and no live site.

test('collectChunkRecNums stops after one short page (below max)', async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    return { recNums: ['1', '2', '3'], lastRec: '3' };
  };
  const { recNums, pages, truncated } = await collectChunkRecNums(fetchPage, { maxPerPage: 250 });
  assert.deepEqual(recNums.sort(), ['1', '2', '3']);
  assert.equal(pages, 1);
  assert.equal(truncated, false);
  assert.equal(calls, 1);
});

test('collectChunkRecNums pages via the rec cursor when a page hits maxPerPage, and dedupes the repeated boundary row', async () => {
  // Mirrors the live 2026-10-05 observation: paging with rec=<lastRec of page1> re-returns
  // that same recording number as the first row of page 2.
  const page1 = Array.from({ length: 5 }, (_, i) => String(i + 1)); // ['1'..'5']
  const page2 = ['5', '6', '7']; // '5' repeated, then two new ones
  let callCount = 0;
  const fetchPage = async ({ cursor }) => {
    callCount++;
    if (cursor === '0') return { recNums: page1, lastRec: '5' };
    assert.equal(cursor, '5');
    return { recNums: page2, lastRec: '7' };
  };
  const { recNums, pages, truncated } = await collectChunkRecNums(fetchPage, { maxPerPage: 5 });
  assert.deepEqual(recNums.sort((a, b) => a - b), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(pages, 2);
  assert.equal(truncated, false);
  assert.equal(callCount, 2);
});

test('collectChunkRecNums marks truncated when a full page has no cursor to continue from', async () => {
  const fetchPage = async () => ({ recNums: ['1', '2'], lastRec: null });
  const { recNums, truncated } = await collectChunkRecNums(fetchPage, { maxPerPage: 2 });
  assert.deepEqual(recNums.sort(), ['1', '2']);
  assert.equal(truncated, true);
});

test('collectChunkRecNums marks truncated when maxPagesPerChunk safety cap is hit', async () => {
  let calls = 0;
  const fetchPage = async ({ cursor }) => {
    calls++;
    const n = Number(cursor) + 1;
    return { recNums: [String(n)], lastRec: String(n) };
  };
  const { pages, truncated } = await collectChunkRecNums(fetchPage, { maxPerPage: 1, maxPagesPerChunk: 3 });
  assert.equal(pages, 3);
  assert.equal(truncated, true);
  assert.equal(calls, 3);
});

test('collectChunkRecNums returns empty, untruncated result for a chunk with zero records', async () => {
  const fetchPage = async () => ({ recNums: [], lastRec: null });
  const { recNums, pages, truncated } = await collectChunkRecNums(fetchPage, { maxPerPage: 250 });
  assert.deepEqual(recNums, []);
  assert.equal(pages, 1);
  assert.equal(truncated, false);
});
