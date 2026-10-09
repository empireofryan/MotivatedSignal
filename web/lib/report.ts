import { unstable_cache } from 'next/cache';
import { query } from './db';

export type ReportRow = {
  apn: string | null;
  signal_type: string;
  source: string;
  event_date: string | null;
  owner_name: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  score: number | null;
  is_hot: boolean | null;
  stacked_types: number | null;
  // added 2026-09-10 (free assessor fields + dedupe)
  signal_types: string | null;      // comma-joined distinct types on this parcel, e.g. "trustee_sale,tax_delinquent"
  mailing_address: string | null;   // owner's mailing address (differs from situs when absentee)
  absentee: boolean | null;
  is_entity: boolean;               // LLC/bank/corp owner (not a homeowner)
  assessed_value: number | null;
  last_sale_price: number | null;
  last_sale_date: string | null;
  years_owned: number | null;
  // added for the Auction column: county recorder doesn't publish the trustee-sale date,
  // so this is an ESTIMATE (newest trustee_sale event_date + 90d, A.R.S. 33-808 min. notice).
  est_auction_date: string | null;
  // added 2026-10-05 (provenance): first_seen is this row's own created_at (the signal
  // whose event_date is shown in "Filed") — "we had it on day X" proof. signals is every
  // distinct signal_type on the parcel (newest occurrence per type, max 6, newest-first),
  // for the row-expand panel. Public record identifiers — shown to free and Pro visitors
  // alike; only the mailing address stays gated.
  first_seen: string;
  signals: ReportSignal[];
};

export type ReportSignal = {
  type: string;
  source: string;
  external_id: string;
  source_url: string | null;
  event_date: string | null;
  first_seen: string;
};

export type ReportCount = { signal_type: string; n: number; freshest: string | null };

// "New" vs. "backfill" split: a signal counts as freshly filed only if the
// county/court dated it within this many days of today (Phoenix calendar
// date — America/Phoenix has no DST, so this is a fixed UTC-7 day boundary).
// Deliberately independent of `hours` (the created_at detection window) and
// of the row list's own "Filed" filter — widening "New in" from 24h to 7d, or
// picking "Any date" in the row filter, should never redefine what counts as
// fresh in the headline. Keep in sync with pipeline/src/report.js's copy.
export const FRESH_WINDOW_DAYS = 14;

// SQL snippet for "today minus N days" in Phoenix's calendar. Not
// parameterized (days is always a small internal constant, never user input)
// so it can be inlined into FILTER clauses.
function freshCutoffSql(days: number): string {
  return `((now() AT TIME ZONE 'America/Phoenix')::date - INTERVAL '${Math.max(0, Math.floor(days))} days')`;
}

// Shared "enriched" CTE: dedupes signals into one row per resolved parcel
// (most-recent event_date wins) or one row per (owner_name, signal_type) for
// unresolved signals, then joins parcel/score/assessor fields and computes
// is_entity. `filedClause` restricts the candidate pool by event_date — pass
// '' for the headline counts query (which always evaluates the full pool
// against the fixed FRESH_WINDOW_DAYS cutoff) and the row-filter clause for
// the rows query. Keep in sync with pipeline/src/report.js's copy.
function enrichedCte(filedClause: string) {
  return `
    WITH fresh AS (
      SELECT s.apn, s.signal_type, s.source, s.external_id, s.source_url, s.event_date, s.owner_name, s.created_at
      FROM signals s
      WHERE s.created_at > now() - ($1 || ' hours')::interval
      ${filedClause}
    ),
    resolved AS (
      SELECT DISTINCT ON (apn) apn, signal_type, source, external_id, source_url, event_date, owner_name, created_at
      FROM fresh
      WHERE apn IS NOT NULL
      ORDER BY apn, event_date DESC NULLS LAST, created_at DESC
    ),
    unresolved AS (
      SELECT DISTINCT ON (owner_name, signal_type) apn, signal_type, source, external_id, source_url, event_date, owner_name, created_at
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
    -- Provenance (2026-10-05): one JSON entry per distinct signal_type on the
    -- parcel (newest occurrence by event_date, then created_at), capped at 6
    -- and ordered newest-first. Same bounded-join shape as apn_stats above —
    -- scoped to combined_apns, not a full-table scan.
    apn_signal_candidates AS (
      SELECT DISTINCT ON (s3.apn, s3.signal_type)
        s3.apn, s3.signal_type, s3.source, s3.external_id, s3.source_url, s3.event_date, s3.created_at
      FROM signals s3
      JOIN combined_apns ca2 ON ca2.apn = s3.apn
      ORDER BY s3.apn, s3.signal_type, s3.event_date DESC NULLS LAST, s3.created_at DESC
    ),
    apn_signal_ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY apn ORDER BY event_date DESC NULLS LAST, created_at DESC) AS rn
      FROM apn_signal_candidates
    ),
    apn_signals AS (
      SELECT apn,
        jsonb_agg(jsonb_build_object(
          'type', signal_type, 'source', source, 'external_id', external_id,
          'source_url', source_url, 'event_date', event_date, 'first_seen', created_at
        ) ORDER BY event_date DESC NULLS LAST, created_at DESC) AS signals_json
      FROM apn_signal_ranked
      WHERE rn <= 6
      GROUP BY apn
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
        (c.trustee_sale_event_date + INTERVAL '90 days')::date AS est_auction_date,
        c.created_at AS first_seen,
        CASE
          WHEN c.apn IS NOT NULL THEN COALESCE(aps.signals_json, '[]'::jsonb)
          ELSE jsonb_build_array(jsonb_build_object(
            'type', c.signal_type, 'source', c.source, 'external_id', c.external_id,
            'source_url', c.source_url, 'event_date', c.event_date, 'first_seen', c.created_at
          ))
        END AS signals
      FROM staged c
      LEFT JOIN properties p ON p.apn = c.apn
      LEFT JOIN scores sc ON sc.apn = c.apn
      LEFT JOIN apn_signals aps ON aps.apn = c.apn
    )
  `;
}

// Case-insensitive: LLC/bank/corp/institutional owner names, plus associations,
// churches, and government/school/district bodies. Family trusts, revocable/living
// trusts, and "Estate Of" are deliberately NOT matched — they stay "homeowners".
// Keep this identical to pipeline/src/report.js's copy.
export const ENTITY_REGEX =
  '\\b(LLC|L L C|INC|CORP|CORPORATION|BANK|N A|ASSOCIATION|ASSN|ASSOC|HOA|CONDOMINIUM|COMMUNITY|' +
  'PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|COMPANY|CO|LP|LLP|LTD|PARTNERS|PARTNERSHIP|VENTURES|' +
  'CAPITAL|FUND|MORTGAGE|LENDING|SERVICES|CHURCH|CITY OF|COUNTY|STATE OF|SCHOOL|DISTRICT|REALTY|HOMES|' +
  'DEVELOPMENT|CONSTRUCTION)\\b';

// Owner-name placeholders from the assessor's own data entry (not real names) —
// treated as not-a-homeowner alongside entity matches. Keep identical to
// pipeline/src/report.js's copy.
export const PLACEHOLDER_OWNER_REGEX = '^(TO ?FOLLOW|UNKNOWN|N/?A|OWNER UNKNOWN)$';

type RawCountRow = { signal_type: string; n: number; older_n: number; freshest: string | null };

// The actual DB fetch, cached (see getDailyReport below). Keyed only on the
// query inputs — never on the Pro cookie or anything request-specific — so
// free and Pro visitors share one cache entry per (hours, limit,
// filedWithinHours, homeownersOnly) combination; the page slices rows for
// free visitors after this returns. The pipeline refreshes the underlying
// data once a day (~06:30 Phoenix), so a 15-minute cache is well inside the
// freshness bar while turning repeated chip clicks from a multi-second
// CockroachDB round trip into an in-memory hit.
const getCachedReportData = unstable_cache(
  async (hours: number, limit: number, filedWithinHoursKey: number | null, homeownersOnly: boolean) => {
    const filedWithinHours = filedWithinHoursKey ?? undefined;
    // Row-list filter only (the "Filed" chip) — unrelated to the headline's
    // fixed FRESH_WINDOW_DAYS cutoff below.
    const filedClause = filedWithinHours
      ? `AND s.event_date >= (now() - INTERVAL '${Math.floor(filedWithinHours)} hours')::date`
      : '';
    const homeownersClause = `($2 = false) OR (owner_name IS NOT NULL AND is_entity = false)`;
    const freshCutoff = freshCutoffSql(FRESH_WINDOW_DAYS);

    const [rows, counts] = await Promise.all([
      query(
        `
        ${enrichedCte(filedClause)}
        SELECT
          apn, signal_type, source, event_date, owner_name, situs_address, situs_city, situs_zip,
          score, is_hot, stacked_types, signal_types, mailing_address, absentee, is_entity,
          assessed_value, last_sale_price, last_sale_date, years_owned, est_auction_date,
          first_seen, signals
        FROM enriched
        WHERE ${homeownersClause}
        -- apn/owner_name/signal_type as final tiebreaks: rows can tie exactly
        -- on (score, created_at) — resolved rows share an apn, unresolved
        -- rows are apn-NULL and keyed by (owner_name, signal_type) instead —
        -- and without a deterministic last key CockroachDB's row order among
        -- ties depends on the physical plan. It changed (silently reshuffling
        -- tied rows) when this query was rewritten to join apn_stats instead
        -- of using correlated subqueries. Keep in sync with
        -- pipeline/src/report.js's copy.
        ORDER BY score DESC NULLS LAST, created_at DESC, apn NULLS LAST, owner_name NULLS LAST, signal_type
        LIMIT $3
        `,
        [String(hours), homeownersOnly, limit]
      ),
      // Headline: a signal is "new" only if it was ALSO filed within
      // FRESH_WINDOW_DAYS — not just detected (created_at) within the selected
      // window. A backfilling walker can land thousands of months-old case
      // numbers in one run, which is what made the old created_at-only count
      // wildly overstate "new" activity. `n` = new (fresh); `older_n` =
      // detected in the window but filed earlier than FRESH_WINDOW_DAYS ago, or
      // never dated ("backfill"). `freshest` = the newest event_date among the
      // fresh ones, for the "Freshest filings: ..." line. Always uses the fixed
      // cutoff, independent of the row list's own "Filed" filter above — n/
      // older_n/freshest come from one query so they never disagree.
      query(
        `
        ${enrichedCte('')}
        SELECT signal_type,
          count(*) FILTER (WHERE event_date >= ${freshCutoff})::int AS n,
          count(*) FILTER (WHERE event_date IS NULL OR event_date < ${freshCutoff})::int AS older_n,
          max(event_date) FILTER (WHERE event_date >= ${freshCutoff}) AS freshest
        FROM enriched
        WHERE ${homeownersClause}
        -- signal_type as a tiebreak: multiple zero-count types otherwise tie
        -- on n and their relative order depends on the physical plan (not
        -- user-visible — the page filters n=0 out — but kept deterministic
        -- for testability). Keep in sync with pipeline/src/report.js's copy.
        GROUP BY signal_type ORDER BY n DESC, signal_type
        `,
        [String(hours), homeownersOnly]
      ),
    ]);
    return {
      rows: rows.rows as ReportRow[],
      countsRows: counts.rows as RawCountRow[],
    };
  },
  // v3 (2026-10-05): row shape gained first_seen/signals — bump so a stale
  // v2 cache entry from before this deploy is never read as the new shape.
  ['daily-report-v3'],
  { revalidate: 900, tags: ['daily-report'] }
);

export async function getDailyReport(
  hours = 24,
  limit = 50,
  filedWithinHours?: number,
  homeownersOnly = true
) {
  const { rows, countsRows } = await getCachedReportData(hours, limit, filedWithinHours ?? null, homeownersOnly);
  const filedCounts = countsRows
    .filter((c) => Number(c.n) > 0)
    .map((c) => ({ signal_type: c.signal_type, n: Number(c.n), freshest: c.freshest ?? null }));
  const olderFiledCount = countsRows.reduce((a, c) => a + Number(c.older_n), 0);
  return {
    rows,
    counts: filedCounts as ReportCount[],
    olderFiledCount,
    hours,
    filedWithinHours: filedWithinHours ?? null,
    // Wall-clock, computed fresh on every call (outside the cache) so the
    // "Generated ..." footer always shows the real request time, not when
    // the underlying data was last cached.
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared window/filed chip options. Single source of truth for the report
// page and the CSV export route (added separately) so a window/filed URL
// param resolves identically in both places. `window` has no-param default
// 7 days (trial users land Monday morning, when the recorder/courts haven't
// posted anything over the weekend and a 24h default would show almost
// nothing but city code violations); `window=24h` is still explicit and
// `48`/`7d` are unchanged. `filed` keeps defaulting to the 2-week
// "hide backfill" view, independent of the window default.
export const WINDOW_OPTIONS = [
  { key: '24h', hours: 24, label: '24 hours' },
  { key: '48', hours: 48, label: '48 hours' },
  { key: '7d', hours: 168, label: '7 days' },
];
export const DEFAULT_WINDOW_KEY = '7d';

export const FILED_OPTIONS = [
  { key: 'any', label: 'Any date', days: undefined as number | undefined },
  { key: '24', label: 'Past day', days: 1 },
  { key: '48', label: 'Past 2 days', days: 2 },
  { key: '14d', label: 'Past 2 weeks', days: 14 },
];
export const DEFAULT_FILED_KEY = '14d';

export function resolveWindowOption(windowParam?: string) {
  const key = WINDOW_OPTIONS.some((o) => o.key === windowParam) ? (windowParam as string) : DEFAULT_WINDOW_KEY;
  return WINDOW_OPTIONS.find((o) => o.key === key)!;
}

export function resolveFiledOption(filedParam?: string) {
  const key = FILED_OPTIONS.some((o) => o.key === filedParam) ? (filedParam as string) : DEFAULT_FILED_KEY;
  return FILED_OPTIONS.find((o) => o.key === key)!;
}

// Pro/trial gate check — same rule everywhere a route needs to know whether
// the `ms_pro` cookie grants access: set by /api/pro?key=… (subscribers) or
// /api/trial?k=… (cold-email prospects).
export function isProAccess(cookieValue: string | undefined | null): boolean {
  if (!cookieValue) return false;
  return (
    (!!process.env.PRO_KEY && cookieValue === process.env.PRO_KEY) ||
    (!!process.env.TRIAL_KEY && cookieValue === process.env.TRIAL_KEY)
  );
}

// "Hottest stacks" strip: top 3 homeowner parcels with >=2 stacked signal
// types, detected in a fixed 7-day window — independent of the page's own
// window/filed/homeowners chips (always 7d, always homeowners-only, always
// filed=any). One query, cached the same way as the main report so warm
// requests stay fast.
const getCachedHotStacks = unstable_cache(
  async () => {
    const hours = 168; // fixed 7-day detection window
    const result = await query(
      `
      ${enrichedCte('')}
      SELECT
        apn, signal_type, source, event_date, owner_name, situs_address, situs_city, situs_zip,
        score, is_hot, stacked_types, signal_types, mailing_address, absentee, is_entity,
        assessed_value, last_sale_price, last_sale_date, years_owned, est_auction_date
      FROM enriched
      -- apn/situs_address required (2026-10-05): a stacked parcel with no resolved
      -- address was rendering as "Address not yet matched" in a strip meant to show
      -- off the data — never show an unresolved row here.
      WHERE (owner_name IS NOT NULL AND is_entity = false) AND stacked_types >= 2
        AND apn IS NOT NULL AND situs_address IS NOT NULL
      ORDER BY score DESC NULLS LAST, created_at DESC, apn NULLS LAST, owner_name NULLS LAST, signal_type
      LIMIT 3
      `,
      [String(hours)]
    );
    return result.rows as ReportRow[];
  },
  ['daily-report-hot-stacks-v2'],
  { revalidate: 900, tags: ['daily-report'] }
);

export async function getHotStacks(): Promise<ReportRow[]> {
  return getCachedHotStacks();
}
