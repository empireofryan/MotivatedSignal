import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';
import { ensureOutreachSchema, verifyProspectId } from '../../../lib/outreach';

// POST /api/track — first-party page analytics sink for web/components/Tracker.tsx. Accepts
// `navigator.sendBeacon` (a Blob body) and `fetch(..., { keepalive: true })` identically: both
// land here as a POST with a JSON body. Never throws back to the client — logging failures are
// swallowed so a tracking hiccup never breaks the page.
//
// Body shape: { event: string; path: string; sessionId: string; meta?: Record<string, unknown>;
// ms?: number }. `vid` and the prospect id are never trusted from the client: vid comes from the
// `ms_vid` cookie (generated here on first contact if absent), and prospect_id comes from
// verifying the signed `ms_pid` cookie set by /r/<code> (web/app/r/[code]/route.ts).
export const dynamic = 'force-dynamic';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const MAX_EVENTS_PER_VID_PER_MINUTE = 120;
const MAX_META_CHARS = 4000;

// Best-effort in-memory rate limit, keyed by vid. Resets per serverless instance — fine for its
// purpose (absorbing a runaway client, not a security boundary).
const hits = new Map<string, number[]>();

function rateLimited(vid: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (hits.get(vid) ?? []).filter((t) => t > windowStart);
  timestamps.push(now);
  hits.set(vid, timestamps);
  // Keep the map from growing unbounded across many distinct visitors.
  if (hits.size > 5000) {
    const oldestKey = hits.keys().next().value;
    if (oldestKey) hits.delete(oldestKey);
  }
  return timestamps.length > MAX_EVENTS_PER_VID_PER_MINUTE;
}

function randomVid(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function noContent(vidCookie?: { name: string; value: string }): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  if (vidCookie) {
    res.cookies.set(vidCookie.name, vidCookie.value, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
    });
  }
  return res;
}

export async function POST(request: NextRequest) {
  // sendBeacon posts a Blob with no guaranteed Content-Type header in every browser, so parse the
  // body as text first rather than relying on request.json() to pick the right parser.
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return noContent();
  }

  const path = typeof body.path === 'string' ? body.path.slice(0, 300) : '/';
  if (path.startsWith('/admin')) return noContent();

  const event = typeof body.event === 'string' ? body.event.trim().slice(0, 60) : '';
  if (!event) return noContent();

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : null;
  const ms = typeof body.ms === 'number' && Number.isFinite(body.ms) ? Math.round(body.ms) : null;
  let metaStr: string | null = null;
  if (body.meta && typeof body.meta === 'object') {
    try {
      metaStr = JSON.stringify(body.meta).slice(0, MAX_META_CHARS);
    } catch {
      metaStr = null;
    }
  }

  const existingVid = request.cookies.get('ms_vid')?.value ?? null;
  const vid = existingVid || randomVid();
  const newVidCookie = existingVid ? undefined : { name: 'ms_vid', value: vid };

  if (rateLimited(vid)) return noContent(newVidCookie);

  const prospectId = verifyProspectId(request.cookies.get('ms_pid')?.value ?? null);

  try {
    const db = turso();
    await ensureOutreachSchema(db);
    await db.execute({
      sql: `INSERT INTO page_events (vid, prospect_id, session_id, path, event, meta, ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [vid, prospectId, sessionId, path, event, metaStr, ms],
    });
  } catch (err) {
    console.error('page_events insert failed', err);
  }

  return noContent(newVidCookie);
}
