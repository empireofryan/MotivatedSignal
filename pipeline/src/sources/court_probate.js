import { parse } from 'node-html-parser';
import { fetchCase, advanceWalk } from '../courtfetch.js';

const BASE = 'https://www.superiorcourt.maricopa.gov/docket/ProbateCourtCases/caseInfo.asp?caseNumber=';

function toIso(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function parseProbateCase(html, caseNumber) {
  const root = parse(html);

  // Quick check - if no "Decedent" text anywhere, return null fast
  if (!root.text.includes('Decedent')) return null;

  // The party section is a div#tblForms2; each party row is a div.row.g-0 with id="tblForms3".
  // Within each party row:
  //   div.col-8.col-lg-4  → Party Name value
  //   div.col-8.col-lg-3  → first = Relationship value, second = Attorney value
  let decedentName = null;

  const partySection = root.querySelector('#tblForms2');
  const partyRows = partySection
    ? partySection.querySelectorAll('#tblForms3')
    : root.querySelectorAll('#tblForms3');

  for (const row of partyRows) {
    // Get relationship: first .col-lg-3 in this row
    const relDivs = row.querySelectorAll('.col-lg-3');
    const relationship = relDivs[0]?.text?.trim() ?? '';

    if (relationship === 'Decedent') {
      // Get name: the .col-lg-4 div (party name value)
      const nameDivs = row.querySelectorAll('.col-lg-4');
      const raw = nameDivs[0]?.text?.trim() ?? '';
      // Normalize multiple spaces (names sometimes have two spaces)
      decedentName = raw.replace(/\s+/g, ' ').trim();
      break;
    }
  }

  if (!decedentName) return null;

  // Extract earliest filing date from docket entries.
  // Filing date labels are div.col-4.m-visibility with text "Filing Date",
  // and the next sibling div in the same parent row holds the date value.
  const dates = [];
  const labels = root.querySelectorAll('.col-4.m-visibility');
  for (const lbl of labels) {
    if (lbl.text.trim() !== 'Filing Date') continue;
    const parent = lbl.parentNode;
    const siblings = parent.querySelectorAll('div');
    let passedLabel = false;
    for (const sib of siblings) {
      if (passedLabel) {
        const dateText = sib.text.trim();
        const m = dateText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
        if (m) dates.push(new Date(m[0]));
        break;
      }
      if (sib === lbl) passedLabel = true;
    }
  }

  // Sort to find earliest, convert to ISO
  dates.sort((a, b) => a - b);
  const eventDate = dates.length > 0 ? toIso(`${dates[0].getMonth() + 1}/${dates[0].getDate()}/${dates[0].getFullYear()}`) : null;

  return {
    apn: null,
    externalId: caseNumber,
    sourceUrl: BASE + caseNumber,
    eventDate,
    status: 'open',
    ownerName: decedentName,
    situsAddress: null,
    raw: { caseNumber, decedent: decedentName },
  };
}

export default {
  id: 'court_probate',
  signalType: 'probate',
  kind: 'scraper',
  // maxBusyStreak: consecutive "Server busy" responses to tolerate before
  // giving up for this run. The court's caseInfo.asp backend goes into
  // extended (minutes-to-hours) busy spells (confirmed 2026-10-10) that
  // outlast fetchCase's own per-request backoff (~210s) — stopping on the
  // FIRST busy (the old behavior) meant a run gave up after ~3.5 minutes and
  // reported 0 found every time the spell was still active. 8 consecutive
  // busy signals is ~28 min of tolerance (8 × ~210s) before truly giving up,
  // bounded well inside daily.js's 8h watchdog / the 350min CI job timeout.
  async fetch({ year = new Date().getFullYear(), start, max = 12000, missStop = 50, budget = 2000, maxBusyStreak = 8 } = {}) {
    // Resume from the last case number seen in a prior run (per year).
    const stateKey = `court_probate:PB${year}`;
    let saveState = null;
    if (start == null) {
      try {
        const { getState, setState } = await import('../state.js');
        const st = await getState(stateKey);
        start = (st?.lastN ?? 0) + 1;
        saveState = (lastN) => setState(stateKey, { lastN });
      } catch {
        start = 1; // no DB state available — walk from the beginning
      }
    }
    let maxFound = start - 1;
    const out = [];
    let misses = 0;
    let busyStreak = 0;
    let requests = 0;
    for (let n = start; n <= max && requests < budget; n++) {
      requests++;
      const caseNumber = `PB${year}-${String(n).padStart(6, '0')}`;
      const { status, text } = await fetchCase(BASE + caseNumber);
      const walk = advanceWalk(status, { busyStreak, misses }, { maxBusyStreak, missStop });
      busyStreak = walk.busyStreak;
      misses = walk.misses;
      if (status === 'busy') {
        console.warn(`[court_probate] server busy at ${caseNumber} (streak ${busyStreak}/${maxBusyStreak})`);
        if (walk.stop) {
          console.warn('[court_probate] court throttling persists — stopping this run, resume state kept');
          break;
        }
        continue; // not a confirmed miss — leave maxFound alone, retry later
      }
      if (status === 'miss') {
        if (walk.stop) break;
        continue;
      }
      const rec = parseProbateCase(text, caseNumber);
      // Real case page either way (non-decedent = guardianship/conservatorship)
      maxFound = n;
      if (rec) out.push(rec);
    }
    if (saveState && maxFound >= start) await saveState(maxFound);
    return out;
  },
};
