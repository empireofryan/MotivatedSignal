import 'dotenv/config';
import { query, pool } from './db.js';
import { streetOnly } from './normalize.js';
import { signalKeys, isEntity, entityKey } from './namekeys.js';
import { fileURLToPath } from 'node:url';

/**
 * classifyMatches(apns, confidenceWhenUnique)
 * 1 match → { apn: apns[0], confidence: confidenceWhenUnique }
 * >1 match → { apn: null, confidence: 'ambiguous' }
 * 0 matches → { apn: null, confidence: 'none' }
 */
export function classifyMatches(apns, confidenceWhenUnique) {
  if (apns.length === 1) return { apn: apns[0], confidence: confidenceWhenUnique };
  if (apns.length > 1) return { apn: null, confidence: 'ambiguous' };
  return { apn: null, confidence: 'none' };
}

/** Chunk an array into sub-arrays of at most `size` elements */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Apply a list of update objects in parallel batches of 500.
 * Each `u`: { id, apn|null, confidence, resolution }
 */
async function applyUpdates(updates) {
  for (const batch of chunk(updates, 500)) {
    await Promise.all(batch.map(u => {
      const resJson = JSON.stringify({ resolution: u.resolution });
      if (u.apn) {
        return query(
          `UPDATE signals SET apn=$1, resolved=true, match_confidence=$2, raw=COALESCE(raw,'{}') || $3::jsonb WHERE id=$4`,
          [u.apn, u.confidence, resJson, u.id]
        );
      } else {
        return query(
          `UPDATE signals SET resolved=true, match_confidence=$1, raw=COALESCE(raw,'{}') || $2::jsonb WHERE id=$3`,
          [u.confidence, resJson, u.id]
        );
      }
    }));
  }
}

/**
 * Name → parcel via owner_name_keys ("LAST|FIRST" / "=ENTITY").
 * Re-attempts every name signal that still has no apn (previous 'none'/'ambiguous'
 * verdicts are not final — the index and rules improve over time).
 * Tie-breaks for multiple candidates: middle-initial agreement, then owner-occupied.
 */
async function resolveByNameKeys(sources) {
  const res = await query(
    `SELECT id, owner_name FROM signals
     WHERE apn IS NULL AND owner_name IS NOT NULL AND source = ANY($1)`,
    [sources]
  );
  const rows = res.rows;

  const prepared = [];
  const noneUpdates = [];
  for (const row of rows) {
    let keys = [];
    let middles = [];
    if (isEntity(row.owner_name)) {
      const k = entityKey(row.owner_name);
      if (k) keys = [k];
    } else {
      ({ keys, middles } = signalKeys(row.owner_name));
    }
    if (keys.length === 0) {
      noneUpdates.push({ id: row.id, apn: null, confidence: 'none', resolution: { candidates: [], count: 0, method: 'keys' } });
    } else {
      prepared.push({ id: row.id, keys, middles });
    }
  }

  const distinctKeys = [...new Set(prepared.flatMap((r) => r.keys))];
  const keyToCands = new Map();
  for (const keyChunk of chunk(distinctKeys, 1000)) {
    const dbRes = await query(
      `SELECT k.key, k.apn, k.middle, p.absentee
       FROM owner_name_keys k JOIN properties p ON p.apn = k.apn
       WHERE k.key = ANY($1)`,
      [keyChunk]
    );
    for (const r of dbRes.rows) {
      if (!keyToCands.has(r.key)) keyToCands.set(r.key, []);
      keyToCands.get(r.key).push({ apn: r.apn, middle: r.middle, absentee: r.absentee });
    }
  }

  const assignUpdates = [];
  const otherUpdates = [];
  for (const row of prepared) {
    const byApn = new Map();
    for (const k of row.keys) for (const c of keyToCands.get(k) ?? []) byApn.set(c.apn, c);
    let cands = [...byApn.values()];
    let confidence = 'none';
    let pick = null;

    if (cands.length === 1) {
      pick = cands[0];
      const mid = pick.middle && row.middles.some((m) => m[0] === pick.middle[0]);
      confidence = mid ? 'exact' : 'probable';
    } else if (cands.length > 1) {
      // Tie-break 1: middle initial / middle name agreement
      if (row.middles.length) {
        const m = cands.filter((c) => c.middle && row.middles.some((x) => x[0] === c.middle[0]));
        if (m.length === 1) { pick = m[0]; confidence = 'probable'; }
        else if (m.length > 1) cands = m;
      }
      // Tie-break 2: the owner-occupied parcel (a person's homestead)
      if (!pick) {
        const home = cands.filter((c) => c.absentee === false);
        if (home.length === 1) { pick = home[0]; confidence = 'likely'; }
        else confidence = 'ambiguous';
      }
    }

    const resolution = { candidates: cands.slice(0, 20).map((c) => c.apn), count: cands.length, method: 'keys' };
    if (pick) assignUpdates.push({ id: row.id, apn: pick.apn, confidence, resolution });
    else otherUpdates.push({ id: row.id, apn: null, confidence, resolution });
  }

  await applyUpdates([...noneUpdates, ...assignUpdates, ...otherUpdates]);

  const byConf = {};
  for (const u of assignUpdates) byConf[u.confidence] = (byConf[u.confidence] ?? 0) + 1;
  return {
    attempted: rows.length,
    assigned: assignUpdates.length,
    byConfidence: byConf,
    ambiguous: otherUpdates.filter((u) => u.confidence === 'ambiguous').length,
    none: noneUpdates.length + otherUpdates.filter((u) => u.confidence === 'none').length,
  };
}

async function resolveByAddressBatch(sources) {
  // 1. Load all unresolved address signals for these sources
  const res = await query(
    `SELECT id, situs_address, raw FROM signals
     WHERE resolved=false AND apn IS NULL AND situs_address IS NOT NULL AND source = ANY($1)`,
    [sources]
  );
  const rows = res.rows;

  const noneUpdates = [];
  const lookupRows = [];

  for (const row of rows) {
    const key = streetOnly(row.situs_address);
    if (key.length < 4) {
      noneUpdates.push({ id: row.id, apn: null, confidence: 'none', resolution: { candidates: [], count: 0 } });
    } else {
      lookupRows.push({ ...row, key });
    }
  }

  // 2. Gather distinct keys and query DB in chunks of 1000
  const distinctKeys = [...new Set(lookupRows.map(r => r.key))];
  const keyToApns = new Map();

  for (const keyChunk of chunk(distinctKeys, 1000)) {
    const dbRes = await query(
      `SELECT apn, situs_norm FROM properties WHERE situs_norm = ANY($1)`,
      [keyChunk]
    );
    for (const row of dbRes.rows) {
      const existing = keyToApns.get(row.situs_norm) || [];
      existing.push(row.apn);
      keyToApns.set(row.situs_norm, existing);
    }
  }

  // 3. Classify and build updates
  const assignUpdates = [];
  const otherUpdates = [];

  for (const row of lookupRows) {
    const apns = keyToApns.get(row.key) || [];
    const { apn, confidence } = classifyMatches(apns, 'exact');
    const resolution = { candidates: apns.slice(0, 20), count: apns.length };
    if (apn) {
      assignUpdates.push({ id: row.id, apn, confidence, resolution });
    } else {
      otherUpdates.push({ id: row.id, apn: null, confidence, resolution });
    }
  }

  // 4. Apply all updates
  await applyUpdates([...noneUpdates, ...assignUpdates, ...otherUpdates]);

  const ambiguous = otherUpdates.filter(u => u.confidence === 'ambiguous').length;
  const none = noneUpdates.length + otherUpdates.filter(u => u.confidence === 'none').length;

  return {
    attempted: rows.length,
    assigned: assignUpdates.length,
    ambiguous,
    none,
  };
}

export async function resolveSignals() {
  const results = {};

  // Step 1: mark already-apn'd signals resolved
  const r0 = await query(`UPDATE signals SET resolved=true, match_confidence='source' WHERE apn IS NOT NULL AND resolved=false`);
  results.already_resolved = r0.rowCount || 0;
  console.log(`Marked ${results.already_resolved} already-apn'd signals resolved.`);

  // Step 2: name pass over every name-bearing source (court + recorder)
  results.name_match = await resolveByNameKeys([
    'recorder_nots', 'court_probate', 'court_divorce', 'recorder_lp', 'recorder_ml', 'recorder_nl',
  ]);
  console.log('Name match:', results.name_match);

  // Step 3: address pass (code_glendale + code_tempe)
  results.address_match = await resolveByAddressBatch(['code_glendale', 'code_tempe']);
  console.log('Address match:', results.address_match);

  return results;
}

// CLI entrypoint
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resolveSignals()
    .then(results => {
      console.log('\n=== Resolution complete ===');
      console.log(JSON.stringify(results, null, 2));
      return pool.end();
    })
    .catch(e => {
      console.error(e);
      pool.end();
      process.exit(1);
    });
}
