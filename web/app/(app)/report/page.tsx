import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  getDailyReport,
  getHotStacks,
  resolveWindowOption,
  resolveFiledOption,
  WINDOW_OPTIONS,
  FILED_OPTIONS,
  DEFAULT_WINDOW_KEY,
  DEFAULT_FILED_KEY,
} from '../../../lib/report';
import { getAccessState } from '../../../lib/access';
import ChipHint from './ChipHint';
import ExportControls from './ExportControls';
import TableRow from './TableRow';
import TrialWelcome from './TrialWelcome';
import TrialPill from './TrialPill';
import {
  SIGNAL_LABELS,
  PLURALS,
  URGENT,
  titleCase,
  formatSitusAddress,
  fmtMoney,
  fmtDate,
  fmtDatePhoenix,
  fmtAuction,
  listSentence,
  initialsOf,
  daysLeftUntil,
} from './format';
import s from './report.module.css';

export const metadata: Metadata = { title: 'Daily Report' };
export const dynamic = 'force-dynamic';

// Window/filed option tables and their defaults live in lib/report.ts
// (shared with the CSV export route so a URL param resolves identically in
// both places). `window` has no-param default 7 days (trial users land
// Monday morning, when the recorder/courts haven't posted over the weekend
// and 24h would show almost nothing); `window=24h` is still explicit and
// `48`/`7d` are unchanged. `filed` keeps defaulting to the 2-week
// "hide backfill" view, independent of the window default.
const HOMEOWNER_OPTIONS = [
  { key: '', label: 'Homeowners' },
  { key: '0', label: 'All owners' },
];

// titleCase, formatSitusAddress, fmtMoney, fmtDate, fmtAuction, listSentence
// now live in ./format (shared with TableRow.tsx's client-side row expand).

export default async function DailyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ filed?: string; window?: string; homeowners?: string }>;
}) {
  const { filed, window, homeowners } = await searchParams;
  // Absent/unrecognized `filed` param resolves to the 14-day default (hides
  // backfill) — this is what "URL param stays backward compatible" means:
  // old links with no `filed` param now get the 14-day view instead of "Any
  // date". This chip only filters which rows show; it never changes the
  // headline, which always uses the fixed FRESH_WINDOW_DAYS cutoff.
  const filedOpt = resolveFiledOption(filed);
  const filedKey = filedOpt.key;
  const filedHours = filedOpt.days !== undefined ? filedOpt.days * 24 : undefined;
  // Absent/unrecognized `window` param resolves to 7 days (DEFAULT_WINDOW_KEY)
  // — trial users land Monday morning, when the recorder/courts haven't
  // posted anything over the weekend and a 24h default would show almost
  // nothing but city code violations. `window=24h` is still explicit.
  const win = resolveWindowOption(window);
  const homeownersOnly = homeowners !== '0';
  const [
    { rows: allRows, counts, olderFiledCount, generatedAt },
    hotStacks,
  ] = await Promise.all([
    getDailyReport(win.hours, 50, filedHours, homeownersOnly),
    getHotStacks(),
  ]);
  // Pro gate: subscribers carry a signed ms_pro cookie (set by /api/pro?key=<customer key>),
  // trial visitors carry a signed ms_trial cookie (set by /r/<code> or /api/trial?k=…). Both are
  // verified fresh on every request in getAccessState — see web/lib/access.ts.
  const cookieStore = await cookies();
  const access = await getAccessState({
    proCookie: cookieStore.get('ms_pro')?.value,
    trialCookie: cookieStore.get('ms_trial')?.value,
  });
  const isPro = access.isPro;
  const isTrial = access.isTrialActive;
  const trialUntil = isTrial ? access.trialUntil ?? undefined : undefined;
  const welcomeDismissed = cookieStore.get('ms_welcome_dismissed')?.value === '1';
  const checkoutHref = process.env.STRIPE_PRO_LINK || '/pricing';
  const trialDaysLeft = trialUntil ? daysLeftUntil(trialUntil) : null;
  const FREE_ROWS = 10;
  const allowedRows = isPro ? allRows : allRows.slice(0, FREE_ROWS);
  const hiddenCount = allRows.length - allowedRows.length;
  // Free visitors only (isPro is true for Pro AND trial access — see
  // isProAccess): mask the owner name to initials on probate/divorce rows.
  // These are public-record case types, but we still avoid spelling out a
  // specific person's name next to "divorce" on an open page. Entities
  // (LLCs, trusts flagged is_entity) aren't masked, no privacy concern
  // naming a company.
  const maskNames = !isPro;
  const rows = maskNames
    ? allowedRows.map((r) => {
        const types = (r.signal_types ?? r.signal_type).split(',').map((t) => t.trim());
        const sensitive = types.includes('probate') || types.includes('divorce');
        if (sensitive && r.owner_name && !r.is_entity) {
          return { ...r, owner_name: initialsOf(r.owner_name) };
        }
        return r;
      })
    : allowedRows;
  const total = counts.reduce((a, c) => a + Number(c.n), 0);

  const cur = { window: win.key, filed: filedKey, homeowners: homeownersOnly ? '' : '0' };
  function hrefFor(next: Partial<typeof cur>) {
    const q = new URLSearchParams();
    const v = { ...cur, ...next };
    if (v.window && v.window !== DEFAULT_WINDOW_KEY) q.set('window', v.window);
    if (v.filed && v.filed !== DEFAULT_FILED_KEY) q.set('filed', v.filed);
    if (v.homeowners) q.set('homeowners', v.homeowners);
    const qs = q.toString();
    return `/report${qs ? `?${qs}` : ''}`;
  }
  const exportBaseParams: Record<string, string> = {
    window: cur.window || DEFAULT_WINDOW_KEY,
    filed: cur.filed || DEFAULT_FILED_KEY,
    ...(cur.homeowners ? { homeowners: cur.homeowners } : {}),
  };

  const generated = new Date(generatedAt);
  const dateLine = generated.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Phoenix',
  });
  const summary = listSentence(
    counts.map((c) => `${Number(c.n).toLocaleString('en-US')} ${Number(c.n) === 1 ? (SIGNAL_LABELS[c.signal_type] ?? c.signal_type).toLowerCase() : (PLURALS[c.signal_type] ?? c.signal_type)}`)
  );
  // Top 3 types by count, each with its freshest filed date, for the
  // "Freshest filings: ..." line — shows how recent the "new" signals really
  // are (counts already comes sorted `n DESC`, but don't depend on that).
  const freshestTop3 = counts
    .filter((c) => c.freshest)
    .slice()
    .sort((a, b) => Number(b.n) - Number(a.n))
    .slice(0, 3);
  const freshestLine = freshestTop3.length
    ? `Freshest filings: ${listSentence(freshestTop3.map((c) => `${(PLURALS[c.signal_type] ?? c.signal_type).toLowerCase()} ${fmtDate(c.freshest as string)}`))}.`
    : null;
  const maxScore = Math.max(120, ...rows.map((r) => Number(r.score ?? 0)));

  return (
    <div className={s.page}>
      <main className={s.wrap}>
        <header className={s.head}>
          <p className={s.dateLine}>Daily report for {dateLine}</p>
          <h1 className={s.title}>
            <span className={s.count}>{total.toLocaleString('en-US')}</span> new signal{total === 1 ? '' : 's'} in the last{' '}
            {win.label}
            {homeownersOnly ? ', homeowners only' : ''}.
          </h1>
          {total > 0 ? <p className={s.summary}>{summary}.</p> : null}
          <p className={s.provExplainer}>Every row links to the county document or docket it came from.</p>
          {freshestLine ? <p className={s.freshNote}>{freshestLine}</p> : null}
          {olderFiledCount > 0 ? (
            <p className={s.olderNote}>
              plus {olderFiledCount.toLocaleString('en-US')} older filing{olderFiledCount === 1 ? '' : 's'} newly detected (backfill)
              {filedKey !== 'any' ? ', hidden below' : ''}
            </p>
          ) : null}
        </header>

        <nav className={s.controls} aria-label="Report filters">
          <div className={s.seg} role="group" aria-label="Time window">
            <span className={s.segLabel}>New in</span>
            {WINDOW_OPTIONS.map((o) => (
              <Link
                key={o.key}
                href={hrefFor({ window: o.key })}
                prefetch
                className={s.segBtn}
                aria-current={cur.window === o.key ? 'true' : undefined}
              >
                {o.label}
                <ChipHint />
              </Link>
            ))}
          </div>
          <div className={s.seg} role="group" aria-label="County filing date">
            <span className={s.segLabel}>Filed</span>
            {FILED_OPTIONS.map((o) => (
              <Link
                key={o.key}
                href={hrefFor({ filed: o.key })}
                prefetch
                className={s.segBtn}
                aria-current={cur.filed === o.key ? 'true' : undefined}
              >
                {o.label}
                <ChipHint />
              </Link>
            ))}
          </div>
          <div className={s.seg} role="group" aria-label="Owner type">
            {HOMEOWNER_OPTIONS.map((o) => (
              <Link
                key={o.key}
                href={hrefFor({ homeowners: o.key })}
                prefetch
                className={s.segBtn}
                aria-current={cur.homeowners === o.key ? 'true' : undefined}
              >
                {o.label}
                <ChipHint />
              </Link>
            ))}
          </div>
          {isPro ? (
            <ExportControls baseParams={exportBaseParams} />
          ) : (
            <span className={s.exportBtnDisabled} aria-disabled="true" title="Pro">
              Export CSV
            </span>
          )}
        </nav>

        {isTrial && !welcomeDismissed ? (
          <TrialWelcome
            trialEndLabel={trialUntil ? fmtDatePhoenix(trialUntil) : null}
            checkoutHref={checkoutHref}
          />
        ) : null}

        {access.trialEnded && !isPro ? (
          <p className={s.olderNote}>
            Your trial ended {access.trialUntil ? fmtDatePhoenix(access.trialUntil) : ''}.{' '}
            <a href={checkoutHref}>Keep it for $99/mo</a>.
          </p>
        ) : null}

        {hotStacks.length > 0 ? (
          <section className={s.hotStrip} aria-label="Hottest stacks this week">
            <h2 className={s.hotHeading}>Hottest stacks this week</h2>
            <div className={s.hotGrid}>
              {hotStacks.map((r, i) => {
                const types = (r.signal_types ?? r.signal_type).split(',').map((t) => t.trim()).filter(Boolean);
                const auction = r.est_auction_date ? fmtAuction(r.est_auction_date) : null;
                return (
                  <article key={`${r.apn ?? i}-${i}`} className={s.hotCard}>
                    <div className={s.hotCardTop}>
                      <span className={s.hotScore}>{Number(r.score ?? 0)}</span>
                      <div className={s.hotAddrBlock}>
                        <span className={s.hotAddr}>
                          {r.situs_address ? titleCase(formatSitusAddress(r.situs_address)) : 'Address not yet matched'}
                        </span>
                        <span className={s.hotCity}>{r.situs_city ? titleCase(r.situs_city) : ''}</span>
                      </div>
                    </div>
                    <div className={s.hotTags}>
                      {types.map((t) => (
                        <span key={t} className={`${s.tag} ${URGENT.has(t) ? s.tagUrgent : ''}`}>
                          {SIGNAL_LABELS[t] ?? t}
                        </span>
                      ))}
                    </div>
                    <dl className={s.hotMeta}>
                      <div>
                        <dt>Filed</dt>
                        <dd>{r.event_date ? fmtDate(r.event_date) : '-'}</dd>
                      </div>
                      <div>
                        <dt>Auction</dt>
                        <dd>{auction ? `${auction.dateStr} (est.), ${auction.rel}` : '-'}</dd>
                      </div>
                      <div>
                        <dt>Value</dt>
                        <dd>{r.assessed_value != null ? fmtMoney(r.assessed_value) : '-'}</dd>
                      </div>
                      <div>
                        <dt>Owned</dt>
                        <dd>{r.years_owned != null ? `${r.years_owned} yr${r.years_owned === 1 ? '' : 's'}` : '-'}</dd>
                      </div>
                    </dl>
                    {r.absentee === true ? (
                      <p className={s.hotMailing}>
                        <span className={s.abs}>Absentee</span>{' '}
                        {r.mailing_address
                          ? isPro
                            ? `mails to ${titleCase(r.mailing_address)}`
                            : 'mailing address in Pro'
                          : ''}
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {rows.length === 0 ? (
          <div className={s.empty}>
            <p>Nothing matches these filters yet.</p>
            <p>
              <a href={hrefFor({ window: '7d', filed: 'any' })}>Widen to 7 days, any date</a> or{' '}
              <a href={hrefFor({ homeowners: '0' })}>include all owners</a>. The pipeline refreshes every
              morning.
            </p>
          </div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th className={s.thRank} aria-label="Rank" />
                  <th className={s.thScore}>Score</th>
                  <th>Property</th>
                  <th>Owner</th>
                  <th>Signals</th>
                  <th className={s.num}>Filed</th>
                  <th className={s.num}>Auction</th>
                  <th className={s.num}>Value</th>
                  <th className={s.num}>Owned</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <TableRow
                    key={`${r.signal_type}-${r.apn ?? i}-${i}`}
                    row={r}
                    rank={i + 1}
                    maxScore={maxScore}
                    isPro={isPro}
                  />
                ))}
              </tbody>
            </table>
            {!isPro && hiddenCount > 0 ? (
              <div className={s.gate}>
                <div className={s.gateCopy}>
                  <p className={s.gateHeadline}>
                    <strong>{hiddenCount} more ranked homeowner{hiddenCount === 1 ? '' : 's'}</strong> today,
                    mailing addresses, source documents on every row, and CSV export.
                  </p>
                  <p className={s.gateSub}>Start a 7-day free trial to see all of it.</p>
                </div>
                <div className={s.gateActions}>
                  <a className={s.gateBtn} href="/pricing">See Pro, $99/month</a>
                  <a className={s.gateSecondary} href="mailto:hello@motivatedsignal.com">
                    Or reply to the email you got
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <p className={s.foot}>
          Recent filings weigh more, and each signal type decays on its own clock. Live signals get a
          bonus when they stack, trustee sales get extra weight as the estimated auction date nears,
          and absentee ownership and long tenure add a little more.
          Generated {generated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' })} Phoenix time.
        </p>
      </main>

      {isTrial && trialDaysLeft !== null ? (
        // Persistent conversion nudge: always visible during the trial (not
        // dismissible, unlike TrialWelcome above). CSS (via TrialPill's own
        // class) switches it between a fixed corner pill (desktop) and a
        // full-width sticky footer bar (mobile) at the same breakpoint the
        // rest of the page uses.
        <TrialPill daysLeft={trialDaysLeft} checkoutHref={checkoutHref} />
      ) : null}
    </div>
  );
}
