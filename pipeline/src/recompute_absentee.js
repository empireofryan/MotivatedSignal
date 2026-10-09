// pipeline/src/recompute_absentee.js
//
// One-off batch recompute of properties.absentee using the fixed
// addressMatchKey()/sameStreetAddress() normalizer (see normalize.js) instead
// of the old punctuation-only compare. Re-parses the same Secured Master
// files the nightly ingest reads (pipeline/data/secured_master/Data/) so the
// absentee flag is derived the exact same way parseOneLine() computes it at
// ingest time — no re-ingest of the rest of the row needed, this only
// touches `absentee`.
//
// Run: node src/recompute_absentee.js
// (wrap with `timeout 1800 node src/recompute_absentee.js` from the shell —
//  this script does not self-timeout.)

import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { pool, query } from './db.js';
import { parseOneLine } from './sources/assessor.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'secured_master', 'Data');
const BATCH_SIZE = 50_000;

async function applyBatch(batch) {
  if (batch.length === 0) return;
  const apns = batch.map((r) => r.apn);
  const absentees = batch.map((r) => r.absentee);
  await query(
    `UPDATE properties p
     SET absentee = v.absentee, updated_at = now()
     FROM (SELECT unnest($1::STRING[]) AS apn, unnest($2::BOOL[]) AS absentee) AS v
     WHERE p.apn = v.apn AND (p.absentee IS DISTINCT FROM v.absentee)`,
    [apns, absentees]
  );
}

async function countAbsentee() {
  const { rows } = await query('SELECT count(*)::int AS n FROM properties WHERE absentee = true');
  return rows[0].n;
}

async function main() {
  const before = await countAbsentee();
  console.log(`[recompute_absentee] absentee=true before: ${before.toLocaleString()}`);

  const files = (await readdir(DATA_DIR))
    .filter((f) => /^Secured_Master_BK\d+\.txt$/i.test(f))
    .sort();
  console.log(`[recompute_absentee] ${files.length} source file(s): ${files.join(', ')}`);

  let batch = [];
  let totalParsed = 0;
  let totalUpdatedBatches = 0;

  for (const file of files) {
    const filePath = join(DATA_DIR, file);
    console.log(`[recompute_absentee] scanning ${file}...`);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let fileRows = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = parseOneLine(line.split('|'));
      if (!row) continue;

      batch.push({ apn: row.apn, absentee: row.absentee });
      fileRows++;
      totalParsed++;

      if (batch.length >= BATCH_SIZE) {
        await applyBatch(batch);
        totalUpdatedBatches++;
        console.log(`  [recompute_absentee] applied batch ${totalUpdatedBatches} (${totalParsed.toLocaleString()} rows parsed so far)`);
        batch = [];
      }
    }
    console.log(`  [recompute_absentee] ${file}: ${fileRows.toLocaleString()} rows parsed`);
  }

  if (batch.length > 0) {
    await applyBatch(batch);
    totalUpdatedBatches++;
    console.log(`  [recompute_absentee] applied final batch ${totalUpdatedBatches} (${totalParsed.toLocaleString()} rows parsed total)`);
  }

  const after = await countAbsentee();
  console.log(`[recompute_absentee] absentee=true after: ${after.toLocaleString()}`);
  console.log(`[recompute_absentee] total rows parsed: ${totalParsed.toLocaleString()}`);
  console.log(`[recompute_absentee] delta: ${(after - before).toLocaleString()}`);
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('[recompute_absentee] failed:', e);
    return pool.end().finally(() => process.exit(1));
  });
