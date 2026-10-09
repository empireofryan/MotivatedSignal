/**
 * Daily Motivated Report — the signals that arrived in the last N hours,
 * joined to their parcels and scores, ranked by motivation.
 *
 *   dailyReport()        — query → rows
 *   renderMarkdown()     — rows → markdown digest
 *   CLI: node src/report.js [--hours 24]
 */

import { pool, query } from './db.js';

// "New" vs. "backfill" split: a signal counts as freshly filed only if the
// county/court dated it within this many days of today (Phoenix calendar
// date — America/Phoenix has no DST, so this is a fixed UTC-7 day boundary).
// Deliberately independent of `hours` (the created_at detection window) —
// widening "New in" from 24h to 7d should surface more detections, not
// redefine what counts as fresh. Signals filed earlier than this, or never
// dated, are "backfill": real signals the walkers only just reached, not
// news from today.
export const FRESH_WINDOW_DAYS = 14;

// SQL snippet for "today minus N days" in Phoenix's calendar, used both to
// split new/backfill in reportCounts() and to filter the default row list in
// dailyReport(). Not parameterized (days is always a small internal
// constant, never user input) so it can be inlined into FILTER clauses.
function freshCutoffSql(days) {
  return `((now() AT TIME ZONE 'America/Phoenix')::date - INTERVAL '${Math.max(0, Math.floor(days))} days')`;
}

// `filedDays` nullish means "any date" (no filter). Otherwise restricts the
// `fresh` CTE to signals filed within that many days, which is what hides
// backfill from the default row list.
function filedClauseForDays(filedDays) {
  if (filedDays === null || filedDays === undefined) return '';
  return `AND s.event_date >= ${freshCutoffSql(filedDays)}`;
}

// Case-insensitive: LLC/bank/corp/institutional owner names, plus associations,
// churches, and government/school/district bodies. Family trusts, revocable/living
// trusts, and "Estate Of" are deliberately NOT matched — they stay "homeowners".
// Keep this identical to web/lib/report.ts's copy.
export const ENTITY_REGEX =
  '\\b(LLC|L L C|INC|CORP|CORPORATION|BANK|N A|ASSOCIATION|ASSN|ASSOC|HOA|CONDOMINIUM|COMMUNITY|' +
  'PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|COMPANY|CO|LP|LLP|LTD|PARTNERS|PARTNERSHIP|VENTURES|' +
  'CAPITAL|FUND|MORTGAGE|LENDING|SERVICES|CHURCH|CITY OF|COUNTY|STATE OF|SCHOOL|DISTRICT|REALTY|HOMES|' +
  'DEVELOPMENT|CONSTRUCTION)\\b';

// Owner-name placeholders from the assessor's own data entry (not real names) —
// treated as not-a-homeowner alongside entity matches. Keep identical to
// web/lib/report.ts's copy.
export const PLACEHOLDER_OWNER_REGEX = '^(TO ?FOLLOW|UNKNOWN|N/?A|OWNER UNKNOWN)$';

// Shared "enriched" CTE: dedupes signals into one row per resolved parcel
// (most-recent event_date wins) or one row per (owner_name, signal_type) for
// unresolved signals, then joins parcel/score/assessor fields and computes
// is_entity so both dailyReport() and reportCounts() filter identically.
export function enrichedCte(filedClause) {
  return `
    WITH fresh AS (
      SELECT s.apn, s.signal_type, s.source, s.event_date, s.owner_name, s.created_at
      FROM signals s
      WHERE s.created_at > now() - ($1 || ' hours')::interval
      ${filedClause}
    ),
    resolved AS (
      SELECT DISTINCT ON (apn) apn, signal_type, source, event_date, owner_name, created_at
      FROM fresh
      WHERE apn IS NOT NULL
      ORDER BY apn, event_date DESC NULLS LAST, created_at DESC
    ),
    unresolved AS (
      SELECT DISTINCT ON (owner_name, signal_type) apn, signal_type, source, event_date, owner_name, created_at
      FROM fresh
      WHERE apn IS NULL
      ORDER BY owner_name, signal_type, event_date DESC NULLS LAST, created_at DESC
    ),
    combined AS (
      SELECT * FROM resolved
      UNION ALL
      SELECT * FROM unresolved
    ),
    combined_apns AS (
      SELECT DISTINCT apn FROM combined WHERE apn IS NOT NULL
    ),
    -- One pass over the (small) set of parcels in this result, instead of two
    -- correlated subqueries (count DISTINCT + string_agg) evaluated per output
    -- row: CockroachDB can't turn a per-row scalar subquery into a join and
    -- falls back to an "unoptimized" nested-loop scan per row, which dominated
    -- query time before this rewrite (see idx_signals_apn_type in schema.sql).
    apn_stats AS (
      SELECT
        s2.apn,
        count(DISTINCT s2.signal_type)::int AS stacked_types,
        string_agg(DISTINCT s2.signal_type, ',') AS signal_types,
        max(s2.event_date) FILTER (WHERE s2.signal_type = 'trustee_sale') AS trustee_sale_event_date
      FROM signals s2
      JOIN combined_apns ca ON ca.apn = s2.apn
      GROUP BY s2.apn
    ),
    staged AS (
      SELECT
        c.*,
        -- County recorder doesn't publish the trustee-sale date, so estimate it from the
        -- newest trustee_sale signal on this parcel (A.R.S. 33-808 min. 90-day notice).
        CASE
          WHEN c.apn IS NOT NULL THEN st.trustee_sale_event_date
          WHEN c.signal_type = 'trustee_sale' THEN c.event_date
          ELSE NULL
        END AS trustee_sale_event_date,
        CASE WHEN c.apn IS NOT NULL THEN COALESCE(st.stacked_types, 0) ELSE 0 END AS stacked_types,
        CASE WHEN c.apn IS NOT NULL THEN st.signal_types ELSE c.signal_type END AS signal_types
      FROM combined c
      LEFT JOIN apn_stats st ON st.apn = c.apn
    ),
    enriched AS (
      SELECT
        c.apn, c.signal_type, c.source, c.event_date, c.created_at,
        COALESCE(p.owner_name, c.owner_name) AS owner_name,
        p.situs_address, p.situs_city, p.situs_zip,
        sc.score, sc.hot AS is_hot,
        c.stacked_types,
        c.signal_types,
        p.mailing_address,
        p.absentee,
        (
          (COALESCE(p.owner_name, c.owner_name) ~* '${ENTITY_REGEX}')
          OR (btrim(COALESCE(p.owner_name, c.owner_name)) ~* '${PLACEHOLDER_OWNER_REGEX}')
        ) AS is_entity,
        p.assessed_value::float8 AS assessed_value,
        p.last_sale_price::float8 AS last_sale_price,
        p.last_sale_date,
        CASE
          WHEN p.last_sale_date IS NOT NULL THEN ((now()::date - p.last_sale_date) / 365)::int
          ELSE NULL
        END AS years_owned,
        (c.trustee_sale_event_date + INTERVAL '90 days')::date AS est_auction_date
      FROM staged c
      LEFT JOIN properties p ON p.apn = c.apn
      LEFT JOIN scores sc ON sc.apn = c.apn
    )
  `;
}

const HOMEOWNERS_CLAUSE = `($2 = false) OR (owner_name IS NOT NULL AND is_entity = false)`;

// `filedDays`: hides backfill from the row list by default (14 days — see
// FRESH_WINDOW_DAYS). Pass `null` for "any date" (include backfill).
export async function dailyReport({ hours = 24, limit = 50, homeownersOnly = true, filedDays = FRESH_WINDOW_DAYS } = {}) {
  const { rows } = await query(
    `
    ${enrichedCte(filedClauseForDays(filedDays))}
    SELECT
      apn, signal_type, source, event_date, owner_name, situs_address, situs_city, situs_zip,
      score, is_hot, stacked_types, signal_types, mailing_address, absentee, is_entity,
      assessed_value, last_sale_price, last_sale_date, years_owned, est_auction_date
    FROM enriched
    WHERE ${HOMEOWNERS_CLAUSE}
    -- apn/owner_name/signal_type as final tiebreaks: rows can tie exactly on
    -- (score, created_at), and without a deterministic last key CockroachDB's
    -- row order among ties depends on the physical plan. Keep in sync with
    -- web/lib/report.ts's copy.
    ORDER BY score DESC NULLS LAST, created_at DESC, apn NULLS LAST, owner_name NULLS LAST, signal_type
    LIMIT $3
    `,
    [String(hours), homeownersOnly, limit]
  );
  return rows;
}

// Headline counts: a signal is "new" only if BOTH it was detected (created_at)
// within the selected window AND it was filed (event_date) within the last
// FRESH_WINDOW_DAYS — not just detected recently. A backfilling court walker
// can land thousands of months-old case numbers in one run; counting those as
// "new" is what made the headline read "0 new... plus 7,746 older filings".
// `n` = new (fresh) by that definition; `older_n` = detected in the window but
// filed earlier than FRESH_WINDOW_DAYS ago, or never dated ("backfill").
// `freshest` = the newest event_date among the fresh ones, for the
// "Freshest filings: ..." line. Always uses the fixed FRESH_WINDOW_DAYS
// cutoff, independent of any row-list "Filed" filter, so the headline and its
// breakdown never disagree with each other — they come from one query.
export async function reportCounts({ hours = 24, homeownersOnly = true } = {}) {
  const cutoff = freshCutoffSql(FRESH_WINDOW_DAYS);
  const { rows } = await query(
    `
    ${enrichedCte('')}
    SELECT signal_type,
      count(*) FILTER (WHERE event_date >= ${cutoff})::int AS n,
      count(*) FILTER (WHERE event_date IS NULL OR event_date < ${cutoff})::int AS older_n,
      max(event_date) FILTER (WHERE event_date >= ${cutoff}) AS freshest
    FROM enriched
    WHERE ${HOMEOWNERS_CLAUSE}
    -- signal_type as a tiebreak: multiple zero-count types otherwise tie on
    -- n and their relative order depends on the physical plan. Keep in sync
    -- with web/lib/report.ts's copy.
    GROUP BY signal_type ORDER BY n DESC, signal_type
    `,
    [String(hours), homeownersOnly]
  );
  return rows;
}

function money(n) {
  if (n === null || n === undefined) return '-';
  return `$${Math.round(Number(n) / 1000)}k`;
}

// `2026-10-12 est · in 9d` / `... · today` / `... · 4d ago`. Day-level diff, UTC-normalized
// (matches the UTC-midnight convention `DATE` columns round-trip through pg as).
function auctionCell(estRaw) {
  if (!estRaw) return '-';
  const est = new Date(estRaw);
  const dateStr = est.toISOString().slice(0, 10);
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const estUTC = Date.UTC(est.getUTCFullYear(), est.getUTCMonth(), est.getUTCDate());
  const diffDays = Math.round((estUTC - todayUTC) / 86400000);
  const rel = diffDays === 0 ? 'today' : diffDays > 0 ? `in ${diffDays}d` : `${Math.abs(diffDays)}d ago`;
  return `${dateStr} est · ${rel}`;
}

// JS twin of web/app/(app)/report/format.ts's titleCase — keep in sync. Used
// anywhere a pitch line or report line needs the county's ALL-CAPS text in
// readable case without mangling acronyms (LLC, TR, AZ, ...).
const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'INC', 'II', 'III', 'IV', 'TR', 'PO', 'AZ', 'NA']);
export function titleCase(raw) {
  if (!raw) return raw;
  return raw
    .toLowerCase()
    .split(/(\s+|\/|&)/)
    .map((tok) => {
      const up = tok.toUpperCase();
      if (KEEP_UPPER.has(up.replace(/[^A-Z]/g, ''))) return up;
      return tok.replace(/^([a-z])|([-'][a-z])/g, (m) => m.toUpperCase());
    })
    .join('');
}

// Display-layer fix for a since-fixed ingest bug: situs_address was sometimes
// built by appending the unit twice from two source columns ("... AVE 2026
// 2026"). Collapses an immediately-repeated trailing token, then — since the
// assessor's own export puts a bare unit number right after the street-type
// word with no "#" — reformats that trailing unit as "#NNNN" so existing rows
// render correctly without a re-ingest. Keep in sync with web's copy
// (web/app/(app)/report/page.tsx).
const STREET_TYPE_WORDS = new Set([
  'AVE', 'AV', 'ST', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'WY', 'CIR',
  'BLVD', 'PKWY', 'TRL', 'TER', 'HWY',
]);
export function formatSitusAddress(raw) {
  if (!raw) return raw;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  while (tokens.length >= 2 && tokens[tokens.length - 1].toUpperCase() === tokens[tokens.length - 2].toUpperCase()) {
    tokens.pop();
  }
  let typeIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_TYPE_WORDS.has(tokens[i].toUpperCase())) typeIdx = i;
  }
  if (typeIdx === -1 || typeIdx === tokens.length - 1) return tokens.join(' ');
  const base = tokens.slice(0, typeIdx + 1).join(' ');
  const unit = tokens.slice(typeIdx + 1).join(' ');
  return `${base} #${unit}`;
}

// `Oct 1` — date-only columns round-trip through pg as UTC midnight, so format
// in UTC to avoid shifting a day in either direction. Keep in sync with
// web's fmtDate (web/app/(app)/report/page.tsx).
function shortDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function listSentence(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function renderMarkdown(rows, counts, { hours = 24, homeownersOnly = true } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const totalFiled = counts.reduce((a, c) => a + Number(c.n), 0);
  const totalOlder = counts.reduce((a, c) => a + Number(c.older_n ?? 0), 0);
  // Top 3 signal types by count (counts arrives sorted `n DESC` from the SQL,
  // but don't depend on caller ordering) with a freshest filed date, for the
  // "Freshest filings: ..." line.
  const freshest = counts
    .filter((c) => Number(c.n) > 0 && c.freshest)
    .slice()
    .sort((a, b) => Number(b.n) - Number(a.n))
    .slice(0, 3);
  const lines = [
    `# Daily Motivated Report for ${today}`,
    '',
    `${totalFiled} new signal${totalFiled === 1 ? '' : 's'} in the last ${hours}h${homeownersOnly ? ', homeowners only' : ''}.`,
    ...counts.filter((c) => Number(c.n) > 0).map((c) => `- ${c.signal_type}: ${c.n}`),
    ...(freshest.length
      ? [`Freshest filings: ${listSentence(freshest.map((c) => `${c.signal_type.replace(/_/g, ' ')} ${shortDate(c.freshest)}`))}.`]
      : []),
    ...(totalOlder > 0
      ? [`plus ${totalOlder} older filing${totalOlder === 1 ? '' : 's'} newly detected (backfill), hidden below.`]
      : []),
    '',
    '| # | Score | Filed | Auction | Owner | Address | City | Mailing | Abs | Value ($k) | Owned (yrs) | Signals |',
    '|---|-------|-------|---------|-------|---------|------|---------|-----|------------|-------------|---------|',
  ];
  rows.forEach((r, i) => {
    const filed = r.event_date ? new Date(r.event_date).toISOString().slice(0, 10) : '-';
    // `absentee` is precomputed street-level (mailing vs situs) equality at ingest time —
    // situs_address is street-only while mailing_address includes city/state/zip, so a
    // naive string compare here would almost never match even for owner-occupants.
    const sameMailing = r.absentee === false && !!r.situs_address && !!r.mailing_address;
    const mailing = sameMailing ? 'same' : r.mailing_address ?? '-';
    // A parcel can be resolved (apn present) but have no situs on file (land,
    // or a missing situs in the assessor extract) — that's distinct from a
    // signal that never resolved to a parcel at all.
    const addressCell = r.situs_address
      ? formatSitusAddress(r.situs_address)
      : r.apn
        ? '(no situs on file)'
        : '(unresolved)';
    lines.push(
      `| ${i + 1} | ${r.score ?? '-'}${r.is_hot ? ' 🔥' : ''} | ${filed} | ${auctionCell(r.est_auction_date)} | ` +
        `${r.owner_name ?? '-'} | ${addressCell} | ${r.situs_city ?? '-'} | ` +
        `${mailing} | ${r.absentee ? 'Y' : 'N'} | ${money(r.assessed_value)} | ${r.years_owned ?? '-'} | ` +
        `${r.signal_types ?? r.signal_type} |`
    );
  });
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hoursArg = process.argv.indexOf('--hours');
  const hours = hoursArg > -1 ? Number(process.argv[hoursArg + 1]) : 24;
  const homeownersArg = process.argv.indexOf('--homeowners');
  const homeownersOnly = homeownersArg > -1 ? process.argv[homeownersArg + 1] !== '0' : true;
  // --filed-days any => include backfill in the row list; a number overrides
  // the FRESH_WINDOW_DAYS default. Never affects the headline (reportCounts
  // always uses the fixed FRESH_WINDOW_DAYS cutoff).
  const filedDaysArg = process.argv.indexOf('--filed-days');
  const filedDays =
    filedDaysArg > -1 ? (process.argv[filedDaysArg + 1] === 'any' ? null : Number(process.argv[filedDaysArg + 1])) : undefined;
  const [rows, counts] = await Promise.all([
    dailyReport({ hours, homeownersOnly, ...(filedDays !== undefined ? { filedDays } : {}) }),
    reportCounts({ hours, homeownersOnly }),
  ]);
  console.log(renderMarkdown(rows, counts, { hours, homeownersOnly }));
  await pool.end();
}
