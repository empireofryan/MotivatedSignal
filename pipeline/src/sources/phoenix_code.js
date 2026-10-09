// pipeline/src/sources/phoenix_code.js
// Phoenix AZ code enforcement cases via nsdonline.phoenix.gov/CodeEnforcement
//
// Uses case-number walk: PEF{YEAR}-{N}, N = 1 upward (no zero-padding).
// Detail page: GET https://nsdonline.phoenix.gov/CodeEnforcement/Details?caseNum=PEF{YEAR}-{N}
//   HTTP 200 (~11 KB)  → real case
//   HTTP 500 (~4.5 KB) → non-existent case (miss)
// Plain fetch — no Playwright needed.
//
// The site archives old case numbers out from under us: a number that was a
// real 200 months ago can become a 500 later (confirmed empirically — e.g. on
// 2026-10-02 the live range for PEF2026 was roughly [10000, 29836], while
// 1-9999 all 500'd). A walker that always restarts at case #1 therefore runs
// straight into a dead zone and hits missStop before ever reaching a live
// case — this is exactly what made phoenix_code report "0 found" on every
// run since 2026-06-23. findLiveFrontier() + per-year scraper_state resume
// (mirroring court_probate.js) fixes that.

import { parse } from 'node-html-parser';

const BASE_URL = 'https://nsdonline.phoenix.gov/CodeEnforcement';
const DETAIL_URL = `${BASE_URL}/Details`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse a Phoenix code-enforcement detail page into a NormalizedRecord.
 *
 * @param {string} html - Full HTML of the Details page
 * @param {string} caseNumber - e.g. "PEF2026-18550"
 * @returns {import('../types.js').NormalizedRecord|null} null if page is a miss/error
 */
export function parsePhoenixDetail(html, caseNumber) {
  // Fast miss-detection: error pages have no "Case Details -" heading
  // and don't contain the case number in an h1.
  if (!html.includes(`Case Details - ${caseNumber}`)) return null;

  const root = parse(html);

  /**
   * Helper: given a <strong> label text, return the text value of the
   * sibling col-md-9 <p> in the same .row.
   *
   * Pattern in the HTML:
   *   <div class="col-md-3"><p><strong>Label:</strong></p></div>
   *   <div class="col-md-9"><p>Value</p></div>
   */
  function getFieldValue(labelText) {
    const strongs = root.querySelectorAll('strong');
    for (const strong of strongs) {
      if (strong.text.trim() !== labelText) continue;
      // Walk up to the col-md-3, then to the row, find col-md-9 sibling
      const row = strong.parentNode?.parentNode?.parentNode; // strong -> p -> div.col-md-3 -> div.row
      if (!row) continue;
      const valueDiv = row.querySelector('.col-md-9');
      if (!valueDiv) continue;
      const p = valueDiv.querySelector('p');
      return p ? p.text.trim() : valueDiv.text.trim();
    }
    return null;
  }

  const situsAddressRaw = getFieldValue('Address:');
  const situsAddress = situsAddressRaw || null;

  const caseStatusRaw = getFieldValue('Case Status:');
  const status = caseStatusRaw || null;

  const caseOpenedRaw = getFieldValue('Case Opened:');
  let eventDate = null;
  if (caseOpenedRaw) {
    // Format from site: "6/09/2026" or " 6/09/2026 " — M/DD/YYYY or M/D/YYYY
    const m = caseOpenedRaw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      eventDate = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
  }

  const responsiblePartyRaw = getFieldValue('Responsible Party:');
  const ownerName = responsiblePartyRaw || null;

  const sourceUrl = `${DETAIL_URL}?caseNum=${encodeURIComponent(caseNumber)}`;

  return {
    apn: null,
    externalId: caseNumber,
    sourceUrl,
    eventDate,
    status,
    ownerName,
    situsAddress,
    raw: {
      caseNumber,
      address: situsAddressRaw,
      caseStatus: caseStatusRaw,
      caseOpened: caseOpenedRaw,
      responsibleParty: responsiblePartyRaw,
    },
  };
}

/**
 * Fetch one case detail page and classify the response.
 *
 *   'hit'   — HTTP 200 and the page parses as a real case
 *   'miss'  — HTTP non-200 (archived/non-existent), or 200 but unparseable
 *   'error' — network/timeout exception — NOT the same as 'miss': a run of
 *             these means the site or network is down, not that we've
 *             reached the end of live cases, so callers should not treat it
 *             as evidence of the walk being finished.
 *
 * @returns {Promise<{status: 'hit'|'miss'|'error', record: object|null}>}
 */
export async function fetchPhoenixCase(caseNumber, { throttleMs = 1100 } = {}) {
  let res, html;
  try {
    res = await globalThis.fetch(`${DETAIL_URL}?caseNum=${encodeURIComponent(caseNumber)}`, {
      headers: { 'User-Agent': UA },
    });
    html = await res.text();
  } catch (err) {
    await new Promise((r) => setTimeout(r, throttleMs));
    return { status: 'error', record: null };
  }
  await new Promise((r) => setTimeout(r, throttleMs));

  if (!res.ok) return { status: 'miss', record: null };
  const record = parsePhoenixDetail(html, caseNumber);
  return record ? { status: 'hit', record } : { status: 'miss', record: null };
}

/**
 * Empirically locate the lowest currently-live case number at or after
 * `seed`. Gallops forward in growing strides until it finds a hit, then
 * binary-searches the miss/hit boundary to pinpoint the frontier exactly.
 *
 * `probe(n)` must resolve to 'hit' or 'miss' — injected so this is testable
 * without a network call; production code passes a real HTTP probe.
 *
 * @returns {Promise<number|null>} the frontier case number, or null if no
 *   live case was found between `seed` and `max` within `maxProbes` probes.
 */
export async function findLiveFrontier({
  seed = 1,
  max = 100000,
  probe,
  strideStart = 250,
  strideMax = 16000,
  maxProbes = 60,
} = {}) {
  let probes = 0;
  const safeProbe = async (n) => {
    probes++;
    return probe(n);
  };

  if (seed >= max) return null;
  if ((await safeProbe(seed)) === 'hit') return seed;

  let lo = seed; // confirmed miss
  let hi = null; // confirmed hit
  let stride = strideStart;
  while (probes < maxProbes) {
    const n = Math.min(lo + stride, max);
    const r = await safeProbe(n);
    if (r === 'hit') {
      hi = n;
      break;
    }
    lo = n;
    if (n >= max) break;
    stride = Math.min(stride * 2, strideMax);
  }
  if (hi == null) return null;

  // Binary-search the exact lo(miss)/hi(hit) boundary.
  while (hi - lo > 1 && probes < maxProbes) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await safeProbe(mid);
    if (r === 'hit') hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Highest case-sequence number already captured for this source/year, or 0
 * if none. Used to seed the cold-start frontier search close to where the
 * walk last left off instead of probing from case #1.
 */
export async function getMaxCaseN(year, { source = 'phoenix_code' } = {}) {
  const { query } = await import('../db.js');
  const { rows } = await query(
    `SELECT external_id FROM signals WHERE source = $1 AND external_id LIKE $2`,
    [source, `PEF${year}-%`]
  );
  let max = 0;
  for (const { external_id } of rows) {
    const m = external_id.match(/^PEF\d+-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export default {
  id: 'phoenix_code',
  signalType: 'code_violation',
  kind: 'scraper',

  /**
   * Walk PEF{year}-{N} upward, fetching each detail page.
   *
   * @param {object} opts
   * @param {number} [opts.year]          - Calendar year (default: current year)
   * @param {number} [opts.start]         - First sequence number to fetch. When
   *   omitted, resumes from scraper_state (`phoenix_code:PEF{year}`), or on a
   *   cold start (no saved state) empirically finds the live frontier instead
   *   of starting at 1.
   * @param {number} [opts.max]           - Last sequence number to consider (default: 100000)
   * @param {number} [opts.missStop]      - Stop after this many consecutive misses (default: 50)
   * @param {number} [opts.budget]        - Max requests to make this run (default: 5000)
   * @param {number} [opts.maxErrorStreak]- Stop after this many consecutive network errors (default: 10)
   * @returns {Promise<import('../types.js').NormalizedRecord[]>}
   */
  async fetch({
    year = new Date().getFullYear(),
    start,
    max = 100000,
    missStop = 50,
    budget = 5000,
    maxErrorStreak = 10,
  } = {}) {
    const stateKey = `phoenix_code:PEF${year}`;
    let saveState = null;
    let maxFound;

    if (start == null) {
      let st = null;
      try {
        const { getState, setState } = await import('../state.js');
        st = await getState(stateKey);
        saveState = (lastN) => setState(stateKey, { lastN });
      } catch (err) {
        console.warn(`[phoenix_code] state unavailable (${err.message}) — no resume this run`);
      }

      if (st?.lastN) {
        start = st.lastN + 1;
        maxFound = st.lastN;
      } else {
        // Cold start — no resume state. Don't blindly walk from case #1:
        // old case numbers are now archived (HTTP 500), so find where live
        // cases currently begin before the dense walk starts.
        let dbMaxN = 0;
        try {
          dbMaxN = await getMaxCaseN(year);
        } catch (err) {
          console.warn(`[phoenix_code] could not read prior max case number (${err.message}) — seeding at 1`);
        }
        const seed = Math.max(dbMaxN, 1);
        const probe = async (n) => {
          const { status } = await fetchPhoenixCase(`PEF${year}-${n}`);
          return status === 'hit' ? 'hit' : 'miss';
        };
        const frontier = await findLiveFrontier({ seed, max, probe });
        if (frontier == null) {
          console.warn(`[phoenix_code] no live case found searching from ${seed} to ${max} — nothing to walk this run`);
          return [];
        }
        console.log(`[phoenix_code] cold start: live frontier found at PEF${year}-${frontier} (seeded from ${seed})`);
        // If the seed itself (our prior high-water mark) was still live, it's
        // already captured — start past it rather than re-fetching it. If the
        // seed had gone archived and the gallop/binary-search moved the
        // frontier forward, that frontier number is new — include it.
        start = frontier === seed && dbMaxN > 0 ? frontier + 1 : frontier;
        maxFound = start - 1;
      }
    } else {
      maxFound = start - 1;
    }

    const out = [];
    let misses = 0;
    let errorStreak = 0;
    let requests = 0;

    for (let n = start; n <= max && requests < budget; n++) {
      requests++;
      const caseNumber = `PEF${year}-${n}`;
      const { status, record } = await fetchPhoenixCase(caseNumber);

      if (status === 'error') {
        errorStreak++;
        misses++;
        if (errorStreak >= maxErrorStreak) {
          console.warn(`[phoenix_code] ${errorStreak} consecutive network errors — stopping this run, resume state kept`);
          break;
        }
        if (misses >= missStop) break;
        continue;
      }
      errorStreak = 0;

      if (status === 'miss') {
        misses++;
        if (misses >= missStop) break;
        continue;
      }

      // hit — a real case, whether or not it had useful fields to parse
      misses = 0;
      maxFound = n;
      if (record) out.push(record);
    }

    if (saveState && maxFound > 0) await saveState(maxFound);
    return out;
  },
};
