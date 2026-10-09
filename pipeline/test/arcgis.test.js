// pipeline/test/arcgis.test.js
// Unit tests for fetchArcgisAll — no network calls; fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArcgisAll } from '../src/arcgis.js';

function makePage(features, exceededTransferLimit) {
  return { features, exceededTransferLimit };
}

test('fetchArcgisAll concatenates two pages and stops when exceededTransferLimit is not true', async () => {
  const page1Features = Array.from({ length: 5 }, (_, i) => ({ attributes: { OBJECTID: i + 1 } }));
  const page2Features = Array.from({ length: 3 }, (_, i) => ({ attributes: { OBJECTID: i + 6 } }));

  const responses = [
    makePage(page1Features, true),   // first page: server says there is more
    makePage(page2Features, false),  // second page: no more data
  ];
  let callCount = 0;

  // Stub global fetch for this test
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const resp = responses[callCount++];
    if (!resp) throw new Error('fetchArcgisAll made unexpected extra request');
    return {
      ok: true,
      json: async () => resp,
    };
  };

  try {
    const features = await fetchArcgisAll('https://example.com/layer/0', { pageSize: 5 });
    assert.equal(features.length, 8, 'should return all 8 features from both pages');
    assert.equal(callCount, 2, 'should have made exactly 2 requests');
    // Second call offset should have advanced by actual features returned (5), not pageSize
    // (they happen to match here, but the loop logic is what matters — verified by the count)
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll stops immediately when server returns empty batch', async () => {
  let callCount = 0;
  const origFetch = global.fetch;
  global.fetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({ features: [], exceededTransferLimit: true }),
    };
  };
  try {
    const features = await fetchArcgisAll('https://example.com/layer/0');
    assert.equal(features.length, 0);
    assert.equal(callCount, 1);
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll throws on HTTP error (retries disabled)', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    // retries: 0 — a persistent 500 is retryable by default (see retry.js),
    // so disable retries here to test the "gives up and throws" path without
    // waiting through real backoff delays. Retry behavior itself is covered
    // in retry.test.js.
    await assert.rejects(
      () => fetchArcgisAll('https://example.com/layer/0', { retries: 0 }),
      /ArcGIS 500/,
    );
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll retries a transient HTTP 503 then succeeds', async () => {
  const origFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ features: [{ attributes: { OBJECTID: 1 } }], exceededTransferLimit: false }) };
  };
  try {
    // tiny delays so the test doesn't wait out real backoff
    const features = await fetchArcgisAll('https://example.com/layer/0', {
      retries: 2, baseDelayMs: 1, maxDelayMs: 2, pageSize: 10,
    });
    assert.equal(features.length, 1);
    assert.equal(callCount, 2, 'first call 503s, second call (the retry) succeeds');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll gives up after exhausting retries on a persistent 503', async () => {
  const origFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount++; return { ok: false, status: 503 }; };
  try {
    await assert.rejects(
      () => fetchArcgisAll('https://example.com/layer/0', { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }),
      /ArcGIS 503/,
    );
    assert.equal(callCount, 3, '1 initial attempt + 2 retries');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll throws on ArcGIS JSON error object', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ error: { code: 400, message: 'Invalid query' } }),
  });
  try {
    await assert.rejects(
      () => fetchArcgisAll('https://example.com/layer/0'),
      /ArcGIS error/,
    );
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll advances offset by actual batch size not pageSize when server caps records', async () => {
  // Simulates a server that caps at 3 even though we requested 10 (like Scottsdale capping at 1000)
  const page1 = Array.from({ length: 3 }, (_, i) => ({ attributes: { OBJECTID: i + 1 } }));
  const page2 = Array.from({ length: 2 }, (_, i) => ({ attributes: { OBJECTID: i + 4 } }));
  const responses = [
    makePage(page1, true),
    makePage(page2, false),
  ];
  let callCount = 0;
  const capturedOffsets = [];

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const urlObj = new URL(url);
    capturedOffsets.push(Number(urlObj.searchParams.get('resultOffset')));
    return {
      ok: true,
      json: async () => responses[callCount++],
    };
  };
  try {
    const features = await fetchArcgisAll('https://example.com/layer/0', { pageSize: 10 });
    assert.equal(features.length, 5);
    assert.equal(capturedOffsets[0], 0, 'first request offset is 0');
    assert.equal(capturedOffsets[1], 3, 'second request offset advances by actual batch size (3), not pageSize (10)');
  } finally {
    global.fetch = origFetch;
  }
});

test('fetchArcgisAll falls back to no orderBy when server rejects OBJECTID ordering', async () => {
  // Simulates a server (like Scottsdale) that returns a JSON error for orderByFields=OBJECTID
  // but works fine without it.
  const page1 = [{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }];
  let callCount = 0;
  const capturedUrls = [];

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    capturedUrls.push(url);
    callCount++;
    if (url.includes('orderByFields')) {
      // First call with orderByFields — return an error
      return { ok: true, json: async () => ({ error: { code: 400, message: 'Invalid or missing input parameters.' } }) };
    }
    // Retry without orderByFields — succeed
    return { ok: true, json: async () => ({ features: page1, exceededTransferLimit: false }) };
  };
  try {
    const features = await fetchArcgisAll('https://example.com/layer/0');
    assert.equal(features.length, 2, 'should return features after fallback');
    assert.equal(callCount, 2, 'should have made exactly 2 requests (error + retry)');
    assert.ok(capturedUrls[0].includes('orderByFields'), 'first request should include orderByFields');
    assert.ok(!capturedUrls[1].includes('orderByFields'), 'retry should not include orderByFields');
  } finally {
    global.fetch = origFetch;
  }
});
