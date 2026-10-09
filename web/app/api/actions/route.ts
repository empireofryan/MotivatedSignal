import { NextRequest, NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { rows } = await query('SELECT apn, action FROM lead_actions', []);
  const saved: string[] = [];
  const hidden: string[] = [];
  for (const row of rows) {
    if (row.action === 'saved') saved.push(row.apn);
    else if (row.action === 'hidden') hidden.push(row.apn);
  }
  return NextResponse.json({ saved, hidden });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  if (
    typeof body !== 'object' || body === null ||
    typeof (body as Record<string, unknown>).apn !== 'string' ||
    !(body as Record<string, unknown>).apn ||
    !['saved', 'hidden'].includes((body as Record<string, unknown>).action as string) ||
    typeof (body as Record<string, unknown>).on !== 'boolean'
  ) {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  const { apn, action, on } = body as { apn: string; action: string; on: boolean };

  if (on) {
    await query('INSERT INTO lead_actions (apn, action) VALUES ($1, $2) ON CONFLICT DO NOTHING', [apn, action]);
  } else {
    await query('DELETE FROM lead_actions WHERE apn = $1 AND action = $2', [apn, action]);
  }

  return NextResponse.json({ ok: true });
}
