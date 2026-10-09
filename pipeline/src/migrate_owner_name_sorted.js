// Idempotent migration: adds owner_name_sorted column to properties, populates it in batches, creates index
import 'dotenv/config';
import { query, pool } from './db.js';
import { sortedNameKey } from './normalize.js';

const BATCH_SIZE = 5000;

async function migrateOwnerNameSorted() {
  // 1. Add column if not exists
  console.log('Adding owner_name_sorted column...');
  await query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_name_sorted STRING`);
  console.log('Column added (or already exists).');

  // 2. Count rows needing population
  const countRes = await query(`SELECT COUNT(*) as cnt FROM properties WHERE owner_name_sorted IS NULL`);
  const total = parseInt(countRes.rows[0].cnt, 10);
  console.log(`Rows to populate: ${total}`);

  let updated = 0;

  while (true) {
    // Fetch a page of apns + owner_name where owner_name_sorted is null
    const batchRes = await query(
      `SELECT apn, owner_name FROM properties WHERE owner_name_sorted IS NULL LIMIT $1`,
      [BATCH_SIZE]
    );
    if (batchRes.rows.length === 0) break;

    // Build batched update using unnest pattern (VALUES list)
    const apns = batchRes.rows.map(r => r.apn);
    const sorted = batchRes.rows.map(r => sortedNameKey(r.owner_name));

    const valuePlaceholders = apns.map((_, i) => `($${i * 2 + 1}::STRING, $${i * 2 + 2}::STRING)`).join(', ');
    const params = [];
    for (let i = 0; i < apns.length; i++) {
      params.push(apns[i], sorted[i]);
    }

    await query(
      `UPDATE properties SET owner_name_sorted = v.sorted
       FROM (VALUES ${valuePlaceholders}) AS v(apn, sorted)
       WHERE properties.apn = v.apn`,
      params
    );

    updated += batchRes.rows.length;
    console.log(`  Updated ${updated} / ${total}`);

    if (batchRes.rows.length < BATCH_SIZE) break;
  }

  // 3. Create index
  console.log('Creating index...');
  await query(`CREATE INDEX IF NOT EXISTS idx_properties_owner_name_sorted ON properties (owner_name_sorted)`);
  console.log('Index created (or already exists).');
  console.log(`Done. Total rows populated: ${updated}`);
}

migrateOwnerNameSorted().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
