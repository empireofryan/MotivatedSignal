# Motivated Sellers — Maricopa County Distressed-Seller Data Platform

**Date:** 2026-06-23
**Status:** Approved design (Phases 1–3 to be planned first)

## Problem & thesis

Real-estate wholesalers, hard-money lenders, and probate attorneys pay for lists of *motivated
sellers*. Incumbents (PropStream, etc.) cover assessor-derived signals well (absentee, high-equity,
long-tenure) but **lag or skip** the highest-motivation signals that live in messy county/city
portals and PDFs: **code violations, probate filings, and court records**. Freshness is the
product — the first wholesaler to call a distressed owner wins.

**Edge:** code-violation / probate / court sources PropStream lags or skips · **daily** refresh vs
weekly · small PDF-only sources nobody normalizes. By keeping a per-property signal history, the
dataset quietly becomes a Type-A accruing asset no competitor can backfill.

**First market:** Maricopa County, AZ (Phoenix metro) — huge investor market, mostly open records.

## Customers (3 segments)

| Segment | Wants | Primary signals |
|---|---|---|
| Wholesalers | Cheap deals, fast | code violations + tax-delinquent + absentee stacked = hot |
| Hard-money lenders | Distress + equity | NOTS (pre-foreclosure) + high equity |
| Probate attorneys | Marketing list of fresh estates | new probate filings (decedent estates) |

Acquisition channels (positioning, not v1 build): BiggerPockets, REIA groups, r/wholesaling, state
bar lists.

## Key research finding — mostly open data, three real scrapers

Most Maricopa data is **bulk download / open API**, not scraping. Only three sources need real
scrapers — and those three *are* the moat (the sources PropStream skips).

| Source | Signal | Access | Difficulty | Join key |
|---|---|---|---|---|
| **Assessor** (spine) | foundation: owner, addresses, sale, valuations | Free county **bulk CSV** + JSON API | Easy | `apn` (origin) |
| **Treasurer delinquent** | tax_delinquent | Open ArcGIS FeatureServer (`ParcelLienDelinquent`), ~167k parcels, ~84 paged calls | Easy | `apn` present |
| **Mesa code** | code_violation | Socrata API `data.mesaaz.gov/resource/hgf6-yenu.json` | Easy | parcel_number |
| **Glendale code** | code_violation | ArcGIS `GlendaleOne_Code_Compliance_Cases` (has lien date + officer-initiated flag) | Easy | join via addr/APN |
| **Tempe code** | code_violation | ArcGIS `code_complaints` | Easy | join |
| **Scottsdale code** | code_violation | ArcGIS Hub CSV (1-yr rolling, closed only) | Easy | join |
| **County (unincorporated) code** | code_violation | ArcGIS `Code_Case_Violations` (has APN; ~8mo stale — flag freshness) | Easy | apn |
| **Recorder NOTS** | trustee_sale | Free legacy index, doc code `NS` (exclude cancellations `CQ`) | **Medium scraper** — ASP.NET ViewState + postback pagination; no APN in index | resolve by owner/addr |
| **Court probate** | probate | Server-rendered docket; iterate `PB{year}-NNNNNN`, keep `Relationship=Decedent` | **Medium scraper** — no date filter, two-step, robots.txt disallows `/Docket/` (throttle ~1 rps) | resolve by decedent name |
| **Phoenix code** | code_violation | Accela SPA `aca-prod.accela.com/COHP`, 403s bots, no export | **Hard scraper** — headless Chrome | join via addr |

**Architectural consequence:** signal sources (except code data) carry **no owner name**, and
Recorder/Court carry **no APN**. Everything resolves back to the **Assessor spine on APN**, or by
fuzzy owner-name / address match for NOTS & probate. The Assessor data is both a source *and* the
resolution layer.

**Excluded:** Chandler code (records-request only — not programmatically accessible). Recorder PDFs
($300 account — avoid; free index + Assessor cross-ref is enough). Treasurer per-parcel dollar
amounts (Blazor SPA 403s; use the January CP-sale list for amounts instead of scraping 167k pages).

## Tech stack

- **Data store: CockroachDB** (`norbound-1` cluster, db `motivated_sellers`). Chosen over Supabase
  because the Assessor spine is ~1.7M parcels and signals accrue forever — well past Supabase's
  0.5 GB free tier, and the account is already at the 2-active-project limit. Cockroach = 10 GB
  free, no auto-pause, multi-DB per cluster. Access via `pg` (Node) + API routes (no browser writes).
- **Pipeline:** Node (ESM). API adapters use plain `fetch`; scraper adapters use **Playwright**
  (per scraping rules — JS-rendering, detail pages, JSON-LD/explicit selectors, never innerText).
- **Orchestration:** a **daily scheduled Claude Code routine** runs the pipeline (refresh → ingest →
  resolve → score → upsert). All LLM work (fuzzy name match, cross-city code-type normalization)
  uses the routine's own reasoning — **zero API spend**, inside the Max subscription. A Vercel cron
  can't run Playwright and would force paid API calls, so the routine is the right host.
- **Dashboard:** Next.js (App Router) + Vercel, reading CockroachDB via `pg` in API routes /
  server components. Login-gated.

## Data model (CockroachDB)

```
properties
  apn              TEXT PRIMARY KEY          -- Maricopa parcel number (normalized, no dashes)
  situs_address    TEXT
  situs_city       TEXT
  situs_zip        TEXT
  owner_name       TEXT
  owner_name_norm  TEXT                       -- normalized for matching (index)
  mailing_address  TEXT
  absentee         BOOL                       -- mailing != situs
  year_built       INT
  living_sqft      INT
  building_type    TEXT
  last_sale_date   DATE
  last_sale_price  NUMERIC
  assessed_value   NUMERIC
  legal_class      TEXT
  updated_at       TIMESTAMPTZ

signals
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
  apn           TEXT NULL REFERENCES properties(apn)   -- null until resolved
  signal_type   TEXT     -- code_violation | tax_delinquent | trustee_sale | probate
  source        TEXT     -- mesa_code | treasurer_delinquent | recorder_nots | court_probate | ...
  source_url    TEXT
  external_id   TEXT     -- case#, doc#, record id (dedupe key with source)
  observed_date DATE     -- when WE first saw it (freshness)
  event_date    DATE     -- the record's own date (filing/recording/violation date)
  status        TEXT     -- open | closed | cancelled (source-reported)
  owner_name    TEXT     -- for unresolved NOTS/probate matching
  situs_address TEXT     -- for unresolved matching
  resolved      BOOL DEFAULT false
  match_confidence TEXT  -- exact | probable | ambiguous | none  (for name-matched probate/NOTS)
  raw           JSONB    -- full source record, never discarded
  created_at    TIMESTAMPTZ DEFAULT now()
  UNIQUE (source, external_id)               -- idempotent upsert; history via re-observation log

scrape_runs
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
  source        TEXT
  started_at    TIMESTAMPTZ
  finished_at   TIMESTAMPTZ
  rows_found    INT
  rows_new      INT
  status        TEXT      -- ok | partial | error
  error         TEXT
  source_max_date DATE    -- freshness watermark (e.g. latest recording date seen)
```

**Accruing history:** signals are never deleted. `UNIQUE(source, external_id)` makes ingest
idempotent; status transitions (open→closed, NOTS→cancelled) are updated in place, with `raw`
preserving the full record. Per-property motivation history = all signals for an `apn` over time.

## Source adapter interface

```js
// every source is a module exporting:
export default {
  id: 'mesa_code',
  signalType: 'code_violation',     // or 'foundation' for assessor
  kind: 'api' | 'scraper',
  async fetch({ since }) {           // since = last source_max_date for incremental pulls
    // returns NormalizedRecord[]
  }
}

// NormalizedRecord:
{ apn?, externalId, sourceUrl, eventDate, status, ownerName?, situsAddress?, raw }
```

Adding a new source or county = write one adapter. This interface is the core of the "add messy
sources cheaply" thesis. A small runner (`run.js`) loops adapters → upsert signals → record
`scrape_runs`.

## Resolution & scoring (Phase 2 of next cycle, specced separately)

- **APN resolution** for NOTS/probate: normalize owner names (strip suffixes, LLC/trust handling),
  match against `properties.owner_name_norm`; address-normalize for NOTS. Tag `match_confidence`.
  **Probate ships v1 with `probable`/`ambiguous`-flagged matches** (decedent name → owned parcels;
  county redacts addresses, so name match is the only path) — confidence shown in UI, not hidden.
- **Motivation score:** weighted sum of active signals (stacking bonus: vacant/code + tax-delinquent
  + absentee = hot) + assessor modifiers (absentee, high equity = assessed ≫ last sale, long tenure).

## Skip-trace

Adapter interface with a disabled BatchData implementation behind `SKIPTRACE_ENABLED=false`.
v1 delivers ranked owner + mailing address; contact enrichment is flip-the-switch later
(~$0.07/record).

## Dashboard (next cycle)

Next.js + Vercel, login-gated. Three segment views (wholesaler / lender / probate attorney). Today's
ranked list per signal mix, filters (signal type, city, score, freshness), per-property signal
breakdown + history, CSV export.

## Build sequence

**This cycle — Phases 1–3 (get a populated Maricopa database to look at):**
1. **Schema + Assessor ingest** (spine + resolution layer).
2. **Open-API signals:** Treasurer delinquent + metro code (Mesa, Glendale, Tempe, Scottsdale,
   County unincorporated).
3. **Moat scrapers:** Recorder NOTS → Court probate → Phoenix code.

**Next cycle — Phases 4–6 (separate spec):**
4. APN resolution + motivation scoring.
5. Daily scheduled Claude Code routine (orchestration).
6. Dashboard (segment views, CSV export).

## Non-goals (v1)

- Counties beyond Maricopa (adapter interface makes #2 cheap, but not now).
- Live skip-tracing (stubbed).
- Billing / subscriber management (validate demand first).
- Recorder/Treasurer paid document PDFs.

## Rules baked in

- No paid Google APIs. No direct Anthropic/LLM API — all LLM work via Claude Code routine/subagents.
- Scraping uses Playwright (JS-rendering), detail pages, structured extraction — never innerText.
- CockroachDB over Supabase here (volume + active-project limit). Never pause/drop other projects.
