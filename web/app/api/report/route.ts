import { NextRequest, NextResponse } from 'next/server';
import { getDailyReport } from '../../../lib/report';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const hours = Math.min(Number(request.nextUrl.searchParams.get('hours')) || 24, 24 * 14);
  const filedRaw = Number(request.nextUrl.searchParams.get('filed'));
  const filed = filedRaw > 0 ? Math.min(filedRaw, 24 * 14) : undefined;
  const homeownersOnly = request.nextUrl.searchParams.get('homeowners') !== '0';
  const report = await getDailyReport(hours, 50, filed, homeownersOnly);
  return NextResponse.json(report);
}
