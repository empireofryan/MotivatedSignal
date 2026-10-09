import { query } from './db.js';

export async function upsertProperties(rows) {
  let count = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO properties
        (apn, situs_address, situs_city, situs_zip, owner_name, owner_name_norm,
         mailing_address, absentee, year_built, living_sqft, building_type,
         last_sale_date, last_sale_price, assessed_value, legal_class, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (apn) DO UPDATE SET
         situs_address=excluded.situs_address, situs_city=excluded.situs_city,
         situs_zip=excluded.situs_zip, owner_name=excluded.owner_name,
         owner_name_norm=excluded.owner_name_norm, mailing_address=excluded.mailing_address,
         absentee=excluded.absentee, year_built=excluded.year_built,
         living_sqft=excluded.living_sqft, building_type=excluded.building_type,
         last_sale_date=excluded.last_sale_date, last_sale_price=excluded.last_sale_price,
         assessed_value=excluded.assessed_value, legal_class=excluded.legal_class,
         updated_at=now()`,
      [r.apn, r.situsAddress, r.situsCity, r.situsZip, r.ownerName, r.ownerNameNorm,
       r.mailingAddress, r.absentee, r.yearBuilt, r.livingSqft, r.buildingType,
       r.lastSaleDate, r.lastSalePrice, r.assessedValue, r.legalClass]
    );
    count++;
  }
  return { count };
}

export async function upsertSignals(records, { signalType, source }) {
  if (records.length === 0) return { found: 0, inserted: 0 };

  // De-duplicate incoming batch by externalId (last occurrence wins for field values)
  const deduped = [...new Map(records.map(r => [r.externalId, r])).values()];

  // One batched existence check: find which externalIds are already in the DB
  const externalIds = deduped.map(r => r.externalId);
  const existsResult = await query(
    'SELECT external_id FROM signals WHERE source=$1 AND external_id = ANY($2)',
    [source, externalIds]
  );
  const existingSet = new Set(existsResult.rows.map(r => r.external_id));
  const inserted = externalIds.filter(id => !existingSet.has(id)).length;

  // Insert/update in chunks to stay within CockroachDB's parameter limit.
  // 10 columns per row → chunk of 500 rows = 5000 params (well under 65535).
  const CHUNK_SIZE = 500;
  const COLS = 10; // apn, signal_type, source, source_url, external_id, event_date, status, owner_name, situs_address, raw
  for (let i = 0; i < deduped.length; i += CHUNK_SIZE) {
    const chunk = deduped.slice(i, i + CHUNK_SIZE);
    const valuePlaceholders = chunk
      .map((_, j) => {
        const base = j * COLS;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10}, now())`;
      })
      .join(',');
    const params = chunk.flatMap(rec => [
      rec.apn ?? null,
      signalType,
      source,
      rec.sourceUrl ?? null,
      rec.externalId,
      rec.eventDate ?? null,
      rec.status ?? null,
      rec.ownerName ?? null,
      rec.situsAddress ?? null,
      rec.raw ?? {},
    ]);
    await query(
      `INSERT INTO signals
        (apn, signal_type, source, source_url, external_id, event_date, status,
         owner_name, situs_address, raw, updated_at)
       VALUES ${valuePlaceholders}
       ON CONFLICT (source, external_id) DO UPDATE SET
         apn=COALESCE(excluded.apn, signals.apn),
         status=excluded.status, event_date=excluded.event_date,
         raw=excluded.raw, owner_name=excluded.owner_name,
         situs_address=excluded.situs_address, updated_at=now()`,
      params
    );
  }

  return { found: records.length, inserted };
}

export async function recordRun(run) {
  const { rows } = await query(
    `INSERT INTO scrape_runs
      (source, started_at, finished_at, rows_found, rows_new, status, error, source_max_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [run.source, run.startedAt ?? null, run.finishedAt ?? null, run.rowsFound ?? null,
     run.rowsNew ?? null, run.status ?? null, run.error ?? null, run.sourceMaxDate ?? null]
  );
  return rows[0]?.id ?? null;
}
