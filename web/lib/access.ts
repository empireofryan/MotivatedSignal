import crypto from 'node:crypto';
import type { Client } from '@libsql/client';
import type { NextResponse } from 'next/server';
import { turso } from './turso';

// Pro/trial access control for /report and /api/report/export.
//
// Three things can grant access, all checked fresh on every request (no single shared secret
// anyone can leak or re-share):
//
//  1. A signed "customer" token in the `ms_pro` cookie, issued by /api/pro?key=<customer key>
//     after a Stripe checkout (see web/app/api/admin/grant/route.ts and
//     web/scripts/grant-pro.mjs for how a key gets created). The token only carries the
//     customer id — status (active/canceled/past_due) is looked up in Turso `customers` on
//     every request (60s in-process cache), so canceling in Stripe revokes access without the
//     visitor doing anything, and a leaked key only works for that one customer.
//  2. A signed "trial" token in the `ms_trial` cookie, issued by /r/<code> or /api/trial. It
//     carries the trial id + ends_at, both covered by the HMAC, so it needs no DB round trip to
//     check — and no one but the server can mint one that extends it. One trial per prospect
//     (or per anonymous `vid`), ever: see `startOrReuseTrial`.
//  3. A 7-day-only backward-compat path for the OLD shared `PRO_KEY` cookie value (the literal
//     key, not a signed token) — see LEGACY_PRO_KEY_CUTOFF below. Delete this whole branch,
//     `setLegacyProCookie`, and the cutoff constant once the cutoff passes.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Phoenix (America/Phoenix) never observes DST, so it's UTC-7 year round:
// 2026-10-12T00:00:00-07:00 == 2026-10-12T07:00:00Z. 7 days from the day this feature shipped
// (2026-10-05). After this, the old shared PRO_KEY cookie value stops granting access — only
// per-customer keys from `customers.key` work.
export const LEGACY_PRO_KEY_CUTOFF = new Date('2026-10-12T07:00:00Z');

export const PRO_COOKIE = 'ms_pro';
export const TRIAL_COOKIE = 'ms_trial';
export const TRIAL_UNTIL_COOKIE = 'ms_trial_until';

// ---- schema ----

let schemaReady: Promise<void> | null = null;

/** Idempotent. Creates `trials` and `customers` if they don't exist yet. */
export function ensureAccessSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS trials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER,
          vid TEXT,
          started_at TEXT DEFAULT (datetime('now')),
          ends_at TEXT NOT NULL,
          source TEXT
        )
      `);
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trials_prospect ON trials(prospect_id)');
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trials_vid ON trials(vid)');

      await db.execute(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          name TEXT,
          key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute('CREATE INDEX IF NOT EXISTS idx_customers_stripe_customer ON customers(stripe_customer_id)');
      await db.execute('CREATE INDEX IF NOT EXISTS idx_customers_stripe_sub ON customers(stripe_subscription_id)');
    })();
  }
  return schemaReady;
}

// ---- signing ----

function secret(): string {
  return process.env.TRACK_SECRET || process.env.ADMIN_KEY || 'motivatedsignal-track-fallback';
}

function hmac(input: string): string {
  return crypto.createHmac('sha256', secret()).update(input).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function randomVid(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** 32 hex chars, per-customer Pro access key (spec: `key text unique (32 hex)`). */
export function randomCustomerKey(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---- customer (Pro) token: `<id>.<hmac>` ----

export function signCustomerToken(customerId: number): string {
  return `${customerId}.${hmac(`c.${customerId}`)}`;
}

export function verifyCustomerToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const idPart = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(idPart)) return null;
  if (!timingSafeHexEqual(mac, hmac(`c.${idPart}`))) return null;
  return Number(idPart);
}

// ---- trial token: `<id>.<endsAtMs>.<hmac>` ----

export function signTrialToken(trialId: number, endsAt: Date): string {
  const payload = `${trialId}.${endsAt.getTime()}`;
  return `${payload}.${hmac(`t.${payload}`)}`;
}

export function verifyTrialToken(token: string | undefined | null): { trialId: number; endsAt: Date } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idPart, endsPart, mac] = parts;
  if (!/^\d+$/.test(idPart) || !/^\d+$/.test(endsPart)) return null;
  if (!timingSafeHexEqual(mac, hmac(`t.${idPart}.${endsPart}`))) return null;
  return { trialId: Number(idPart), endsAt: new Date(Number(endsPart)) };
}

// ---- trials: one per prospect (or per anonymous vid), ever ----

export type TrialLookup = { trialId: number; endsAt: Date; isNew: boolean };

/** Finds the prospect's (or vid's) existing trial row and returns it unchanged — a trial is
 * never extended by re-clicking. Only creates a new 7-day trial row when none exists yet. */
export async function startOrReuseTrial(
  db: Client,
  opts: { prospectId?: number | null; vid?: string | null; source: string }
): Promise<TrialLookup> {
  await ensureAccessSchema(db);
  const prospectId = opts.prospectId ?? null;
  const vid = prospectId == null ? opts.vid ?? null : null;

  if (prospectId != null) {
    const existing = await db.execute({
      sql: 'SELECT id, ends_at FROM trials WHERE prospect_id = ? ORDER BY id ASC LIMIT 1',
      args: [prospectId],
    });
    if (existing.rows.length > 0) {
      return {
        trialId: Number(existing.rows[0].id),
        endsAt: new Date(String(existing.rows[0].ends_at)),
        isNew: false,
      };
    }
  } else if (vid != null) {
    const existing = await db.execute({
      sql: 'SELECT id, ends_at FROM trials WHERE vid = ? ORDER BY id ASC LIMIT 1',
      args: [vid],
    });
    if (existing.rows.length > 0) {
      return {
        trialId: Number(existing.rows[0].id),
        endsAt: new Date(String(existing.rows[0].ends_at)),
        isNew: false,
      };
    }
  }

  const endsAt = new Date(Date.now() + SEVEN_DAYS_MS);
  const res = await db.execute({
    sql: 'INSERT INTO trials (prospect_id, vid, ends_at, source) VALUES (?, ?, ?, ?)',
    args: [prospectId, vid, endsAt.toISOString(), opts.source],
  });
  return { trialId: Number(res.lastInsertRowid), endsAt, isNew: true };
}

// ---- cookie helpers ----

/** Cookie persists for 30 days regardless of the 7-day trial length, so a return visit after the
 * trial ends still carries the (now-expired) signed token — that's how the report page knows to
 * show "your trial ended <date>" instead of just silently gating. */
export function setTrialCookies(res: NextResponse, trial: TrialLookup): void {
  res.cookies.set(TRIAL_COOKIE, signTrialToken(trial.trialId, trial.endsAt), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS_SECONDS,
  });
  res.cookies.set(TRIAL_UNTIL_COOKIE, trial.endsAt.toISOString(), {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS_SECONDS,
  });
}

export function setProCookie(res: NextResponse, customerId: number): void {
  res.cookies.set(PRO_COOKIE, signCustomerToken(customerId), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}

/** Only for the pre-cutoff legacy shared-PRO_KEY path — see LEGACY_PRO_KEY_CUTOFF. */
export function setLegacyProCookie(res: NextResponse, rawKey: string): void {
  res.cookies.set(PRO_COOKIE, rawKey, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}

// ---- customer status lookup, 60s cache ----

type StatusCacheEntry = { status: string; expiresAtMs: number };
const customerStatusCache = new Map<number, StatusCacheEntry>();
const CUSTOMER_CACHE_TTL_MS = 60_000;

async function getCustomerStatus(db: Client, customerId: number): Promise<string | null> {
  const cached = customerStatusCache.get(customerId);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return cached.status;
  const res = await db.execute({ sql: 'SELECT status FROM customers WHERE id = ?', args: [customerId] });
  const status = (res.rows[0]?.status as string | undefined) ?? null;
  if (status != null) {
    customerStatusCache.set(customerId, { status, expiresAtMs: now + CUSTOMER_CACHE_TTL_MS });
  } else {
    customerStatusCache.delete(customerId);
  }
  return status;
}

// ---- the actual access check ----

export type AccessState = {
  /** True for an active paying customer OR an active trial. Gate on this, same as the old
   * `isProAccess()`. */
  isPro: boolean;
  isTrialActive: boolean;
  /** A trial cookie exists but its ends_at has passed. */
  trialEnded: boolean;
  /** ISO date, set whenever a trial cookie (active or ended) is present. */
  trialUntil: string | null;
  customerId: number | null;
};

export async function getAccessState(opts: {
  proCookie: string | undefined | null;
  trialCookie: string | undefined | null;
}): Promise<AccessState> {
  let isPro = false;
  let customerId: number | null = null;

  const custId = verifyCustomerToken(opts.proCookie);
  if (custId != null) {
    const status = await getCustomerStatus(turso(), custId);
    if (status === 'active') {
      isPro = true;
      customerId = custId;
    }
  } else if (opts.proCookie && process.env.PRO_KEY && opts.proCookie === process.env.PRO_KEY) {
    if (Date.now() < LEGACY_PRO_KEY_CUTOFF.getTime()) {
      console.warn(
        `[access] legacy shared PRO_KEY cookie used — this stops working ${LEGACY_PRO_KEY_CUTOFF.toISOString()}`
      );
      isPro = true;
    }
  }

  let isTrialActive = false;
  let trialEnded = false;
  let trialUntil: string | null = null;
  const trial = verifyTrialToken(opts.trialCookie);
  if (trial) {
    trialUntil = trial.endsAt.toISOString();
    if (trial.endsAt.getTime() > Date.now()) isTrialActive = true;
    else trialEnded = true;
  }

  return { isPro: isPro || isTrialActive, isTrialActive, trialEnded, trialUntil, customerId };
}
