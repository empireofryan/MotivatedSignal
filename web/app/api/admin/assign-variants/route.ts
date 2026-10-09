import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { adminKeyMatches, assignMissingVariants } from '../../../../lib/outreach';

// POST /api/admin/assign-variants — fills prospects.subject_variant where null, balanced
// round-robin A/B/C/D within each segment. Safe to re-run; never touches an existing value.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine for this endpoint
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const key = request.headers.get('x-admin-key') ?? (typeof b.key === 'string' ? b.key : null);
  if (!adminKeyMatches(key)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const updated = await assignMissingVariants(turso());
  return NextResponse.json({ ok: true, updated });
}
