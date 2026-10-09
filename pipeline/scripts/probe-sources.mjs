// pipeline/scripts/probe-sources.mjs
//
// Diagnostic probe for the "0 results in GitHub Actions, real results on laptop"
// problem affecting the recorder adapters (recorder_nots / recorder_liens) and
// phoenix_code. Hits the same URLs the real adapters hit, once with a plain
// `fetch` and once with Playwright chromium headless (as recorder_common.js
// does), and prints enough signal (status, headers, title, body sample, row
// counts) to tell a block page / empty result / JS challenge / cookie
// requirement apart.
//
// Usage: node scripts/probe-sources.mjs
// No DB/env vars required — this never touches the database.

import { parse } from 'node-html-parser';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const DUMP_DIR = process.env.PROBE_DUMP_DIR || null;
let dumpCounter = 0;
function dumpHtml(label, html) {
  if (!DUMP_DIR || !html) return;
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  dumpCounter++;
  const safe = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
  const file = path.join(DUMP_DIR, `${String(dumpCounter).padStart(2, '0')}_${safe}.html`);
  fs.writeFileSync(file, html);
  console.log('dumped full HTML to', file);
}

const RECORDER_BASE = 'https://legacy.recorder.maricopa.gov/recdocdata/';
const RECORDER_LIST_PAGE = `${RECORDER_BASE}GetRecDataRecentPgDn.aspx`;
const HEADER_OF_INTEREST = [
  'server',
  'cf-ray',
  'cf-cache-status',
  'cf-mitigated',
  'x-akamai-transformed',
  'akamai-grn',
  'x-cache',
  'x-frame-options',
  'content-type',
  'location',
];

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// ── helpers ──────────────────────────────────────────────────────────────────

function toRecorderDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function buildRecorderListUrl(code, days = 14) {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);
  const bdt = toRecorderDate(startDate);
  const edt = toRecorderDate(endDate);
  return (
    `${RECORDER_LIST_PAGE}?rec=0&suf=&nm=` +
    `&bdt=${encodeURIComponent(bdt)}&edt=${encodeURIComponent(edt)}` +
    `&cde=${code}&max=250&res=True&doc1=${code}&doc2=&doc3=&doc4=&doc5=`
  );
}

function headersOfInterest(headers) {
  const out = {};
  for (const h of HEADER_OF_INTEREST) {
    const v = headers.get ? headers.get(h) : headers[h];
    if (v) out[h] = v;
  }
  // set-cookie NAMES only (never values)
  const setCookie = headers.getSetCookie ? headers.getSetCookie() : headers['set-cookie'];
  if (setCookie && setCookie.length) {
    const names = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((c) => c.split('=')[0].trim());
    out['set-cookie-names'] = names;
  }
  return out;
}

function visibleTextSample(html, n = 800) {
  const root = parse(html);
  const text = root.text.replace(/\s+/g, ' ').trim();
  return text.slice(0, n);
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : '(no <title>)';
}

function recorderRowCount(html) {
  const root = parse(html);
  const table = root.querySelector('table#ctl00_ContentPlaceHolder1_Grid1');
  if (!table) return { tableFound: false, tbodyTrRowCount: 0, rawRecLinkCount: 0 };
  // NOTE: the real adapter's parseListPage() selects `tbody tr` — which only
  // matches when the DOM has a <tbody>. Browsers (and Playwright's
  // page.content(), which serializes the live DOM) auto-insert <tbody> around
  // bare <tr>s per the HTML5 tree-construction algorithm; node-html-parser
  // parsing a RAW (plain-fetch) response does NOT, since the server's HTML
  // has no literal <tbody> tag. So `tbodyTrRowCount` can legitimately be 0 on
  // a plain-fetch probe even when the page has real data — `rawRecLinkCount`
  // (links matching the recording-number detail href, tbody-agnostic) is the
  // true signal for "did this response actually contain rows".
  const tbodyTrRowCount = table.querySelectorAll('tbody tr').length;
  const rawRecLinks = table.querySelectorAll('a').filter((a) => /rec=\d+/.test(a.getAttribute('href') || ''));
  return { tableFound: true, tbodyTrRowCount, rawRecLinkCount: rawRecLinks.length };
}

function phoenixFieldCount(html, caseNumber) {
  const hasHeading = html.includes(`Case Details - ${caseNumber}`);
  const root = parse(html);
  const strongCount = root.querySelectorAll('strong').length;
  return { hasHeading, strongCount };
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// ── plain fetch probe ────────────────────────────────────────────────────────

async function probePlainFetch(label, url, { realisticHeaders = false } = {}) {
  section(`[plain fetch] ${label}\nURL: ${url}`);
  try {
    const headers = realisticHeaders
      ? {
          'User-Agent': CHROME_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: RECORDER_BASE,
        }
      : {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        };
    const res = await fetch(url, { headers, redirect: 'follow' });
    const html = await res.text();
    console.log('status:', res.status, res.statusText);
    console.log('final url:', res.url);
    console.log('headers of interest:', JSON.stringify(headersOfInterest(res.headers)));
    console.log('title:', titleOf(html));
    console.log('body length:', html.length);
    console.log('visible text sample:', visibleTextSample(html));
    dumpHtml(`plain_${label}`, html);
    return html;
  } catch (e) {
    console.log('ERROR:', e.message);
    return null;
  }
}

// ── playwright probe ─────────────────────────────────────────────────────────

async function probePlaywright(label, url, { visitLandingFirst = false, extraArgs = [] } = {}) {
  section(`[playwright chromium headless] ${label}\nURL: ${url}${visitLandingFirst ? ' (landing page visited first)' : ''}`);
  const browser = await chromium.launch({ headless: true, args: extraArgs });
  const context = await browser.newContext({
    userAgent: CHROME_UA,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();
  let statusOfInterest = null;
  page.on('response', (resp) => {
    if (resp.url() === url) statusOfInterest = resp.status();
  });
  try {
    if (visitLandingFirst) {
      await page.goto(RECORDER_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1000);
    }
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    console.log('status:', resp ? resp.status() : statusOfInterest ?? '(unknown)');
    console.log('final url:', page.url());
    if (resp) console.log('headers of interest:', JSON.stringify(headersOfInterest(resp.headers())));
    console.log('title (document.title):', await page.title());
    console.log('body length:', html.length);
    console.log('visible text sample:', visibleTextSample(html));
    dumpHtml(`pw_${label}`, html);
    return html;
  } catch (e) {
    console.log('ERROR:', e.message);
    return null;
  } finally {
    await browser.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  section('Egress IP');
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    console.log(await res.json());
  } catch (e) {
    console.log('ERROR fetching egress IP:', e.message);
  }

  const mitigation = process.env.PROBE_MITIGATION || 'none';
  console.log(`\nMitigation mode: ${mitigation}`);

  const nsUrl = buildRecorderListUrl('NS', 14);
  const mlUrl = buildRecorderListUrl('ML', 14);
  // Known-good Phoenix code-enforcement case (confirmed to exist in our DB).
  const phoenixCaseNumber = process.env.PROBE_PHOENIX_CASE || 'PEF2026-19777';
  const phoenixUrl = `https://nsdonline.phoenix.gov/CodeEnforcement/Details?caseNum=${encodeURIComponent(phoenixCaseNumber)}`;

  const realisticHeaders = mitigation !== 'none';
  const visitLandingFirst = mitigation === 'landing-cookie' || mitigation === 'landing-cookie+stealth' || mitigation === 'landing-cookie+pacing';
  const stealthArgs = mitigation === 'stealth' || mitigation === 'landing-cookie+stealth' ? ['--disable-blink-features=AutomationControlled'] : [];
  const pacingMs = mitigation === 'pacing' || mitigation === 'landing-cookie+pacing' ? 2500 : 0;

  // ── Recorder NS ──
  const nsPlainHtml = await probePlainFetch('recorder NS (14-day window)', nsUrl, { realisticHeaders });
  if (nsPlainHtml) console.log('recorder row/link counts (plain):', JSON.stringify(recorderRowCount(nsPlainHtml)));
  if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));

  const nsPwHtml = await probePlaywright('recorder NS (14-day window)', nsUrl, { visitLandingFirst, extraArgs: stealthArgs });
  if (nsPwHtml) console.log('recorder row/link counts (playwright):', JSON.stringify(recorderRowCount(nsPwHtml)));
  if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));

  // ── Recorder ML ──
  const mlPlainHtml = await probePlainFetch('recorder ML (14-day window)', mlUrl, { realisticHeaders });
  if (mlPlainHtml) console.log('recorder row/link counts (plain):', JSON.stringify(recorderRowCount(mlPlainHtml)));
  if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));

  const mlPwHtml = await probePlaywright('recorder ML (14-day window)', mlUrl, { visitLandingFirst, extraArgs: stealthArgs });
  if (mlPwHtml) console.log('recorder row/link counts (playwright):', JSON.stringify(recorderRowCount(mlPwHtml)));
  if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));

  // ── Phoenix code detail ──
  const phxPlainHtml = await probePlainFetch(`phoenix_code detail (${phoenixCaseNumber})`, phoenixUrl, { realisticHeaders });
  if (phxPlainHtml) console.log('phoenix field check (plain):', JSON.stringify(phoenixFieldCount(phxPlainHtml, phoenixCaseNumber)));
  if (pacingMs) await new Promise((r) => setTimeout(r, pacingMs));

  const phxPwHtml = await probePlaywright(`phoenix_code detail (${phoenixCaseNumber})`, phoenixUrl, { visitLandingFirst: false, extraArgs: stealthArgs });
  if (phxPwHtml) console.log('phoenix field check (playwright):', JSON.stringify(phoenixFieldCount(phxPwHtml, phoenixCaseNumber)));

  section('Probe complete');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
