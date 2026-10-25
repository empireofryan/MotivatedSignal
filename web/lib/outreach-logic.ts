// Pure helpers for the automated cold-email sender (scripts/send-outreach.mjs). No imports on
// purpose: tests run this file directly under node's type stripping (web/tests/*.test.mjs).

export const HARD_DAILY_CAP = 20;
export const RAMP_START_N = 10;
export const RAMP_LATER_N = 15;
export const RAMP_DAYS = 5;
export const MAX_BOUNCE_RATE = 0.03;

export type BatchCandidate = {
  id: number;
  rank: number;
  segment: string | null;
  email: string | null;
  status: string;
  variant: string | null;
  inboxFlag: 'shared' | 'third-party' | null;
  matchTiers: Array<string | null>;
  alreadySent: boolean;
};

/** 0 = has a zip/city matched lead, 1 = lender with a named address, 2 = everyone else. */
export function selectionTier(c: Pick<BatchCandidate, 'segment' | 'matchTiers'>): 0 | 1 | 2 {
  if (c.matchTiers.some((t) => t === 'zip' || t === 'city')) return 0;
  if (c.segment === 'lender') return 1;
  return 2;
}

export function isEligible(c: BatchCandidate): boolean {
  return (
    c.status === 'new' &&
    Boolean(c.email) &&
    c.inboxFlag === null &&
    c.segment !== 'community_leader' &&
    Boolean(c.variant) &&
    !c.alreadySent
  );
}

/** Filters to eligible prospects, orders by tier then rank (then id), returns the first n. */
export function selectBatch(candidates: BatchCandidate[], n: number): BatchCandidate[] {
  return candidates
    .filter(isEligible)
    .sort((a, b) => selectionTier(a) - selectionTier(b) || a.rank - b.rank || a.id - b.id)
    .slice(0, Math.max(0, n));
}

/** Daily target: override (clamped to 1..cap) if given, else 10 for the first 5 send days, then 15. */
export function rampN(sendDays: number, override?: number | null): number {
  if (override !== undefined && override !== null && Number.isFinite(override) && override > 0) {
    return Math.min(Math.floor(override), HARD_DAILY_CAP);
  }
  return sendDays < RAMP_DAYS ? RAMP_START_N : RAMP_LATER_N;
}

/** How many to send now: the target minus what already went out today (unless overridden), never
 * past the hard daily cap. */
export function remainingToSend(target: number, sentToday: number, hasOverride: boolean): number {
  const byTarget = hasOverride ? target : target - sentToday;
  return Math.max(0, Math.min(byTarget, HARD_DAILY_CAP - sentToday));
}

export type StopInput = {
  stopsSincePrevSendDay: number;
  bouncesSincePrevSendDay: number;
  sentTotal: number;
  bouncedTotal: number;
};

export function evaluateStop(i: StopInput): { halt: boolean; reason: string | null } {
  if (i.stopsSincePrevSendDay > 0) {
    return { halt: true, reason: `${i.stopsSincePrevSendDay} stop event(s) since the previous send day` };
  }
  if (i.bouncesSincePrevSendDay > 0) {
    return { halt: true, reason: `${i.bouncesSincePrevSendDay} bounce(s) since the previous send day` };
  }
  if (i.sentTotal > 0 && i.bouncedTotal / i.sentTotal > MAX_BOUNCE_RATE) {
    const pct = ((i.bouncedTotal / i.sentTotal) * 100).toFixed(1);
    return { halt: true, reason: `bounce rate ${pct}% exceeds ${MAX_BOUNCE_RATE * 100}%` };
  }
  return { halt: false, reason: null };
}

/** America/Phoenix is a fixed UTC-7 (no DST). */
export function phoenixDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(date);
}

export function phoenixDayBoundsUtc(date: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(`${phoenixDateString(date)}T00:00:00-07:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
