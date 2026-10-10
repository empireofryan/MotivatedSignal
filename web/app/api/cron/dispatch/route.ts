import { NextRequest, NextResponse } from 'next/server';

// Vercel Cron -> GitHub workflow_dispatch for the daily pipeline.
// GitHub's own `schedule` trigger drops or delays runs (missed 2026-10-04 06:23 by 4h,
// missed all of 2026-10-05), so Vercel Cron is the primary trigger and GitHub's
// schedule is the backup. The workflow's --if-not-ran-today flag makes repeats no-ops.
export const dynamic = 'force-dynamic';

const REPO = 'empireofryan/MotivatedSignal';
const WORKFLOW = 'daily.yml';

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  // ?mode=catchup (evening run) always runs; the morning run skips if today's already ran.
  const catchup = request.nextUrl.searchParams.get('mode') === 'catchup';
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'GH_DISPATCH_TOKEN not set' }, { status: 500 });
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { fast: false, if_not_ran_today: !catchup } }),
      cache: 'no-store',
    },
  );
  if (res.status !== 204) {
    const text = await res.text();
    console.error('[cron/dispatch] GitHub dispatch failed', res.status, text.slice(0, 300));
    return NextResponse.json({ ok: false, status: res.status }, { status: 502 });
  }
  return NextResponse.json({ ok: true, dispatched: WORKFLOW, catchup, at: new Date().toISOString() });
}
