import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreFor,
  decayWeight,
  isLive,
  auctionInfo,
  ageInDays,
  WEIGHTS,
  HALF_LIFE_DAYS,
  MAX_AGE_DAYS,
  LIVE_THRESHOLD,
  FRESH_DAYS,
  AUCTION_MIN_DAYS,
} from '../src/score.js';
import { pool, query } from '../src/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-01-01T00:00:00Z');

function daysAgo(n, from = NOW) {
  return new Date(from.getTime() - n * DAY_MS);
}

// ── decayWeight ──────────────────────────────────────────────────────────

describe('decayWeight', () => {
  test('age 0 → full base weight', () => {
    assert.equal(decayWeight(100, 0, 90), 100);
  });

  test('age == half-life → half base weight', () => {
    assert.equal(decayWeight(100, 90, 90), 50);
  });

  test('age == 2x half-life → quarter base weight', () => {
    assert.equal(decayWeight(100, 180, 90), 25);
  });

  test('exactly at the 730-day floor still decays normally', () => {
    const expected = 100 * Math.pow(0.5, MAX_AGE_DAYS / 90);
    assert.ok(Math.abs(decayWeight(100, MAX_AGE_DAYS, 90) - expected) < 1e-9);
    assert.ok(decayWeight(100, MAX_AGE_DAYS, 90) > 0);
  });

  test('older than 730 days contributes 0', () => {
    assert.equal(decayWeight(100, MAX_AGE_DAYS + 1, 90), 0);
  });

  test('null/undefined age contributes 0', () => {
    assert.equal(decayWeight(100, null, 90), 0);
    assert.equal(decayWeight(100, undefined, 90), 0);
    assert.equal(decayWeight(100, Infinity, 90), 0);
  });
});

// ── ageInDays ────────────────────────────────────────────────────────────

describe('ageInDays', () => {
  test('computes whole days elapsed', () => {
    assert.equal(ageInDays(daysAgo(7), NOW), 7);
    assert.equal(ageInDays(daysAgo(8), NOW), 8);
  });

  test('null date → Infinity', () => {
    assert.equal(ageInDays(null, NOW), Infinity);
  });

  test('future date is clamped to 0, not negative', () => {
    const future = new Date(NOW.getTime() + 5 * DAY_MS);
    assert.equal(ageInDays(future, NOW), 0);
  });
});

// ── isLive ───────────────────────────────────────────────────────────────

describe('isLive', () => {
  test('exactly at the 25% threshold counts as live', () => {
    assert.equal(isLive(25, 100), true);
  });

  test('just under the 25% threshold is not live', () => {
    assert.equal(isLive(24.999, 100), false);
  });

  test('well above threshold is live', () => {
    assert.equal(isLive(80, 100), true);
  });

  test('zero base is never live', () => {
    assert.equal(isLive(0, 0), false);
  });

  test('LIVE_THRESHOLD constant is 0.25', () => {
    assert.equal(LIVE_THRESHOLD, 0.25);
  });
});

// ── auctionInfo ──────────────────────────────────────────────────────────

describe('auctionInfo', () => {
  test('est_auction_date is event_date + 90 days', () => {
    const event = new Date('2026-01-01T00:00:00Z');
    const info = auctionInfo(event, event);
    assert.equal(info.est_date, '2026-04-01');
    assert.equal(AUCTION_MIN_DAYS, 90);
  });

  test('0-30 days out → +20 bonus, not passed', () => {
    // est_date = event + 90; want daysOut = 15 → now = est_date - 15
    const event = daysAgo(90 - 15, NOW); // event 75 days ago
    const info = auctionInfo(event, NOW);
    assert.equal(info.days_out, 15);
    assert.equal(info.bonus, 20);
    assert.equal(info.passed, false);
  });

  test('31-60 days out → +10 bonus, not passed', () => {
    const event = daysAgo(90 - 45, NOW); // daysOut = 45
    const info = auctionInfo(event, NOW);
    assert.equal(info.days_out, 45);
    assert.equal(info.bonus, 10);
    assert.equal(info.passed, false);
  });

  test('more than 60 days out → no bonus', () => {
    const event = daysAgo(0, NOW); // daysOut = 90
    const info = auctionInfo(event, NOW);
    assert.equal(info.days_out, 90);
    assert.equal(info.bonus, 0);
    assert.equal(info.passed, false);
  });

  test('passed auction → no bonus and passed=true', () => {
    const event = daysAgo(120, NOW); // daysOut = 90 - 120 = -30
    const info = auctionInfo(event, NOW);
    assert.equal(info.days_out, -30);
    assert.equal(info.bonus, 0);
    assert.equal(info.passed, true);
  });

  test('null event date → null', () => {
    assert.equal(auctionInfo(null, NOW), null);
  });
});

// ── scoreFor (full pipeline) ───────────────────────────────────────────────

describe('scoreFor', () => {
  test('single fresh signal: decay at age 0 equals base weight', () => {
    const r = scoreFor([{ type: 'tax_delinquent', date: NOW }], {}, NOW);
    // fresh (<=7 days) adds WEIGHTS.fresh
    assert.equal(r.score, WEIGHTS.tax_delinquent + WEIGHTS.fresh);
    assert.equal(r.breakdown.types.tax_delinquent.decayed, WEIGHTS.tax_delinquent);
    assert.equal(r.breakdown.types.tax_delinquent.live, true);
  });

  test('stack bonus counts only live types, not merely distinct types', () => {
    // code_violation aged well past its half-life stack of decay (half-life 120,
    // age 400 → 0.5^(400/120) ≈ 0.0992 < 0.25 → not live, but > 0 (not past 730 floor)
    const typeSignals = [
      { type: 'tax_delinquent', date: NOW },               // age 0 → live
      { type: 'code_violation', date: daysAgo(400, NOW) },  // decayed, not live
    ];
    const r = scoreFor(typeSignals, {}, NOW);
    assert.equal(r.liveCount, 1);
    assert.equal(r.breakdown.types.code_violation.live, false);

    const expectedCodeDecay = decayWeight(WEIGHTS.code_violation, 400, HALF_LIFE_DAYS.code_violation);
    const expectedScore = Math.round(
      WEIGHTS.tax_delinquent + expectedCodeDecay + WEIGHTS.fresh // tax_delinquent is the freshest (age 0)
    );
    assert.equal(r.score, expectedScore);
    // No +15 stack bonus since only 1 live type
  });

  test('two live types get the stack bonus', () => {
    const typeSignals = [
      { type: 'tax_delinquent', date: NOW },
      { type: 'code_violation', date: NOW },
    ];
    const r = scoreFor(typeSignals, {}, NOW);
    assert.equal(r.liveCount, 2);
    const expected = Math.round(
      WEIGHTS.tax_delinquent + WEIGHTS.code_violation + WEIGHTS.stack_bonus + WEIGHTS.fresh
    );
    assert.equal(r.score, expected);
  });

  test('trustee_sale 0-30 days out gets the +20 auction bonus', () => {
    const event = daysAgo(90 - 15, NOW); // 75 days old, 15 days out
    const r = scoreFor([{ type: 'trustee_sale', date: event }], {}, NOW);
    assert.equal(r.breakdown.auction.bonus, 20);
    assert.equal(r.breakdown.auction.passed, false);
    const decayed = decayWeight(WEIGHTS.trustee_sale, 75, HALF_LIFE_DAYS.trustee_sale);
    assert.equal(Math.round(decayed + 20), r.score);
  });

  test('trustee_sale 31-60 days out gets the +10 auction bonus', () => {
    const event = daysAgo(90 - 45, NOW); // 45 days old, 45 days out
    const r = scoreFor([{ type: 'trustee_sale', date: event }], {}, NOW);
    assert.equal(r.breakdown.auction.bonus, 10);
  });

  test('passed trustee_sale auction: weight x0.25, no bonus', () => {
    const event = daysAgo(120, NOW); // daysOut = -30, age = 120
    const r = scoreFor([{ type: 'trustee_sale', date: event }], {}, NOW);
    assert.equal(r.breakdown.auction.passed, true);
    assert.equal(r.breakdown.auction.bonus, 0);
    const rawDecayed = decayWeight(WEIGHTS.trustee_sale, 120, HALF_LIFE_DAYS.trustee_sale);
    assert.equal(r.breakdown.types.trustee_sale.decayed, rawDecayed * 0.25);
  });

  test('fresh at exactly 7 days adds the fresh bonus', () => {
    const r = scoreFor([{ type: 'tax_delinquent', date: daysAgo(7, NOW) }], {}, NOW);
    assert.equal(r.breakdown.fresh, true);
  });

  test('8 days old does not count as fresh', () => {
    const r = scoreFor([{ type: 'tax_delinquent', date: daysAgo(8, NOW) }], {}, NOW);
    assert.equal(r.breakdown.fresh, false);
  });

  test('freshness looks at the newest signal across all types', () => {
    const typeSignals = [
      { type: 'tax_delinquent', date: daysAgo(400, NOW) },
      { type: 'code_violation', date: daysAgo(3, NOW) },
    ];
    const r = scoreFor(typeSignals, {}, NOW);
    assert.equal(r.breakdown.fresh, true);
  });

  test('modifiers unchanged: absentee / high_equity / long_tenure add flat bonuses', () => {
    const r = scoreFor(
      [{ type: 'tax_delinquent', date: daysAgo(400, NOW) }], // not fresh, avoid noise
      { absentee: true, high_equity: true, long_tenure: true },
      NOW
    );
    const decayed = decayWeight(WEIGHTS.tax_delinquent, 400, HALF_LIFE_DAYS.tax_delinquent);
    const expected = Math.round(decayed + WEIGHTS.absentee + WEIGHTS.high_equity + WEIGHTS.long_tenure);
    assert.equal(r.score, expected);
  });

  test('hot: score >= 60 even with a single live type', () => {
    // trustee_sale fresh (age 0) = 50 + fresh 10 = 60
    const r = scoreFor([{ type: 'trustee_sale', date: NOW }], {}, NOW);
    assert.equal(r.score, 60);
    assert.equal(r.hot, true);
  });

  test('hot: >= 2 live types even if score < 60', () => {
    // two small, fresh types: lien(15) + mechanics_lien(15) + stack(15) + fresh(10) = 55 < 60
    const typeSignals = [
      { type: 'lien', date: NOW },
      { type: 'mechanics_lien', date: NOW },
    ];
    const r = scoreFor(typeSignals, {}, NOW);
    assert.ok(r.score < 60, `expected score < 60, got ${r.score}`);
    assert.equal(r.liveCount, 2);
    assert.equal(r.hot, true);
  });

  test('not hot: single decayed (non-live), low-score type', () => {
    const r = scoreFor([{ type: 'lien', date: daysAgo(400, NOW) }], {}, NOW);
    assert.equal(r.liveCount, 0);
    assert.ok(r.score < 60);
    assert.equal(r.hot, false);
  });

  test('empty signal list scores 0 and is not hot', () => {
    const r = scoreFor([], {}, NOW);
    assert.equal(r.score, 0);
    assert.equal(r.hot, false);
  });

  test('score is always an integer', () => {
    const r = scoreFor([{ type: 'tax_delinquent', date: daysAgo(37, NOW) }], {}, NOW);
    assert.equal(Number.isInteger(r.score), true);
  });
});

// ── scores table round-trip (breakdown column) ─────────────────────────────

describe('scores table round-trip', () => {
  const TEST_APN = 'test_score_9999999';

  test('can upsert a row with the new breakdown column', async () => {
    await query('ALTER TABLE scores ADD COLUMN IF NOT EXISTS breakdown JSONB');

    await query(
      `INSERT INTO properties (apn, situs_address, situs_city)
       VALUES ($1, 'Test St', 'Phoenix')
       ON CONFLICT (apn) DO NOTHING`,
      [TEST_APN]
    );

    const breakdown = {
      types: { tax_delinquent: { base: 20, age_days: 0, decayed: 20, live: true } },
      modifiers: {},
      auction: null,
      fresh: true,
    };

    await query(
      `INSERT INTO scores (apn, score, hot, signal_types, components, breakdown, updated_at)
       VALUES ($1, 30, false, ARRAY['tax_delinquent'], $2::jsonb, $3::jsonb, now())
       ON CONFLICT (apn) DO UPDATE SET score = EXCLUDED.score, hot = EXCLUDED.hot,
         signal_types = EXCLUDED.signal_types, components = EXCLUDED.components,
         breakdown = EXCLUDED.breakdown, updated_at = now()`,
      [
        TEST_APN,
        JSON.stringify({ types: ['tax_delinquent'], modifiers: {}, fresh: true }),
        JSON.stringify(breakdown),
      ]
    );

    const { rows } = await query('SELECT * FROM scores WHERE apn = $1', [TEST_APN]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].score), 30);
    assert.equal(rows[0].breakdown.types.tax_delinquent.live, true);
  });

  after(async () => {
    await query('DELETE FROM scores WHERE apn LIKE $1', ['test_%']);
    await query('DELETE FROM properties WHERE apn LIKE $1', ['test_%']);
    await pool.end();
  });
});
