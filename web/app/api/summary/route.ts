import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { query } from '../../../lib/db';

const getSummary = unstable_cache(
  async () => {
    const [scoredRes, hotRes, bySignalRes, topCitiesRes, freshLast7Res, freshLast30Res] = await Promise.all([
      query('SELECT COUNT(*) as cnt FROM scores'),
      query('SELECT COUNT(*) as cnt FROM scores WHERE hot = true'),
      query(`
        SELECT signal_type, COUNT(*) as cnt
        FROM (
          SELECT unnest(signal_types) as signal_type FROM scores
        ) t
        GROUP BY signal_type
        ORDER BY cnt DESC
      `),
      query(`
        SELECT p.situs_city as city, COUNT(*) as n
        FROM scores s
        JOIN properties p ON p.apn = s.apn
        WHERE p.situs_city IS NOT NULL
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 8
      `),
      query(`SELECT count(DISTINCT s.apn)::int as cnt FROM signals s WHERE s.apn IN (SELECT apn FROM scores) AND s.event_date >= current_date - 7`),
      query(`SELECT count(DISTINCT s.apn)::int as cnt FROM signals s WHERE s.apn IN (SELECT apn FROM scores) AND s.event_date >= current_date - 30`),
    ]);

    const bySignal: Record<string, number> = {};
    for (const row of bySignalRes.rows) {
      bySignal[row.signal_type] = Number(row.cnt);
    }

    const topCities = topCitiesRes.rows.map(r => ({
      city: r.city,
      n: Number(r.n),
    }));

    return {
      scored: Number(scoredRes.rows[0].cnt),
      hot: Number(hotRes.rows[0].cnt),
      bySignal,
      topCities,
      freshLast7: Number(freshLast7Res.rows[0].cnt),
      freshLast30: Number(freshLast30Res.rows[0].cnt),
    };
  },
  ['summary-v1'],
  { revalidate: 600, tags: ['summary'] },
);

export async function GET() {
  try {
    return NextResponse.json(await getSummary());
  } catch (err) {
    console.error('summary error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
