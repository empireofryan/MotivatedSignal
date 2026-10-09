// pipeline/src/sources/recorder_common.js
// Shared Maricopa County Recorder scraper, parameterized by document code.
// Used by recorder_nots.js (NS) and recorder_liens.js (LP / ML / NL).
//
// Architecture (see recorder_nots.js history for details):
//   Phase 1 – List collection: GET GetRecDataRecentPgDn.aspx, cursor-paginated via `rec=`.
//   Phase 1.5 – Skip-check: recording numbers already in `signals` (source+external_id is
//     UNIQUE, and the upsert is idempotent) don't need a Phase 2 detail fetch at all — the
//     14-day window re-lists ~90% already-known numbers every day. See filterAlreadyStored().
//   Phase 2 – Detail enrichment: per-record ASP.NET form POST → GetRecDataDetail.aspx.
//     Runs DETAIL_CONCURRENCY Playwright pages in parallel, each independently throttled —
//     see the comment on DETAIL_CONCURRENCY below for why this is safe on this host.

import { parse } from 'node-html-parser';
import { chromium } from 'playwright';
import { query } from '../db.js';

const BASE = 'https://legacy.recorder.maricopa.gov/recdocdata/';
const LIST_PAGE = `${BASE}GetRecDataRecentPgDn.aspx`;
const THROTTLE_MS = 1200;
const MAX_PER_PAGE = 250; // recorder supports 20/250/500/1000

// Phase 2 detail pages run on this many concurrent Playwright pages, each still throttled
// to one request per THROTTLE_MS independently. There's no code/history evidence of this
// host rate-limiting by IP the way its sibling court docket site does (courtfetch.js's
// "Server busy" 429-equivalent) — but live-tested at concurrency 2 on 2026-10-03, both
// detail pages reliably failed (`page.fill`/`waitForNavigation` timeouts on the ASP.NET
// WebForms postback) across two separate full runs, even though each `browser.newPage()`
// gets its own isolated context/cookies. This legacy IIS app evidently can't (or won't)
// serve two concurrent sessions from Playwright. Concurrency 1 round-trips a detail page in
// ~8-9s reliably. Leave this at 1; re-test before raising it.
const DETAIL_CONCURRENCY = 1;

// Financial / institutional indicators — used to pick the property owner among
// all parties on a document (owner = the non-institution party).
const INSTITUTION_RE =
  /\b(?:BANK|MORTGAGE|FINANCIAL|LOAN|SERVICES?|TRUSTEE|CORPS?|INC\b|LLC\b|LLP\b|LP\b|FUND|CAPITAL|LENDING|CREDIT|LENDER|NA\b|FSB\b|LAW|ATTORNEY|TITLE|ESCROW|GROUP|ASSOCIATES?|ASSOCIATION|HOA\b|CONDOMINIUM|COMMUNITY|FEDERAL|NATIONAL|INVESTMENT|PROPERTIES|REALTY|HOLDINGS?|RECON|RECONVEYANCE|ZBS|MTC|PENNYMAC)\b/i;

// ── Pure parsers ──────────────────────────────────────────────────────────────

/**
 * Parse a recorder detail page — handles both:
 *   - GetRecDataDetail.aspx       (indexed records: lblRecDocName + lblRecDocCode)
 *   - GetRecDataRecentDetail.aspx (very recent records: no names, code in <select>)
 */
export function parseRecorderDetail(html) {
  const root = parse(html);

  const numEl = root.querySelector('#ctl00_ContentPlaceHolder1_lblRecNum');
  if (!numEl) return [];
  const recNum = numEl.text.trim().replace(/\s+/g, '');
  if (!recNum || !/^\d+$/.test(recNum)) return [];

  const dateEl = root.querySelector('#ctl00_ContentPlaceHolder1_lblRecDate');
  const rawDate = dateEl ? dateEl.text.trim() : '';
  const eventDate = parseRecDate(rawDate);

  const codeSpan = root.querySelector('#ctl00_ContentPlaceHolder1_lblRecDocCode');
  const codeSelect = root.querySelector('#ctl00_ContentPlaceHolder1_lbRecDocCode');
  let docType = '';
  if (codeSpan) {
    docType = codeSpan.text.trim().split('\n')[0].trim();
  } else if (codeSelect) {
    const option = codeSelect.querySelector('option');
    docType = option ? option.text.trim() : '';
  }

  const nameEl = root.querySelector('#ctl00_ContentPlaceHolder1_lblRecDocName');
  const allNames = nameEl
    ? nameEl.innerHTML
        .split(/<br\s*\/?>/gi)
        .map((n) => n.replace(/<[^>]+>/g, '').trim())
        .filter((n) => n.length > 0)
    : [];

  const ownerName = pickOwner(allNames); // null for very recent (unindexed) records

  return [
    {
      apn: null, // not available from this source
      externalId: recNum,
      sourceUrl: `${BASE}GetRecDataDetail.aspx?rec=${recNum}`,
      eventDate,
      status: 'active',
      ownerName,
      situsAddress: null, // not available from this source
      raw: { docType, allNames, recordingDate: rawDate },
    },
  ];
}

/**
 * Parse the list page (GetRecDataRecentPgDn.aspx).
 * Returns { recNums, lastRec, hasMore }.
 */
export function parseListPage(html) {
  const root = parse(html);
  const table = root.querySelector('table#ctl00_ContentPlaceHolder1_Grid1');
  if (!table) return { recNums: [], lastRec: null, hasMore: false };

  const recNums = [];
  for (const row of table.querySelectorAll('tbody tr')) {
    const link = row.querySelector('td a');
    if (!link) continue; // header row
    const recNum = link.text.trim();
    if (/^\d+$/.test(recNum)) recNums.push(recNum);
  }

  // NOTE (2026-10-05 investigation): `hasMore` is NOT a reliable completeness signal on
  // this host. The "Next Page" control is a submit `<input value="Next Page">`, never
  // rendered as the literal text `>Next Page<` this check looks for — so this always
  // evaluates false, even when the page was truncated at `max`. Worse, the input itself
  // (`id="...btnNextPage"`) is present on every page regardless of whether more results
  // exist, so even a correct text/attribute check on the button wouldn't tell us anything.
  // The orchestrator (fetchRecorderDocs / collectChunkRecNums) does NOT use this field —
  // it infers completeness from page size (a page returning exactly `max` rows implies
  // there may be more; fewer than `max` means that's everything). Kept here only because
  // existing tests assert on it and it's cheap to compute; do not wire new logic to it.
  const hasMore = html.includes('btnNextPage') && html.includes('>Next Page<');
  const hiddenRec = root.querySelector('#ctl00_ContentPlaceHolder1_hiddenrec');
  const lastRec = hiddenRec ? hiddenRec.getAttribute('value')?.trim() ?? null : null;

  return { recNums, lastRec, hasMore };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickOwner(names) {
  if (!names || names.length === 0) return null;
  const person = names.find((n) => !INSTITUTION_RE.test(n));
  return (person ?? names[0]).trim() || null;
}

/** "6/9/2026 8:47:00 AM" → "2026-06-09" */
function parseRecDate(rawDate) {
  if (!rawDate) return null;
  const datePart = rawDate.split(/\s+/)[0];
  const [m, d, y] = datePart.split('/');
  if (!m || !d || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * "Now", as a calendar date in Arizona (America/Phoenix — fixed UTC-7,
 * no DST), represented as a UTC-midnight-anchored Date so day-math
 * (setUTCDate) stays correct regardless of the HOST machine's own
 * timezone.
 *
 * Why this matters: `new Date()` + local getters (getMonth/getDate/
 * getFullYear) returns the calendar date in the PROCESS's timezone. On
 * Ryan's laptop that happens to be America/Phoenix, so it was always
 * right by coincidence. GitHub Actions runners are UTC, which rolls to
 * the next calendar day ~5pm Arizona time (UTC = AZ + 7h) — any run
 * dispatched in the Arizona evening computed an `edt` one day in the
 * future. The recorder site validates the end date against its own
 * (Arizona) "today" and rejects a future date with the misleading
 * message "The End date is not a valid date." — which looks exactly
 * like a block (empty Phase 1 results) but isn't one. See
 * pipeline/scripts/probe-sources.mjs for the investigation.
 */
export function arizonaNow(ref = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ref);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

/** Arizona-anchored JS Date (see arizonaNow) → "MM/DD/YYYY" */
export function toRecorderDate(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

/**
 * Default existence lookup: which of `externalIds` are already stored for `source`.
 * Injectable (see fetchRecorderDocs / filterAlreadyStored) so unit tests can run without a DB.
 */
async function defaultLookupExisting(source, externalIds) {
  const { rows } = await query(
    'SELECT external_id FROM signals WHERE source = $1 AND external_id = ANY($2)',
    [source, externalIds]
  );
  return new Set(rows.map((r) => r.external_id));
}

/**
 * Split Phase-1's recording numbers into { toFetch, alreadyStored } using `lookupExisting`
 * (source, externalIds) => Set<string>|Promise<Set<string>>. Never throws: if the lookup
 * itself fails (DB unreachable, bad query, etc.) this falls back to fetching everything —
 * a pre-check failure must never cost us data.
 */
export async function filterAlreadyStored(id, recNums, lookupExisting = defaultLookupExisting) {
  if (recNums.length === 0) return { toFetch: [], alreadyStored: 0 };
  try {
    const existing = await lookupExisting(id, recNums);
    const toFetch = recNums.filter((r) => !existing.has(r));
    return { toFetch, alreadyStored: recNums.length - toFetch.length };
  } catch (e) {
    console.warn(`[${id}] already-stored lookup failed, fetching all ${recNums.length}: ${e.message}`);
    return { toFetch: recNums, alreadyStored: 0 };
  }
}

function buildListUrl(code, startDate, endDate, lastRec = '0', max = MAX_PER_PAGE) {
  const bdt = toRecorderDate(startDate);
  const edt = toRecorderDate(endDate);
  return (
    `${LIST_PAGE}?rec=${lastRec}&suf=&nm=` +
    `&bdt=${encodeURIComponent(bdt)}&edt=${encodeURIComponent(edt)}` +
    `&cde=${code}&max=${max}&res=True&doc1=${code}&doc2=&doc3=&doc4=&doc5=`
  );
}

/**
 * Split a [startDate, endDate] (inclusive, UTC-midnight-anchored Dates — see arizonaNow)
 * window into contiguous, non-overlapping `chunkDays`-sized windows.
 *
 * Why: a single `GetRecDataRecentPgDn.aspx` request over the full 14-day window can return
 * more rows than `max` — confirmed 2026-10-05: a 14-day NS window held 297 recording
 * numbers, but `max=250` silently truncated to the OLDEST 250 (rows are sorted oldest-first),
 * dropping the newest ~4 days of notices every run. Chunking keeps each request's true
 * result count well under the cap (and gives per-chunk visibility in logs); collectChunkRecNums
 * below is still the backstop if a single chunk itself exceeds the cap.
 */
export function splitDateWindowIntoChunks(startDate, endDate, chunkDays) {
  if (chunkDays < 1) throw new Error(`chunkDays must be >= 1, got ${chunkDays}`);
  const chunks = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    chunks.push({ start: new Date(cursor), end: new Date(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

/**
 * Collect every recording number for one chunk, paging via the `rec` cursor whenever a
 * page comes back with exactly `maxPerPage` rows (the only completeness signal this host
 * gives us — see the `hasMore` note on parseListPage). `fetchPage({ cursor }) =>
 * Promise<{ recNums: string[], lastRec: string|null }>` is injected so this is unit-testable
 * without Playwright or a live site. Dedupes recording numbers across pages — confirmed
 * 2026-10-05 that resuming from `rec=<lastRec>` re-returns that same boundary row as the
 * first row of the next page.
 *
 * `maxPagesPerChunk` is a sanity backstop, not an expected real-world path: at current
 * volume (~20 NS/day in Maricopa) a 3-day chunk never gets within an order of magnitude of
 * the 250-row cap, let alone needs ~10 pages (2500 rows) in one chunk. If it ever fires,
 * that means real daily volume has grown enormously — `truncated: true` tells the caller to
 * warn loudly rather than silently return partial data.
 */
export async function collectChunkRecNums(fetchPage, { maxPerPage = MAX_PER_PAGE, maxPagesPerChunk = 10 } = {}) {
  const seen = new Set();
  let cursor = '0';
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages++;
    const { recNums, lastRec } = await fetchPage({ cursor });
    for (const r of recNums) seen.add(r);

    if (recNums.length < maxPerPage) break; // short page ⇒ nothing more in this chunk

    if (!lastRec || pages >= maxPagesPerChunk) {
      truncated = true; // hit cap with no way (or budget) to continue paging
      break;
    }
    cursor = lastRec;
  }

  return { recNums: [...seen], pages, truncated };
}

// ── Main fetcher ──────────────────────────────────────────────────────────────

/** Fetch + parse one recording number's detail page on a given Playwright page. */
async function fetchDetail(page, id, recNum) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(800);

  const year = recNum.substring(0, 4);
  const numPart = recNum.substring(4).replace(/^0+/, '').padStart(7, '0');

  await page.fill('#ctl00_ContentPlaceHolder1_txtRecYear', year);
  await page.fill('#ctl00_ContentPlaceHolder1_txtRecNum', numPart);
  await page.waitForTimeout(200);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
    page.evaluate(() => {
      document.getElementById('ctl00_ContentPlaceHolder1_btnSearchPanel1').click();
    }),
  ]);
  await page.waitForTimeout(300);

  const detailHtml = await page.content();
  const parsed = parseRecorderDetail(detailHtml);
  if (parsed.length === 0) {
    console.warn(`[${id}] Could not parse detail for ${recNum} (URL: ${page.url()})`);
  }
  return parsed;
}

/**
 * Run Phase 2 across `recNums` using `pages` (1 or more Playwright pages) concurrently —
 * one worker per page, each worker paced by THROTTLE_MS independently, so no single page
 * exceeds ~1 request/sec. With DETAIL_CONCURRENCY pages, recNums are striped round-robin
 * across workers.
 */
async function runPhase2(pages, id, recNums) {
  const records = [];
  let processed = 0;

  async function worker(page, workerIdx) {
    for (let i = workerIdx; i < recNums.length; i += pages.length) {
      const recNum = recNums[i];
      try {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
        const parsed = await fetchDetail(page, id, recNum);
        records.push(...parsed);
      } catch (e) {
        console.error(`[${id}] Error on record ${recNum}: ${e.message}`);
      }
      processed++;
      if (processed % 20 === 0) {
        console.log(`[${id}] Phase 2: ${processed}/${recNums.length} records processed`);
      }
    }
  }

  await Promise.all(pages.map((page, idx) => worker(page, idx)));
  return records;
}

/**
 * Fetch all records with the given recorder document code for a date window.
 * @param {string} id    - adapter id (for log prefixes); also the `source` used for the
 *                         already-stored lookup against `signals`.
 * @param {string} code  - recorder document code (NS, LP, ML, NL, …)
 * @param {{ days?: number, chunkDays?: number, lookupExisting?: Function }} opts
 *   `chunkDays` splits the window into day-sized windows (default 3) so a single request
 *   never has to carry the full window's row count up against `max` — see
 *   splitDateWindowIntoChunks for why (2026-10-05: a 14-day NS window silently truncated
 *   from 297 to 250 rows, dropping the newest ~4 days every run).
 */
export async function fetchRecorderDocs(id, code, { days = 14, chunkDays = 3, lookupExisting } = {}) {
  const endDate = arizonaNow();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - days);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // ── Phase 1: collect all recording numbers, chunk by chunk ────────────
    const chunks = splitDateWindowIntoChunks(startDate, endDate, chunkDays);
    const allRecNumsSet = new Set();
    let anyChunkTruncated = false;

    for (const chunk of chunks) {
      const fetchPage = async ({ cursor }) => {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
        const url = buildListUrl(code, chunk.start, chunk.end, cursor, MAX_PER_PAGE);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(500);
        const html = await page.content();
        const { recNums, lastRec } = parseListPage(html);
        return { recNums, lastRec };
      };

      const { recNums, pages: pagesFetched, truncated } = await collectChunkRecNums(fetchPage, {
        maxPerPage: MAX_PER_PAGE,
      });

      console.log(
        `[${id}] chunk ${toRecorderDate(chunk.start)}–${toRecorderDate(chunk.end)}: ` +
          `${recNums.length} recording number(s) across ${pagesFetched} page(s)`
      );
      if (truncated) {
        anyChunkTruncated = true;
        console.warn(
          `[${id}] chunk ${toRecorderDate(chunk.start)}–${toRecorderDate(chunk.end)} hit the per-chunk ` +
            `page cap (${MAX_PER_PAGE}/page) — this chunk's results may still be truncated; consider a smaller chunkDays`
        );
      }
      for (const r of recNums) allRecNumsSet.add(r);
    }

    const allRecNums = [...allRecNumsSet];

    // Phase-1 total is the volume-monitoring signal (see volume-check.js) — preserve it as
    // `.foundCount` on the returned array even though Phase 2 (and thus the emitted records)
    // only covers the not-already-stored subset. run.js reads this to report `found`.
    const attachFoundCount = (records) => {
      records.foundCount = allRecNums.length;
      return records;
    };

    if (allRecNums.length === 0) {
      console.log(`[${id}] Phase 1 done: 0 recording numbers across ${chunks.length} chunk(s)`);
      return attachFoundCount([]);
    }

    console.log(
      `[${id}] Phase 1 done: ${allRecNums.length} unique recording number(s) across ${chunks.length} chunk(s)` +
        (anyChunkTruncated ? ' (WARNING: one or more chunks were truncated — see above)' : '')
    );

    // allRecNums is already de-duped (collected into a Set across chunks/pages).
    const uniqueRecNums = allRecNums;

    // ── Phase 1.5: skip recording numbers we already have in `signals` ────
    const { toFetch, alreadyStored } = await filterAlreadyStored(id, uniqueRecNums, lookupExisting);

    console.log(
      `[${id}] Phase 1: ${allRecNums.length} recording numbers, ${alreadyStored} already stored, fetching ${toFetch.length}`
    );
    if (toFetch.length === 0) return attachFoundCount([]);

    // ── Phase 2: enrich each not-yet-stored record via form submission ────
    const pages = [page];
    for (let i = 1; i < DETAIL_CONCURRENCY && i < toFetch.length; i++) {
      pages.push(await browser.newPage());
    }

    const records = await runPhase2(pages, id, toFetch);

    console.log(`[${id}] Done. ${records.length} records returned.`);
    return attachFoundCount(records);
  } finally {
    await browser.close();
  }
}

/** Build a recorder adapter for a document code. */
export function createRecorderAdapter({ id, signalType, code, days = 14, chunkDays = 3, lookupExisting } = {}) {
  return {
    id,
    signalType,
    kind: 'scraper',
    fetch: (opts = {}) => fetchRecorderDocs(id, code, { days, chunkDays, lookupExisting, ...opts }),
  };
}
