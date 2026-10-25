// Pure helpers for send-outreach.mjs (unit tested in scripts/test/).

const ABORT_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'ETLS']);

/** 'bounce' = permanent per-recipient failure (5xx other than auth); 'abort' = auth/connection/
 * temporary trouble that says nothing about the recipient, so stop the whole batch. */
export function classifySmtpError(err) {
  const code = err && err.code;
  const rc = Number(err && err.responseCode);
  if (code && ABORT_CODES.has(code)) return 'abort';
  if (rc === 530 || rc === 534 || rc === 535 || rc === 538) return 'abort'; // auth / TLS required
  if (rc >= 500 && rc < 600) return 'bounce';
  return 'abort';
}

export function randomDelayMs(minSec = 45, maxSec = 120, rand = Math.random) {
  return Math.round((minSec + rand() * (maxSec - minSec)) * 1000);
}

export function domainOf(email) {
  const at = String(email).lastIndexOf('@');
  return at === -1 ? 'unknown' : String(email).slice(at + 1).toLowerCase();
}

export function isTruthy(v) {
  return /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
}

/** Per-run override from SEND_N: a positive integer, else null (use the server-side ramp). */
export function parseSendN(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export const MAX_CONSECUTIVE_BOUNCES = 3;
