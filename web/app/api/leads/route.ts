import { NextRequest, NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';

interface LeadComponents {
  types?: string[];
  modifiers?: Record<string, boolean>;
  fresh?: boolean;
  latest_date?: string;
}

function buildScoreBreakdown(components: LeadComponents): Array<{ label: string; points: number }> {
  const breakdown: Array<{ label: string; points: number }> = [];
  const WEIGHTS: Record<string, number> = {
    trustee_sale: 50, probate: 35, code_violation: 25, tax_delinquent: 20,
  };
  const MODIFIER_WEIGHTS: Record<string, number> = {
    absentee: 10, high_equity: 10, long_tenure: 5,
  };
  const MODIFIER_LABELS: Record<string, string> = {
    absentee: 'Absentee', high_equity: 'High Equity', long_tenure: 'Long Tenure',
  };
  const SIGNAL_LABELS: Record<string, string> = {
    trustee_sale: 'Trustee Sale', probate: 'Probate',
    code_violation: 'Code Violation', tax_delinquent: 'Tax Delinquent',
  };
  const types: string[] = components.types ?? [];
  for (const t of types) {
    if (WEIGHTS[t] !== undefined) {
      breakdown.push({ label: SIGNAL_LABELS[t] ?? t, points: WEIGHTS[t] });
    }
  }
  if (types.length > 1) {
    breakdown.push({ label: 'Signal stacking', points: 15 * (types.length - 1) });
  }
  const modifiers = components.modifiers ?? {};
  for (const [k, v] of Object.entries(modifiers)) {
    if (v && MODIFIER_WEIGHTS[k] !== undefined) {
      breakdown.push({ label: MODIFIER_LABELS[k] ?? k, points: MODIFIER_WEIGHTS[k] });
    }
  }
  if (components.fresh) {
    breakdown.push({ label: 'Fresh (last 30 days)', points: 10 });
  }
  return breakdown;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get('limit') ?? '50');
  const city = searchParams.get('city');
  const minScore = searchParams.get('minScore');
  const hot = searchParams.get('hot');
  const includeHidden = searchParams.get('includeHidden');
  const savedOnly = searchParams.get('savedOnly');

  // Fetch lead_actions before building conditions (only rows we act on)
  const { rows: actionRows } = await query(
    "SELECT apn, action FROM lead_actions WHERE action IN ('saved', 'hidden')",
    []
  );
  const savedSet = new Set<string>();
  const hiddenSet = new Set<string>();
  for (const row of actionRows as { apn: string; action: string }[]) {
    if (row.action === 'saved') savedSet.add(row.apn);
    else if (row.action === 'hidden') hiddenSet.add(row.apn);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (hot === '1') {
    conditions.push('s.hot = true');
  }
  if (minScore !== null) {
    params.push(Number(minScore));
    conditions.push(`s.score >= $${params.length}`);
  }
  if (city !== null) {
    params.push(city);
    conditions.push(`p.situs_city ILIKE '%' || $${params.length} || '%'`);
  }

  // Exclude hidden leads unless includeHidden=1
  if (includeHidden !== '1') {
    const hiddenApns = [...hiddenSet];
    if (hiddenApns.length > 0) {
      params.push(hiddenApns);
      conditions.push(`s.apn != ALL($${params.length})`);
    }
  }

  // Filter to saved leads only if savedOnly=1
  if (savedOnly === '1') {
    const savedApns = [...savedSet];
    params.push(savedApns);
    conditions.push(`s.apn = ANY($${params.length})`);
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

  try {
    const { rows } = await query(sql, params);

    // Batch signals lookup: one query for all APNs instead of N correlated subqueries
    interface SignalRow { apn: string; signal_type: string; source: string | null; event_date: string | Date | null; observed_date: string | Date | null; }
    interface Signal { type: string; source: string | null; eventDate: string | null; observedDate: string | null; }
    const signalsByApn = new Map<string, Signal[]>();

    if (rows.length > 0) {
      const apns = rows.map((r: { apn: string }) => r.apn);
      const sigSql = `SELECT apn, signal_type, source, event_date, observed_date FROM signals WHERE apn = ANY($1)`;
      const { rows: sigRows } = await query(sigSql, [apns]);
      for (const r of sigRows as SignalRow[]) {
        const sig: Signal = {
          type: r.signal_type,
          source: r.source,
          eventDate: r.event_date != null ? String(r.event_date) : null,
          observedDate: r.observed_date != null ? String(r.observed_date) : null,
        };
        const arr = signalsByApn.get(r.apn) ?? [];
        arr.push(sig);
        signalsByApn.set(r.apn, arr);
      }
      // Sort each bucket by eventDate DESC nulls last
      for (const [apn, arr] of signalsByApn) {
        arr.sort((a, b) => {
          const ad = a.eventDate ? String(a.eventDate) : null;
          const bd = b.eventDate ? String(b.eventDate) : null;
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          return bd.localeCompare(ad);
        });
        signalsByApn.set(apn, arr);
      }
    }

    const leads = rows.map((r: { apn: string; score: number | string; hot: boolean; signal_types: string[] | null; components: LeadComponents | null; owner_name: string | null; situs_address: string | null; situs_city: string | null; mailing_address: string | null; absentee: boolean | null; }) => {
      const components: LeadComponents = r.components ?? {};
      return {
        apn: r.apn,
        score: Number(r.score),
        hot: r.hot,
        saved: savedSet.has(r.apn),
        signalTypes: r.signal_types ?? [],
        components,
        ownerName: r.owner_name ?? null,
        situsAddress: r.situs_address ?? null,
        situsCity: r.situs_city ?? null,
        mailingAddress: r.mailing_address ?? null,
        absentee: r.absentee ?? false,
        latestDate: components.latest_date ?? null,
        signals: signalsByApn.get(r.apn) ?? [],
        scoreBreakdown: buildScoreBreakdown(components),
      };
    });
    return NextResponse.json(leads);
  } catch (err) {
    console.error('leads error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
