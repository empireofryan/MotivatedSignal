-- pipeline/src/schema.sql
CREATE TABLE IF NOT EXISTS properties (
  apn             STRING PRIMARY KEY,
  situs_address   STRING,
  situs_city      STRING,
  situs_zip       STRING,
  owner_name      STRING,
  owner_name_norm STRING,
  owner_name_sorted STRING,
  mailing_address STRING,
  absentee        BOOL,
  year_built      INT,
  living_sqft     INT,
  building_type   STRING,
  last_sale_date  DATE,
  last_sale_price DECIMAL,
  assessed_value  DECIMAL,
  legal_class     STRING,
  situs_norm      STRING,
  updated_at      TIMESTAMPTZ DEFAULT now()
);
-- Add columns to existing tables (idempotent for live DBs where CREATE TABLE IF NOT EXISTS is a no-op)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_name_sorted STRING;

CREATE INDEX IF NOT EXISTS idx_properties_owner_norm ON properties (owner_name_norm);
CREATE INDEX IF NOT EXISTS idx_properties_owner_name_sorted ON properties (owner_name_sorted);
CREATE INDEX IF NOT EXISTS idx_properties_situs_norm ON properties (situs_norm);

CREATE TABLE IF NOT EXISTS signals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apn              STRING NULL,
  signal_type      STRING NOT NULL,
  source           STRING NOT NULL,
  source_url       STRING,
  external_id      STRING NOT NULL,
  observed_date    DATE DEFAULT current_date(),
  event_date       DATE,
  status           STRING,
  owner_name       STRING,
  situs_address    STRING,
  resolved         BOOL DEFAULT false,
  match_confidence STRING,
  raw              JSONB,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_apn ON signals (apn);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals (signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_unresolved ON signals (resolved) WHERE resolved = false;
-- Report perf (2026-10-03): the report's `fresh` CTE filters on created_at (the
-- "New in 24h/48h/7d" window) — without this index it was a FULL SCAN of the
-- whole table (~350k rows, ~3s). idx_signals_apn_type speeds the per-parcel
-- stacked_types/signal_types aggregation (one GROUP BY join instead of two
-- correlated subqueries per row) by covering signal_type+event_date off the
-- apn lookup, avoiding a table lookup per matched row.
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at);
CREATE INDEX IF NOT EXISTS idx_signals_apn_type ON signals (apn, signal_type) STORING (event_date);

CREATE TABLE IF NOT EXISTS scores (
  apn          STRING PRIMARY KEY REFERENCES properties(apn),
  score        INT NOT NULL,
  hot          BOOL NOT NULL DEFAULT false,
  signal_types STRING[],
  components   JSONB,
  breakdown    JSONB,
  updated_at   TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE scores ADD COLUMN IF NOT EXISTS breakdown JSONB;
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_hot ON scores (hot) WHERE hot = true;

CREATE TABLE IF NOT EXISTS scrape_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          STRING NOT NULL,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  rows_found      INT,
  rows_new        INT,
  status          STRING,
  error           STRING,
  source_max_date DATE
);

-- Lead save/hide persistence
CREATE TABLE IF NOT EXISTS lead_actions (
  apn        STRING NOT NULL,
  action     STRING NOT NULL,   -- 'saved' | 'hidden'
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (apn, action)
);

-- Scraper resume state (court walkers store last-seen case numbers here)
CREATE TABLE IF NOT EXISTS scraper_state (
  key        STRING PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Owner-name index for name→parcel resolution (built by src/build-name-index.js)
CREATE TABLE IF NOT EXISTS owner_name_keys (
  key    STRING NOT NULL,   -- "LAST|FIRST" for persons, "=NAME" for entities
  apn    STRING NOT NULL,
  middle STRING,
  PRIMARY KEY (key, apn)
);
