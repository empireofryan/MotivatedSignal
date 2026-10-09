// Idempotent migration: adds situs_norm column to properties, populates it in batches, creates index
import 'dotenv/config';
import { query, pool } from './db.js';
import { normalizeAddress } from './normalize.js';

const BATCH_SIZE = 5000;

async function migrateSitusNorm() {
  // 1. Add column if not exists
  console.log('Adding situs_norm column...');
  await query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS situs_norm STRING`);
  console.log('Column added (or already exists).');

  // 2. Count rows needing population
  const countRes = await query(`SELECT COUNT(*) as cnt FROM properties WHERE situs_norm IS NULL`);
  const total = parseInt(countRes.rows[0].cnt, 10);
  console.log(`Rows to populate: ${total}`);

  let updated = 0;

  while (true) {
    // Fetch a page of apns + situs_address where situs_norm is null
    const batchRes = await query(
      `SELECT apn, situs_address FROM properties WHERE situs_norm IS NULL LIMIT $1`,
      [BATCH_SIZE]
    );
    if (batchRes.rows.length === 0) break;

    // Build batched update using unnest
    const apns = batchRes.rows.map(r => r.apn);
    const norms = batchRes.rows.map(r => normalizeAddress(r.situs_address));

    // Use a VALUES list approach: UPDATE ... FROM (VALUES ...)
    // CockroachDB supports this pattern; explicit STRING casts required for type inference
    const valuePlaceholders = apns.map((_, i) => `($${i * 2 + 1}::STRING, $${i * 2 + 2}::STRING)`).join(', ');
    const params = [];
    for (let i = 0; i < apns.length; i++) {
      params.push(apns[i], norms[i]);
    }

    await query(
      `UPDATE properties SET situs_norm = v.norm
       FROM (VALUES ${valuePlaceholders}) AS v(apn, norm)
       WHERE properties.apn = v.apn`,
      params
    );

    updated += batchRes.rows.length;
    console.log(`  Updated ${updated} / ${total}`);

    if (batchRes.rows.length < BATCH_SIZE) break;
  }

  // 3. Create index
  console.log('Creating index...');
  await query(`CREATE INDEX IF NOT EXISTS idx_properties_situs_norm ON properties (situs_norm)`);
  console.log('Index created (or already exists).');
  console.log(`Done. Total rows populated: ${updated}`);
}

migrateSitusNorm().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
