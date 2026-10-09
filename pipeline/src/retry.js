/**
 * Shared retry-with-backoff helper for transient failures (network blips,
 * DB connection drops, 5xx/429 responses).
 *
 * Why this exists: the daily run lives on a laptop that frequently Power-Naps
 * mid-run (confirmed via `pmset -g log` — multiple Sleep/DarkWake cycles in
 * the first ~20 minutes after the 7am launchd start). macOS fully suspends
 * the Node process during real sleep, including in-flight sockets. On wake,
 * an in-flight fetch's AbortSignal.timeout deadline (set before sleep) has
 * often already passed in wall-clock time, so it fires immediately —
 * "TimeoutError: The operation was aborted due to timeout" — even though a
 * fresh request immediately afterward succeeds in well under a second
 * (verified: ArcGIS/Socrata bulk pages are ~0.5-1.2s each; see pipeline
 * CLAUDE.md / investigation notes). The CockroachDB pool sees the same thing
 * as "Connection terminated unexpectedly". None of this is a slow server —
 * it's a suspended process — so the fix is "retry the same (resumable) page
 * or write", not "raise the timeout".
 */

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const RETRYABLE_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
]);

/** Default retry predicate: network/timeout/DB-connection blips and 429/5xx. */
export function isRetryableError(err) {
  if (!err) return false;
  if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  if (RETRYABLE_ERROR_CODES.has(err.code)) return true;
  // undici wraps connection-level failures as "TypeError: fetch failed" with a .cause
  if (err instanceof TypeError && /fetch failed/i.test(err.message ?? '')) return true;
  if (/connection terminated unexpectedly/i.test(err.message ?? '')) return true;
  if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) return true;
  return false;
}

/**
 * Run `fn`, retrying with capped exponential backoff when it throws an error
 * `isRetryable` accepts. Each attempt is independent — safe for anything
 * idempotent/resumable (a paginated page fetch, an upsert by unique key).
 */
export async function withRetry(fn, {
  retries = 6,
  baseDelayMs = 5_000,
  maxDelayMs = 90_000,
  isRetryable = isRetryableError,
  onRetry,
} = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      if (attempt > retries || !isRetryable(e)) throw e;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      onRetry?.({ attempt, retries, delay, error: e });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
