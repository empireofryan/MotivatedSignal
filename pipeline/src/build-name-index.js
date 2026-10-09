/**
 * Build owner_name_keys: one row per (key, apn) for every parcel owner.
 * Re-run after assessor refreshes. Key = "LAST|FIRST" (persons) or "=NAME" (entities).
 *   node src/build-name-index.js
 */
import { query, pool } from './db.js';
import { propertyKeys, entityKey, isEntity, personsFromOwnerName } from './namekeys.js';

await query(`CREATE TABLE IF NOT EXISTS owner_name_keys (
  key STRING NOT NULL, apn STRING NOT NULL, middle STRING,
  PRIMARY KEY (key, apn))`);
await query(`TRUNCATE owner_name_keys`);

let lastApn = '';
let scanned = 0, keys = 0;
const PAGE = 20000;
for (;;) {
  const { rows } = await query(
    `SELECT apn, owner_name FROM properties WHERE apn > $1 AND owner_name IS NOT NULL ORDER BY apn LIMIT ${PAGE}`,
    [lastApn]
  );
  if (rows.length === 0) break;
  lastApn = rows[rows.length - 1].apn;
  scanned += rows.length;

  const values = [];
  for (const r of rows) {
    if (isEntity(r.owner_name)) {
      const k = entityKey(r.owner_name);
      if (k) values.push([k, r.apn, null]);
    } else {
      for (const p of personsFromOwnerName(r.owner_name)) {
        values.push([`${p.last}|${p.first}`, r.apn, p.middle]);
      }
    }
  }
  for (let i = 0; i < values.length; i += 2000) {
    const batch = values.slice(i, i + 2000);
    const params = [];
    const tuples = batch.map((v, j) => { params.push(...v); return `($${j*3+1},$${j*3+2},$${j*3+3})`; });
    await query(`INSERT INTO owner_name_keys (key, apn, middle) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
    keys += batch.length;
  }
  if (scanned % 200000 === 0) console.log(`[name-index] ${scanned} parcels → ${keys} keys`);
}
console.log(`[name-index] done: ${scanned} parcels → ${keys} keys`);
await pool.end();
