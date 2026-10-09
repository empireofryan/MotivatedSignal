import { query, pool } from './db.js';

/**
 * topLeads({ limit, city, minScore, hotOnly }) → sorted motivated-seller leads
 *
 * Joins `scores` to `properties` on apn.
 * Filters: city (ILIKE), minScore (>=), hotOnly (hot=true).
 * Ordered by score DESC, apn ASC for determinism.
 * Score coerced to Number (CockroachDB returns bigint as string).
 */
export async function topLeads({ limit = 25, city, minScore, hotOnly } = {}) {
  const conditions = [];
  const params = [];

  if (hotOnly) {
    conditions.push('s.hot = true');
  }
  if (minScore !== undefined) {
    params.push(minScore);
    conditions.push(`s.score >= $${params.length}`);
  }
  if (city) {
    params.push(city);
    conditions.push(`p.situs_city ILIKE '%' || $${params.length} || '%'`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      s.apn,
      s.score,
      s.hot,
      s.signal_types,
      s.components,
      p.owner_name,
      p.situs_address,
      p.situs_city,
      p.mailing_address,
      p.absentee
    FROM scores s
    JOIN properties p ON p.apn = s.apn
    ${where}
    ORDER BY s.score DESC, s.apn ASC
    LIMIT ${limitParam}
  `;

  const { rows } = await query(sql, params);

  return rows.map(r => ({
    apn: r.apn,
    score: Number(r.score),
    hot: r.hot,
    signalTypes: r.signal_types ?? [],
    ownerName: r.owner_name ?? '',
    situsAddress: r.situs_address ?? '',
    situsCity: r.situs_city ?? '',
    mailingAddress: r.mailing_address ?? '',
    absentee: r.absentee ?? false,
    components: r.components ?? {},
  }));
}

// ──────────────────────────────────────────────
// CLI entrypoint
// ──────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const has = (flag) => args.includes(flag);

  const limit  = get('--limit')  ? Number(get('--limit'))  : 25;
  const city   = get('--city');
  const hot    = has('--hot');
  const minSc  = get('--min')    ? Number(get('--min'))    : undefined;

  const leads = await topLeads({ limit, city, hotOnly: hot, minScore: minSc });

  if (!leads.length) {
    console.log('No leads found.');
    await pool.end();
    process.exit(0);
  }

  // Column widths
  const COL = {
    rank:    4,
    score:   5,
    hot:     3,
    address: 28,
    city:    12,
    owner:   26,
    signals: 36,
  };

  const pad   = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  const padL  = (s, n) => String(s ?? '').slice(0, n).padStart(n);
  const hr    = '─'.repeat(Object.values(COL).reduce((a, b) => a + b, 0) + Object.keys(COL).length - 1);

  const header = [
    padL('#',     COL.rank),
    padL('Score', COL.score),
    pad('HOT', COL.hot),
    pad('Situs Address', COL.address),
    pad('City', COL.city),
    pad('Owner', COL.owner),
    pad('Signals', COL.signals),
  ].join(' ');

  console.log('\n Motivated-Seller Leads — Maricopa County\n');
  console.log(' ' + header);
  console.log(' ' + hr);

  leads.forEach((r, i) => {
    const hotFlag  = r.hot ? '🔥' : '  ';
    const signals  = (r.signalTypes ?? []).join(', ');
    const row = [
      padL(i + 1,       COL.rank),
      padL(r.score,     COL.score),
      pad(hotFlag,      COL.hot),
      pad(r.situsAddress, COL.address),
      pad(r.situsCity,  COL.city),
      pad(r.ownerName,  COL.owner),
      pad(signals,      COL.signals),
    ].join(' ');
    console.log(' ' + row);
  });

  console.log(' ' + hr);
  console.log(` ${leads.length} lead${leads.length !== 1 ? 's' : ''} shown\n`);

  await pool.end();
}
