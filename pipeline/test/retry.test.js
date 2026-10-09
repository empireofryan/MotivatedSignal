// pipeline/test/retry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isRetryableError, HttpError } from '../src/retry.js';

test('isRetryableError recognizes timeout/abort errors', () => {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  assert.equal(isRetryableError(e), true);
});

test('isRetryableError recognizes undici "fetch failed" TypeError', () => {
  const e = new TypeError('fetch failed');
  assert.equal(isRetryableError(e), true);
});

test('isRetryableError recognizes pg "Connection terminated unexpectedly"', () => {
  assert.equal(isRetryableError(new Error('Connection terminated unexpectedly')), true);
});

test('isRetryableError recognizes common connection error codes', () => {
  const e = new Error('read ECONNRESET');
  e.code = 'ECONNRESET';
  assert.equal(isRetryableError(e), true);
  const dns = new Error('getaddrinfo ENOTFOUND host');
  dns.code = 'ENOTFOUND';
  assert.equal(isRetryableError(dns), true);
});

test('isRetryableError treats HttpError 429/5xx as retryable, 4xx as not', () => {
  assert.equal(isRetryableError(new HttpError('x', 429)), true);
  assert.equal(isRetryableError(new HttpError('x', 503)), true);
  assert.equal(isRetryableError(new HttpError('x', 404)), false);
  assert.equal(isRetryableError(new HttpError('x', 400)), false);
});

test('isRetryableError rejects unrelated errors', () => {
  assert.equal(isRetryableError(new Error('Invalid query')), false);
  assert.equal(isRetryableError(new TypeError('x is not a function')), false);
});

test('withRetry returns the first successful result without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries retryable errors then succeeds, with backoff delays', async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) { const e = new Error('fetch failed'); throw new TypeError(e.message); }
      return 'ok';
    },
    { retries: 5, baseDelayMs: 1, maxDelayMs: 4, onRetry: ({ delay }) => delays.push(delay) }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.equal(delays.length, 2, 'one onRetry call per failed attempt');
});

test('withRetry gives up and rethrows after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new HttpError('boom', 503); }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    /boom/
  );
  assert.equal(calls, 3, '1 initial attempt + 2 retries');
});

test('withRetry does not retry a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('Invalid query'); }, { retries: 5, baseDelayMs: 1 }),
    /Invalid query/
  );
  assert.equal(calls, 1, 'should not retry a non-retryable error');
});

test('withRetry respects a custom isRetryable predicate', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => { calls++; if (calls < 2) throw new Error('custom-transient'); return 'ok'; },
    { retries: 3, baseDelayMs: 1, isRetryable: (e) => e.message === 'custom-transient' }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});
