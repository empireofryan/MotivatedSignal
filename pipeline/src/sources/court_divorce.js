import { parse } from 'node-html-parser';
import { fetchCase, advanceWalk } from '../courtfetch.js';

const BASE = 'https://www.superiorcourt.maricopa.gov/docket/FamilyCourtCases/caseInfo.asp?caseNumber=';

// Family court case numbers run in per-courthouse series; walk each until missStop.
const SERIES_STARTS = [1, 50001, 70001, 90001];

const DISSOLUTION_RE = /Dissolution of|Legal Separation/i;

function toIso(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseDivorceCase(html, caseNumber) {
  // Only dissolution / legal-separation cases signal a likely forced sale.
  // FC also hosts child-support, paternity, etc. — skip those fast.
  if (!DISSOLUTION_RE.test(html)) return null;

  const root = parse(html);

  // Unlike probate, family-court pages emit one div.row#tblForms2 PER PARTY
  // (duplicate ids), with .col-lg-4 = name and first .col-lg-3 = relationship.
  let petitioner = null;
  let respondent = null;

  const partyRows = root.querySelectorAll('#tblForms2');

  for (const row of partyRows) {
    const relationship = row.querySelectorAll('.col-lg-3')[0]?.text?.trim() ?? '';
    const name = (row.querySelectorAll('.col-lg-4')[0]?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name === 'N/A') continue;
    if (relationship === 'Petitioner' && !petitioner) petitioner = name;
    if (relationship === 'Respondent' && !respondent) respondent = name;
  }

  if (!petitioner && !respondent) return null;

  // Earliest docket filing date = when the dissolution was filed.
  const dates = [];
  for (const lbl of root.querySelectorAll('.col-4.m-visibility')) {
    if (lbl.text.trim() !== 'Filing Date') continue;
    const siblings = lbl.parentNode.querySelectorAll('div');
    let passedLabel = false;
    for (const sib of siblings) {
      if (passedLabel) {
        const m = sib.text.trim().match(/\d{1,2}\/\d{1,2}\/\d{4}/);
        if (m) dates.push(new Date(m[0]));
        break;
      }
      if (sib === lbl) passedLabel = true;
    }
  }
  dates.sort((a, b) => a - b);
  const eventDate = dates.length > 0
    ? toIso(`${dates[0].getMonth() + 1}/${dates[0].getDate()}/${dates[0].getFullYear()}`)
    : null;

  return {
    apn: null,
    externalId: caseNumber,
    sourceUrl: BASE + caseNumber,
    eventDate,
    status: 'open',
    ownerName: petitioner ?? respondent,
    situsAddress: null,
    raw: { caseNumber, petitioner, respondent },
  };
}

export default {
  id: 'court_divorce',
  signalType: 'divorce',
  kind: 'scraper',
  // maxBusyStreak: see court_probate.js for why this isn't 1. Shared across
  // all series in this run (not per-series) — if the backend is in a busy
  // spell it affects every series identically, so letting each series spin
  // through its own ~28min tolerance would multiply wait time for no gain.
  async fetch({ year = new Date().getFullYear(), starts = SERIES_STARTS, spanMax = 20000, missStop = 50, budget = 2500, maxBusyStreak = 8 } = {}) {
    // Resume per series from the last case number seen in a prior run.
    const stateKey = `court_divorce:FC${year}`;
    let seriesState = {};
    let saveState = null;
    try {
      const { getState, setState } = await import('../state.js');
      seriesState = (await getState(stateKey)) ?? {};
      saveState = (st) => setState(stateKey, st);
    } catch {
      // no DB state available — walk each series from its start
    }

    const out = [];
    let busy = false;
    let busyStreak = 0;
    let requests = 0; // per-run request budget shared across series (court rate-limits per IP)
    for (const start of starts) {
      if (busy || requests >= budget) break;
      const resumeAt = Math.max(start, (seriesState[start] ?? start - 1) + 1);
      let maxFound = resumeAt - 1;
      let misses = 0;
      for (let n = resumeAt; n < start + spanMax && requests < budget; n++) {
        requests++;
        const caseNumber = `FC${year}-${String(n).padStart(6, '0')}`;
        const { status, text } = await fetchCase(BASE + caseNumber);
        const walk = advanceWalk(status, { busyStreak, misses }, { maxBusyStreak, missStop });
        busyStreak = walk.busyStreak;
        misses = walk.misses;
        if (status === 'busy') {
          console.warn(`[court_divorce] server busy at ${caseNumber} (streak ${busyStreak}/${maxBusyStreak})`);
          if (walk.stop) {
            console.warn('[court_divorce] court throttling persists — stopping this run, resume state kept');
            busy = true;
            break;
          }
          continue; // not a confirmed miss — leave maxFound alone, retry later
        }
        if (status === 'miss') {
          if (walk.stop) break;
          continue;
        }
        maxFound = n; // real case page — series is still live
        const rec = parseDivorceCase(text, caseNumber);
        if (rec) out.push(rec);
      }
      if (maxFound >= resumeAt) seriesState[start] = maxFound;
    }
    if (saveState) await saveState(seriesState);
    // See court_probate.js for why this matters: `busy` here means the last
    // series broke out of its inner loop because maxBusyStreak was hit, not
    // because it ran off the end of real cases — the run is incomplete.
    out.stoppedOnBusy = busy;
    return out;
  },
};
