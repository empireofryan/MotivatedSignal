/**
 * Match outreach prospects (Turso `prospects` table) to fresh motivated-seller
 * leads (CockroachDB, via report.js's dailyReport()) — 2 leads cited per
 * prospect for a cold email.
 *
 * Pure selection logic (matchLeadsToProspects, buildPitchLine, labelSignalTypes,
 * normalizeZips/normalizeCities) is unit-tested in test/match-leads.test.js
 * with no DB involved. The CLI entrypoint below wires it to the live DBs.
 *
 * CLI: node --env-file=.env src/match-leads.js [--days 7] [--segment lender] [--ids 1,2,3]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './db.js';
import { dailyReport, formatSitusAddress, titleCase } from './report.js';
import { phoenixDateString } from './skip-if-ran.js';
import {
  prospectsDb,
  ensureProspectColumns,
  populateZipsFromNotes,
  getProspects,
  ensureProspectMatchesTable,
  upsertProspectMatches,
} from './prospects-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// Plain-word signal labels
// ──────────────────────────────────────────────

const SIGNAL_LABELS = {
  trustee_sale: 'notice of trustee sale',
  code_violation: 'code violation',
  tax_delinquent: 'tax delinquent',
  probate: 'probate',
  divorce: 'divorce filing',
  lis_pendens: 'lis pendens',
  mechanics_lien: 'lien',
  lien: 'lien',
};

/** "probate,tax_delinquent" (or a single code) → "Probate + tax delinquent" */
export function labelSignalTypes(raw) {
  if (!raw) return '';
  const codes = [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
  const labels = codes.map((c) => SIGNAL_LABELS[c] ?? c.replace(/_/g, ' '));
  const joined = labels.join(' + ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ──────────────────────────────────────────────
// Prospect zips/cities parsing (comma-separated TEXT columns)
// ──────────────────────────────────────────────

export function normalizeZips(csv) {
  if (!csv) return [];
  return String(csv).split(',').map((s) => s.trim()).filter(Boolean);
}

export function normalizeCities(csv) {
  if (!csv) return [];
  return String(csv).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ──────────────────────────────────────────────
// Lead ranking / pitch line
// ──────────────────────────────────────────────

/** stacked_types desc, score desc, event_date desc (nulls last on all three). */
export function compareLeads(a, b) {
  const sa = a.stacked_types ?? 0;
  const sb = b.stacked_types ?? 0;
  if (sa !== sb) return sb - sa;

  const scoreA = a.score === null || a.score === undefined ? -Infinity : Number(a.score);
  const scoreB = b.score === null || b.score === undefined ? -Infinity : Number(b.score);
  if (scoreA !== scoreB) return scoreB - scoreA;

  const dateA = a.event_date ? new Date(a.event_date).getTime() : -Infinity;
  const dateB = b.event_date ? new Date(b.event_date).getTime() : -Infinity;
  return dateB - dateA;
}

/** A stable identity for a lead row, used to cap/spread assignment across prospects. */
export function leadKey(lead) {
  return lead.apn ?? `${lead.owner_name ?? ''}|${lead.signal_type ?? ''}|${lead.situs_address ?? ''}`;
}

/** True when `lead.signal_types` (comma-joined) or `signal_type` includes `type`. */
export function hasSignalType(lead, type) {
  const raw = lead.signal_types ?? lead.signal_type;
  if (!raw) return false;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .includes(type);
}

/** 0 = trustee_sale + 10yrs+ in the house (ideal lender pitch: real equity), 1 = trustee_sale
 * any tenure, 2 = anything else. Lower sorts first. */
export function lenderPriority(lead) {
  if (hasSignalType(lead, 'trustee_sale')) {
    return Number(lead.years_owned ?? 0) >= 10 ? 0 : 1;
  }
  return 2;
}

/** compareLeads(), but for a `lender` segment prospect, prefers trustee_sale + 10yrs+ leads
 * first, then trustee_sale of any tenure, falling back to the normal ranking only when the
 * lender-priority tier ties (see lenderPriority()). Non-lender segments are unaffected. */
export function compareLeadsForSegment(a, b, segment) {
  if (segment === 'lender') {
    const diff = lenderPriority(a) - lenderPriority(b);
    if (diff !== 0) return diff;
  }
  return compareLeads(a, b);
}

/** e.g. "Probate + tax delinquent · 4412 W Glenrosa Ave, Phoenix 85019 · owned 23 yrs · absentee" */
export function buildPitchLine(lead) {
  const parts = [];

  const sigLabel = labelSignalTypes(lead.signal_types ?? lead.signal_type);
  if (sigLabel) parts.push(sigLabel);

  // Dedupe a doubled trailing unit token (e.g. "1024 E FRYE RD 1100 1100") and title-case the
  // county's ALL-CAPS text, same as the report page (web/app/(app)/report/format.ts).
  const address = lead.situs_address ? titleCase(formatSitusAddress(lead.situs_address)) : null;
  const city = lead.situs_city ? titleCase(lead.situs_city) : null;
  const streetCity = [address, city].filter(Boolean).join(', ');
  const withZip = [streetCity, lead.situs_zip].filter(Boolean).join(' ');
  parts.push(withZip || '(address unresolved)');

  if (lead.years_owned !== null && lead.years_owned !== undefined) {
    parts.push(`owned ${lead.years_owned} yrs`);
  }

  parts.push(lead.absentee ? 'absentee' : 'owner-occupied');

  return parts.join(' · ');
}

// ──────────────────────────────────────────────
// Selection: tiered priority + spread across prospects
// ──────────────────────────────────────────────

/**
 * matchLeadsToProspects(prospects, leads, { perLeadCap }) → [{ prospect, matches }]
 * where matches = [{ lead, tier }], tier ∈ 'zip' | 'city' | 'any'.
 *
 * Priority per prospect: (1) lead.situs_zip ∈ prospect.zips, (2) lead.situs_city
 * (case-insensitive) ∈ prospect.cities, (3) anyone. Within a tier: stacked_types
 * desc, score desc, event_date desc. A lead may be used by at most `perLeadCap`
 * prospects (default 3); unused leads are preferred over already-used ones.
 * Prospects are processed in rank/id order, so output is deterministic given
 * the same input.
 */
export function matchLeadsToProspects(prospects, leads, { perLeadCap = 3 } = {}) {
  const usedCount = new Map();
  for (const lead of leads) usedCount.set(leadKey(lead), 0);

  const orderedProspects = [...prospects].sort((a, b) => {
    const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const results = [];

  for (const prospect of orderedProspects) {
    const sortTier = (tier) =>
      [...tier].sort((a, b) => {
        const ua = usedCount.get(leadKey(a));
        const ub = usedCount.get(leadKey(b));
        if (ua !== ub) return ua - ub; // prefer unused leads
        return compareLeadsForSegment(a, b, prospect.segment);
      });

    const zips = normalizeZips(prospect.zips);
    const cities = normalizeCities(prospect.cities);

    const tier1 = []; // zip match
    const tier2 = []; // city match
    const tier3 = []; // anyone
    for (const lead of leads) {
      if (zips.length && lead.situs_zip && zips.includes(String(lead.situs_zip))) {
        tier1.push(lead);
      } else if (
        cities.length &&
        lead.situs_city &&
        cities.includes(String(lead.situs_city).toLowerCase())
      ) {
        tier2.push(lead);
      } else {
        tier3.push(lead);
      }
    }

    const matches = [];
    const chosenKeys = new Set();
    for (const [tier, label] of [
      [sortTier(tier1), 'zip'],
      [sortTier(tier2), 'city'],
      [sortTier(tier3), 'any'],
    ]) {
      if (matches.length >= 2) break;
      for (const lead of tier) {
        if (matches.length >= 2) break;
        const key = leadKey(lead);
        if (chosenKeys.has(key)) continue;
        if (usedCount.get(key) >= perLeadCap) continue;
        matches.push({ lead, tier: label });
        chosenKeys.add(key);
      }
    }

    for (const { lead } of matches) {
      const key = leadKey(lead);
      usedCount.set(key, usedCount.get(key) + 1);
    }

    results.push({ prospect, matches });
  }

  return results;
}

// ──────────────────────────────────────────────
// Output shaping
// ──────────────────────────────────────────────

export function buildProspectMatch({ prospect, matches }) {
  return {
    id: prospect.id,
    rank: prospect.rank,
    company: prospect.company,
    contact_name: prospect.contact_name,
    email: prospect.email,
    segment: prospect.segment,
    leads: matches.map(({ lead, tier }) => ({
      match_tier: tier,
      owner_name: lead.owner_name ?? null,
      situs_address: lead.situs_address ?? null,
      situs_city: lead.situs_city ?? null,
      situs_zip: lead.situs_zip ?? null,
      signal_types: lead.signal_types ?? lead.signal_type ?? null,
      event_date: lead.event_date ?? null,
      years_owned: lead.years_owned ?? null,
      assessed_value: lead.assessed_value ?? null,
      absentee: lead.absentee ?? null,
      mailing_address: lead.mailing_address ?? null,
      score: lead.score ?? null,
      apn: lead.apn ?? null,
      est_auction_date: lead.est_auction_date ?? null,
      pitch_line: buildPitchLine(lead),
    })),
  };
}

/**
 * Shapes one `buildProspectMatch().leads[i]` entry into a `prospect_matches` row ready for
 * `upsertProspectMatches()`. Dates come back from CockroachDB as JS Date objects (or ISO strings
 * in tests) — normalized to a plain YYYY-MM-DD string since Turso/libsql columns are TEXT.
 * `absentee` (pg boolean) → 0/1/null since sqlite has no boolean type.
 */
export function toMatchRow(prospectId, matchDate, rank, matchedLead) {
  const dateOnly = (d) => {
    if (!d) return null;
    const iso = d instanceof Date ? d.toISOString() : String(d);
    return iso.slice(0, 10);
  };
  return {
    prospect_id: prospectId,
    match_date: matchDate,
    rank,
    apn: matchedLead.apn ?? null,
    pitch_line: matchedLead.pitch_line ?? null,
    match_tier: matchedLead.match_tier ?? null,
    owner_name: matchedLead.owner_name ?? null,
    situs_address: matchedLead.situs_address ?? null,
    situs_city: matchedLead.situs_city ?? null,
    situs_zip: matchedLead.situs_zip ?? null,
    signal_types: matchedLead.signal_types ?? null,
    event_date: dateOnly(matchedLead.event_date),
    est_auction_date: dateOnly(matchedLead.est_auction_date),
    assessed_value: matchedLead.assessed_value ?? null,
    years_owned: matchedLead.years_owned ?? null,
    absentee:
      matchedLead.absentee === null || matchedLead.absentee === undefined
        ? null
        : matchedLead.absentee
          ? 1
          : 0,
    mailing_address: matchedLead.mailing_address ?? null,
  };
}

export function renderMatchesMarkdown(output, { days, dateStr } = {}) {
  const lines = [
    `# Outreach Matches — ${dateStr}`,
    '',
    `Prospects matched: ${output.length} · lead pool: last ${days}d, homeowners only`,
    '',
  ];
  for (const entry of output) {
    lines.push(`## ${entry.rank}. ${entry.company}${entry.segment ? ` (${entry.segment})` : ''}`);
    if (entry.contact_name) lines.push(`Contact: ${entry.contact_name}${entry.email ? ` <${entry.email}>` : ''}`);
    lines.push('');
    entry.leads.forEach((l, i) => {
      lines.push(`${i + 1}. ${l.pitch_line} _(match: ${l.match_tier}; owner: ${l.owner_name ?? '—'})_`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Runner — shared by the CLI entrypoint and src/daily.js
// ──────────────────────────────────────────────

/**
 * Match fresh leads to outreach prospects and write
 * pipeline/outreach/matches-YYYY-MM-DD.{json,md}.
 *
 * Uses the shared CockroachDB `pool` from db.js (caller owns its lifecycle —
 * this function does not call pool.end()). Opens and closes its own Turso
 * (prospects) client.
 */
export async function runMatchLeads({ days = 7, segment, ids } = {}) {
  const db = prospectsDb();
  try {
    await ensureProspectColumns(db);
    const populated = await populateZipsFromNotes(db);

    const [prospects, allLeads] = await Promise.all([
      getProspects({ segment, ids }, db),
      dailyReport({ hours: days * 24, limit: 400, homeownersOnly: true }),
    ]);
    // Only cite parcel-resolved leads with a street address: an "(address unresolved)"
    // line in a cold email reads as a bug, not a lead.
    const leads = allLeads.filter((l) => l.apn && l.situs_address);

    const matched = matchLeadsToProspects(prospects, leads);
    const output = matched.map(buildProspectMatch);

    // Phoenix calendar date, not the runner's local/UTC date — this is a GitHub Actions job
    // (runs in UTC) and match_date must agree with the daily report's own Phoenix-day convention
    // (see report.js FRESH_WINDOW_DAYS) so the send sheet's "latest date" lookup is unambiguous.
    const dateStr = phoenixDateString();

    const outDir = path.resolve(__dirname, '../outreach');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `matches-${dateStr}.json`);
    const mdPath = path.join(outDir, `matches-${dateStr}.md`);

    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    fs.writeFileSync(mdPath, renderMatchesMarkdown(output, { days, dateStr }));

    // Persist to Turso so the Vercel send sheet (which can't read pipeline/outreach/*.json off
    // disk) can render today's two leads into Email A touch 1.
    await ensureProspectMatchesTable(db);
    const matchRows = output.flatMap((entry) =>
      entry.leads.map((lead, i) => toMatchRow(entry.id, dateStr, i + 1, lead))
    );
    const upsertedCount = await upsertProspectMatches(matchRows, db);
    console.log(`Upserted ${upsertedCount} rows into Turso prospect_matches for ${dateStr}`);

    const zipOrCityMatches = output.filter((e) =>
      e.leads.some((l) => l.match_tier === 'zip' || l.match_tier === 'city')
    ).length;

    console.log(`\nOutreach lead matching — ${dateStr}`);
    console.log(`Prospect columns zips/cities populated from notes this run: ${populated}`);
    console.log(`Prospects: ${output.length} · fresh lead pool (last ${days}d, homeowners only): ${leads.length}`);
    console.log(`Prospects with a zip/city-targeted match: ${zipOrCityMatches} · fallback-only: ${output.length - zipOrCityMatches}`);
    console.log(`Wrote ${jsonPath}\nWrote ${mdPath}\n`);

    console.log('Prospect'.padEnd(42) + 'Pitch lines');
    console.log('─'.repeat(100));
    for (const entry of output) {
      console.log(`${entry.rank}. ${entry.company}`.slice(0, 42).padEnd(42) + (entry.leads[0]?.pitch_line ?? '—'));
      entry.leads.slice(1).forEach((l) => {
        console.log(''.padEnd(42) + l.pitch_line);
      });
    }

    return { prospects: output.length, leads: leads.length, jsonPath, mdPath, matchRowsUpserted: upsertedCount };
  } finally {
    await db.close();
  }
}

// ──────────────────────────────────────────────
// CLI entrypoint
// ──────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i > -1 ? args[i + 1] : undefined;
  };

  const days = getArg('--days') ? Number(getArg('--days')) : 7;
  const segment = getArg('--segment');
  const idsArg = getArg('--ids');
  const ids = idsArg
    ? idsArg.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
    : undefined;

  await runMatchLeads({ days, segment, ids });
  await pool.end();
}
