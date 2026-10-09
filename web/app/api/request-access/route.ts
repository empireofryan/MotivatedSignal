import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';

export const dynamic = 'force-dynamic';

const SEGMENTS = ['wholesaler', 'lender', 'attorney'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Honeypot: bots fill it, humans never see it. Pretend success.
  if (typeof b.company === 'string' && b.company.length > 0) {
    return NextResponse.json({ ok: true });
  }

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  const segment =
    typeof b.segment === 'string' && SEGMENTS.includes(b.segment) ? b.segment : null;
  const source = typeof b.source === 'string' ? b.source.slice(0, 64) : null;

  await turso().execute({
    sql: `INSERT INTO access_requests (email, segment, source)
          VALUES (?, ?, ?)
          ON CONFLICT (email) DO NOTHING`,
    args: [email, segment, source],
  });

  return NextResponse.json({ ok: true });
}
