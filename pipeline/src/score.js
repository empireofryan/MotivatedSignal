/**
 * score.js — per-parcel motivation scoring (v2 — time-decayed)
 *
 * Exports:
 *   WEIGHTS          — tunable base-weight map (per signal type + modifiers)
 *   HALF_LIFE_DAYS    — per-type half-life (days) for exponential decay
 *   decayWeight()     — pure: (base, ageDays, halfLife) → decayed weight
 *   isLive()          — pure: (decayedWeight, base) → bool (>= 25% of base)
 *   auctionInfo()     — pure: (trusteeEventDate, now) → auction proximity info
 *   ageInDays()       — pure: (date, now) → integer days elapsed (clamped >= 0)
 *   scoreFor()        — pure: (typeSignals, modifiers, now) → { score, hot, liveCount, breakdown }
 *   computeScores()   — aggregates signals + properties, upserts into scores table
 */

import { pool, query } from './db.js';

// ── Weights (v2 — tunable) ──────────────────────────────────────────────────
export const WEIGHTS = {
  trustee_sale:  50,
  probate:       35,
  divorce:       30,
  code_violation: 25,
  lis_pendens:   25,
  tax_delinquent: 20,
  mechanics_lien: 15,
  lien:          15, // non-governmental (HOA / private) liens
  stack_bonus:   15,
  absentee:      10,
  high_equity:   10,
  long_tenure:    5,
  fresh:         10,
};

// Half-life (days) for exponential decay of each signal type's weight.
// effective weight = base * 0.5^(age_days / half_life)
export const HALF_LIFE_DAYS = {
  trustee_sale:   45,
  lis_pendens:    90,
  divorce:       180,
  probate:       180,
  code_violation: 120,
  mechanics_lien: 180,
  lien:          180,
  tax_delinquent: 365,
};

// Fallback half-life for any signal type not in HALF_LIFE_DAYS (shouldn't
// happen with the current adapter set, but keeps decayWeight well-defined).
const DEFAULT_HALF_LIFE = 180;

// A signal older than this contributes nothing, regardless of half-life.
export const MAX_AGE_DAYS = 730;

// A type only counts toward "live" (stack bonus / hot-by-type-count) once
// its decayed weight is at least this fraction of its base weight.
export const LIVE_THRESHOLD = 0.25;

// A parcel is "fresh" if its newest signal (of any type) is this recent.
export const FRESH_DAYS = 7;

// Arizona trustee sales require >= 90 days' notice (A.R.S. § 33-808). The
// recorder's NOTS feed gives no actual auction date, so we estimate one.
export const AUCTION_MIN_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days elapsed between `date` and `now`, clamped to >= 0 (a future-dated
 * signal — bad data or clock skew — is treated as brand new, not negative-age).
 * Returns Infinity if `date` is null/undefined (never observed → fully decayed).
 *
 * @param {Date|string|null} date
 * @param {Date} now
 * @returns {number}
 */
export function ageInDays(date, now = new Date()) {
  if (date == null) return Infinity;
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(diffMs / DAY_MS));
}

/**
 * Exponential half-life decay of a base weight.
 * Signals older than MAX_AGE_DAYS contribute 0.
 *
 * @param {number} base       — WEIGHTS[type]
 * @param {number} ageDays    — days since the signal's event_date (>= 0, or Infinity)
 * @param {number} halfLife   — HALF_LIFE_DAYS[type]
 * @returns {number}
 */
export function decayWeight(base, ageDays, halfLife) {
  if (ageDays == null || ageDays > MAX_AGE_DAYS) return 0;
  const clampedAge = Math.max(0, ageDays);
  return base * Math.pow(0.5, clampedAge / halfLife);
}

/**
 * Whether a type's decayed weight still counts as "live" (>= 25% of base).
 *
 * @param {number} decayed
 * @param {number} base
 * @returns {boolean}
 */
export function isLive(decayed, base) {
  if (!base || base <= 0) return false;
  return decayed >= base * LIVE_THRESHOLD;
}

/**
 * Estimated auction proximity for a trustee_sale signal.
 * est_auction_date = event_date + AUCTION_MIN_DAYS (A.R.S. 33-808 minimum notice).
 *
 * @param {Date|string|null} eventDate — trustee_sale signal's event_date
 * @param {Date} now
 * @returns {{estDate: string, daysOut: number, bonus: number, passed: boolean} | null}
 */
export function auctionInfo(eventDate, now = new Date()) {
  if (eventDate == null) return null;
  const event = eventDate instanceof Date ? eventDate : new Date(eventDate);
  const estDate = new Date(event.getTime() + AUCTION_MIN_DAYS * DAY_MS);
  const daysOut = Math.floor((estDate.getTime() - now.getTime()) / DAY_MS);

  let bonus = 0;
  if (daysOut >= 0 && daysOut <= 30) bonus = 20;
  else if (daysOut >= 31 && daysOut <= 60) bonus = 10;

  const passed = daysOut < 0;

  return {
    est_date: estDate.toISOString().slice(0, 10),
    days_out: daysOut,
    bonus,
    passed,
  };
}

/**
 * Pure scoring function (v2 — time-decayed).
 *
 * @param {Array<{type: string, date: Date|string|null}>} typeSignals
 *   One entry per distinct signal type on the parcel, `date` = that type's
 *   NEWEST event_date (fallback created_at — resolved by the caller/SQL).
 * @param {object} modifiers — { absentee?, high_equity?, long_tenure? } booleans
 * @param {Date}   now        — reference time for age/decay/auction math
 * @returns {{score: number, hot: boolean, liveCount: number, breakdown: object}}
 */
export function scoreFor(typeSignals = [], modifiers = {}, now = new Date()) {
  const breakdown = { types: {}, modifiers: {}, auction: null, fresh: false };

  let score = 0;
  let liveCount = 0;
  let minAge = Infinity;

  for (const sig of typeSignals) {
    const type = sig.type;
    const base = WEIGHTS[type] ?? 0;
    const halfLife = HALF_LIFE_DAYS[type] ?? DEFAULT_HALF_LIFE;
    const ageDays = ageInDays(sig.date, now);

    // Step 1: raw half-life decay.
    const rawDecayed = decayWeight(base, ageDays, halfLife);
    // Step 2: live/stack-bonus determination uses the raw (pre-auction) decay.
    const live = isLive(rawDecayed, base);
    if (live) liveCount++;
    if (ageDays < minAge) minAge = ageDays;

    // Step 3: trustee-sale auction proximity. Adjusts this type's actual
    // scoring contribution, but does not change its already-decided liveness.
    let contribution = rawDecayed;
    if (type === 'trustee_sale') {
      const auction = auctionInfo(sig.date, now);
      if (auction) {
        breakdown.auction = auction;
        if (auction.passed) contribution = rawDecayed * 0.25;
        score += auction.bonus;
      }
    }

    breakdown.types[type] = { base, age_days: ageDays, decayed: contribution, live };
    score += contribution;
  }

  const typeCount = typeSignals.length;
  if (typeCount > 0 && liveCount > 1) {
    score += WEIGHTS.stack_bonus * (liveCount - 1);
  }

  if (modifiers.absentee)    { score += WEIGHTS.absentee;    breakdown.modifiers.absentee = true; }
  if (modifiers.high_equity) { score += WEIGHTS.high_equity; breakdown.modifiers.high_equity = true; }
  if (modifiers.long_tenure) { score += WEIGHTS.long_tenure; breakdown.modifiers.long_tenure = true; }

  const fresh = minAge <= FRESH_DAYS;
  if (fresh) score += WEIGHTS.fresh;
  breakdown.fresh = fresh;

  const rounded = Math.round(score);
  const hot = rounded >= 60 || liveCount >= 2;

  return { score: rounded, hot, liveCount, breakdown };
}

// ── DB computation ─────────────────────────────────────────────────────────

// Rows per INSERT ... VALUES batch (CockroachDB handles 1k rows well)
const CHUNK_SIZE = 1000;
// Print progress every N parcels processed (scoring pass + upsert pass)
const PROGRESS_EVERY = 20000;

/** Ten years ago (for high_equity heuristic) */
function tenYearsAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 10);
  return d;
}

/** Fifteen years ago (for long_tenure heuristic) */
function fifteenYearsAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 15);
  return d;
}

/**
 * Aggregate resolved signals per apn (newest event_date per signal type),
 * join properties for modifiers, compute decayed scores, upsert into the
 * scores table in chunks.
 *
 * @param {Date} [now] — reference time for decay/auction/fresh math (testable override)
 */
export async function computeScores(now = new Date()) {
  const tenYr     = tenYearsAgo();
  const fifteenYr = fifteenYearsAgo();

  // Make sure the new column exists on live DBs (idempotent, mirrors the
  // `ALTER TABLE properties ADD COLUMN IF NOT EXISTS` pattern in schema.sql).
  await query('ALTER TABLE scores ADD COLUMN IF NOT EXISTS breakdown JSONB');

  // Newest event_date (fallback created_at) per (apn, signal_type), then
  // rolled up into one row per apn with a {type, date} array for scoring.
  const sql = `
    WITH per_type AS (
      SELECT
        apn,
        signal_type,
        MAX(COALESCE(event_date, created_at::date)) AS latest_date
      FROM signals
      WHERE apn IS NOT NULL
      GROUP BY apn, signal_type
    )
    SELECT
      pt.apn,
      json_agg(json_build_object('type', pt.signal_type, 'date', pt.latest_date)) AS type_signals,
      p.absentee,
      p.assessed_value,
      p.last_sale_date
    FROM per_type pt
    JOIN properties p ON p.apn = pt.apn
    GROUP BY pt.apn, p.absentee, p.assessed_value, p.last_sale_date
  `;

  const { rows } = await query(sql, []);

  // Score distribution buckets
  const dist = { '0-25': 0, '26-50': 0, '51-75': 0, '76+': 0 };

  // Build upsert records
  const records = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const typeSignals = (row.type_signals || []).map((ts) => ({ type: ts.type, date: ts.date }));
    const signalTypes = typeSignals.map((ts) => ts.type);

    const absentee = row.absentee === true;

    const lastSale = row.last_sale_date ? new Date(row.last_sale_date) : null;
    const high_equity =
      row.assessed_value != null &&
      (lastSale === null || lastSale < tenYr);

    const long_tenure = lastSale === null || lastSale < fifteenYr;

    const result = scoreFor(typeSignals, { absentee, high_equity, long_tenure }, now);

    const latestDate = typeSignals.reduce(
      (max, ts) => (ts.date && (!max || ts.date > max) ? ts.date : max),
      null
    );

    const components = {
      types: [...new Set(signalTypes)],
      modifiers: { absentee, high_equity, long_tenure },
      fresh: result.breakdown.fresh,
      latest_date: latestDate,
    };

    records[i] = {
      apn: row.apn,
      score: result.score,
      hot: result.hot,
      signal_types: signalTypes,
      components,
      breakdown: result.breakdown,
    };

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(`  scored ${i + 1} / ${rows.length} parcels...`);
    }
  }

  // Upsert in chunks using multi-row VALUES for throughput
  let totalScored = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);

    // Each row needs 6 params: apn, score, hot, signal_types, components, breakdown
    const params = [];
    const valueClauses = chunk.map((rec, idx) => {
      const base = idx * 6;
      params.push(
        rec.apn,
        rec.score,
        rec.hot,
        rec.signal_types,
        JSON.stringify(rec.components),
        JSON.stringify(rec.breakdown)
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb, now())`;
    });

    const sql = `
      INSERT INTO scores (apn, score, hot, signal_types, components, breakdown, updated_at)
      VALUES ${valueClauses.join(', ')}
      ON CONFLICT (apn) DO UPDATE SET
        score        = EXCLUDED.score,
        hot          = EXCLUDED.hot,
        signal_types = EXCLUDED.signal_types,
        components   = EXCLUDED.components,
        breakdown    = EXCLUDED.breakdown,
        updated_at   = now()
    `;

    await query(sql, params);
    totalScored += chunk.length;

    if (totalScored % PROGRESS_EVERY === 0 || totalScored === records.length) {
      console.log(`  upserted ${totalScored} / ${records.length} parcels...`);
    }
  }

  // Build stats from records
  let hotCount = 0;
  const top5 = [];
  for (const rec of records) {
    if (rec.hot) hotCount++;

    if      (rec.score <= 25) dist['0-25']++;
    else if (rec.score <= 50) dist['26-50']++;
    else if (rec.score <= 75) dist['51-75']++;
    else                      dist['76+']++;

    top5.push(rec);
  }

  top5.sort((a, b) => b.score - a.score);
  const top5Sliced = top5.slice(0, 5).map((r) => ({
    apn: r.apn,
    score: r.score,
    hot: r.hot,
    types: [...new Set(r.signal_types)],
  }));

  return { totalScored, hotCount, dist, top5: top5Sliced };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
// Run: node src/score.js

if (process.argv[1] && process.argv[1].endsWith('score.js')) {
  const result = await computeScores();
  console.log('\n=== Scoring complete ===');
  console.log(`Parcels scored : ${result.totalScored}`);
  console.log(`Hot (score≥60 or 2+ live types): ${result.hotCount}`);
  console.log('\nScore distribution:');
  for (const [range, count] of Object.entries(result.dist)) {
    console.log(`  ${range.padEnd(6)}: ${count}`);
  }
  console.log('\nTop 5 scores:');
  for (const r of result.top5) {
    console.log(`  APN ${r.apn}  score=${r.score}  hot=${r.hot}  types=${r.types.join(',')}`);
  }
  await pool.end();
}
