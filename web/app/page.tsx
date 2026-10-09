import type { Metadata } from 'next';
import localFont from 'next/font/local';
import styles from './page.module.css';
import RequestAccessForm from './RequestAccessForm';

/* ── Fonts ─────────────────────────────────────────────────────
   Geist for display + body (modern grotesque, tight scale).
   Geist Mono for every figure and label, so the numbers read like
   a county ledger printout.
   Self-hosted from the `geist` npm package's variable woff2 files
   (copied into app/fonts/) — no Google Fonts network fetch. */
const geist = localFont({
  src: './fonts/Geist-Variable.woff2',
  weight: '100 900',
  variable: '--lc-sans',
  display: 'swap',
});

const geistMono = localFont({
  src: './fonts/GeistMono-Variable.woff2',
  weight: '100 900',
  variable: '--lc-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { absolute: 'MotivatedSignal · Maricopa County motivated-seller leads' },
  description:
    'Daily-refreshed motivated-seller lead lists for Maricopa County, built from county public records. Every distress signal matched to a parcel and owner, then ranked by motivation.',
};

/* ── Content ───────────────────────────────────────────────────── */
const FIGURES = [
  { value: '1,756,725', label: 'Parcels tracked' },
  { value: '322,803', label: 'Distress signals' },
  { value: '7,560', label: 'Hot leads today' },
  { value: '9', label: 'Live county sources' },
];

const SOURCES = [
  {
    signal: 'Tax delinquency',
    authority: 'Maricopa County Treasurer',
    count: '166,893',
    live: false,
  },
  {
    signal: 'Code violations',
    authority: 'Mesa, Glendale, Scottsdale, Tempe, Phoenix, county',
    count: '155,678',
    live: false,
  },
  {
    signal: 'Trustee sales, Notices of Sale',
    authority: 'Maricopa County Recorder',
    count: 'Live',
    live: true,
  },
  {
    signal: 'Probate, decedent estates',
    authority: 'Superior Court of Arizona',
    count: 'Live',
    live: true,
  },
];

const STEPS = [
  {
    n: '1',
    title: 'Ingest',
    body: 'Nine county sources pulled every morning, direct from the filing systems the moment records post.',
  },
  {
    n: '2',
    title: 'Match',
    body: 'Each signal resolved to a parcel, owner name, and mailing address across 1.76 million records.',
  },
  {
    n: '3',
    title: 'Rank',
    body: 'Every property scored by motivation, so the hottest leads sit at the top of the list.',
  },
];

const AUDIENCES = [
  {
    who: 'Wholesalers',
    body: 'Reach owners while the signal is fresh, before the weekly lists catch up.',
  },
  {
    who: 'Hard-money lenders',
    body: 'Size distress across the whole county in a single ranked view.',
  },
  {
    who: 'Probate attorneys',
    body: 'Track new decedent estate filings from the Superior Court as they post.',
  },
];

const VIEWS = [
  {
    href: '/atlas',
    name: 'Atlas',
    desc: 'County distress map',
  },
  {
    href: '/dossier',
    name: 'Dossier',
    desc: 'Case file for a single lead',
  },
  {
    href: '/leads',
    name: 'Index',
    desc: 'The full ranked list',
  },
];

/* Illustrative preview of the ranked Lead Index (sample rows). */
const LEADS = [
  { rank: '01', owner: 'Estate of M. Alvarez', apn: '301-44-218', signals: 'Probate · Tax · Code', score: 96 },
  { rank: '02', owner: 'R & D Whitfield', apn: '172-09-553', signals: 'Trustee sale · Tax', score: 91 },
  { rank: '03', owner: 'Saguaro Holdings LLC', apn: '506-31-087', signals: 'Code · Tax', score: 84 },
  { rank: '04', owner: 'J. Contreras', apn: '218-77-140', signals: 'Probate', score: 78 },
  { rank: '05', owner: 'K. Osei', apn: '145-03-662', signals: 'Tax · Code', score: 73 },
];

/* Objection-handling FAQ — answers use only true product facts. */
const FAQ = [
  {
    q: 'Where does the data come from?',
    a: 'Nine primary Maricopa County sources: the Treasurer’s tax-delinquency roll, city and county code-enforcement cases, Recorder trustee-sale notices, and Superior Court probate filings. Public records, pulled the morning they post.',
  },
  {
    q: 'How often is it updated?',
    a: 'Every morning. The prior day’s new filings are ingested, matched to a parcel and owner, and re-ranked before you start work.',
  },
  {
    q: 'How is this different from a weekly aggregator?',
    a: 'Aggregators resell pooled data on a weekly cycle. MotivatedSignal reads the county’s own filings daily, so distress reaches you days earlier, matched to the owner and ranked by motivation.',
  },
  {
    q: 'What does "ranked by motivation" mean?',
    a: 'Each parcel is scored on the distress signals stacked against it. A property with tax delinquency, a code case, and a probate filing outranks one with a single signal, so the hottest leads sit at the top of the list.',
  },
  {
    q: 'How do I work the leads?',
    a: 'Three views on the same daily data: a ranked index to scan top to bottom, a dossier for any single parcel with its owner and signals, and a map of the whole county.',
  },
  {
    q: 'What area do you cover?',
    a: 'Maricopa County, Arizona.',
  },
];

export default function LandingCleanPage() {
  return (
    <div className={`${styles.root} ${geist.variable} ${geistMono.variable}`}>
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className={styles.nav}>
        <div className={styles.navInner}>
          <a href="#top" className={styles.wordmark} aria-label="MotivatedSignal home">
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmarkText}>
              Motivated<span className={styles.wordmarkAccent}>Signal</span>
            </span>
          </a>
          <a href="#request-access" className={styles.navCta}>
            Request access
          </a>
        </div>
      </header>

      <main id="top">
        {/* ── Hero ─────────────────────────────────────────── */}
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Now live in Maricopa County, Arizona</p>
            <h1 className={styles.heroTitle}>
              Reach motivated sellers before the weekly lists do.
            </h1>
            <p className={styles.heroSub}>
              Every morning, MotivatedSignal pulls nine live county sources,
              matches each distress signal to a parcel and owner, and ranks the
              county by motivation. You work the hottest leads the day they
              surface, not a week later off a recycled feed.
            </p>
            <div className={styles.heroActions}>
              <a href="#request-access" className={styles.btnPrimary}>
                Request access
              </a>
              <a href="/dossier" className={styles.btnGhost}>
                See a sample dossier
                <span className={styles.arrow} aria-hidden="true">
                  &rarr;
                </span>
              </a>
            </div>
            <p className={styles.heroTrust}>
              Primary county records · updated every morning · ranked by motivation
            </p>
          </div>

          {/* Product preview: the ranked Lead Index */}
          <aside className={styles.heroPanel} aria-hidden="true">
            <div className={styles.panelBar}>
              <span className={styles.panelDot} />
              Lead Index
              <span className={styles.panelMeta}>updated 06:14</span>
            </div>
            {LEADS.map((l) => (
              <div key={l.apn} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowOwner}>
                    <span className={styles.rank}>{l.rank}</span>
                    {l.owner}
                  </div>
                  <div className={styles.rowMeta}>APN {l.apn} · {l.signals}</div>
                </div>
                <div className={styles.rowScore}>
                  <span className={styles.scoreNum}>{l.score}</span>
                  <span className={styles.scoreBar}>
                    <i style={{ width: `${l.score}%` }} />
                  </span>
                </div>
              </div>
            ))}
            <div className={styles.panelFoot}>7,560 hot of 322,803 signals</div>
          </aside>
        </section>

        {/* ── Figures strip ────────────────────────────────── */}
        <section className={styles.figuresWrap} aria-label="Coverage figures">
          <dl className={styles.figures}>
            {FIGURES.map((f) => (
              <div key={f.label} className={styles.figCell}>
                <dt className={styles.figValue}>{f.value}</dt>
                <dd className={styles.figLabel}>{f.label}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.figNote}>Refreshed every morning.</p>
        </section>

        {/* ── Sources ledger (signature) ───────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>What we read</p>
            <h2 className={styles.sectionTitle}>Primary county filings, not a resold feed.</h2>
            <p className={styles.sectionLede}>
              Every source is a public record gathered the morning it posts. That
              puts distress in front of you before the weekly aggregators refresh.
            </p>
          </div>

          <table className={styles.ledger}>
            <thead>
              <tr>
                <th scope="col" className={styles.ledgerColSignal}>
                  Signal
                </th>
                <th scope="col" className={styles.ledgerColAuthority}>
                  Authority of record
                </th>
                <th scope="col" className={styles.ledgerColCount}>
                  Signals
                </th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((s) => (
                <tr key={s.signal}>
                  <th scope="row" className={styles.ledgerSignal}>
                    {s.signal}
                  </th>
                  <td className={styles.ledgerAuthority}>{s.authority}</td>
                  <td className={styles.ledgerCount}>
                    {s.live ? (
                      <span className={styles.liveTag}>
                        <span className={styles.liveDot} aria-hidden="true" />
                        Live
                      </span>
                    ) : (
                      s.count
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={styles.ledgerSignal}>
                  9 sources
                </th>
                <td className={styles.ledgerAuthority}>
                  Treasurer, Recorder, Superior Court, six code jurisdictions
                </td>
                <td className={styles.ledgerCount}>Daily</td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* ── How it works ─────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>How it works</p>
            <h2 className={styles.sectionTitle}>Ingest, match, rank.</h2>
            <p className={styles.sectionLede}>
              No manual pulls, no spreadsheets. The pipeline runs every morning
              and hands you a ranked list of who to call first.
            </p>
          </div>
          <ol className={styles.steps}>
            {STEPS.map((s) => (
              <li key={s.n} className={styles.step}>
                <span className={styles.stepNum}>{s.n}</span>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <p className={styles.stepBody}>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Who it's for ─────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Who it is for</p>
            <h2 className={styles.sectionTitle}>Built for people who act on distress early.</h2>
          </div>
          <div className={styles.audiences}>
            {AUDIENCES.map((a) => (
              <div key={a.who} className={styles.audience}>
                <h3 className={styles.audienceWho}>{a.who}</h3>
                <p className={styles.audienceBody}>{a.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Questions</p>
            <h2 className={styles.sectionTitle}>Before you ask.</h2>
          </div>
          <div className={styles.faq}>
            {FAQ.map((f) => (
              <details key={f.q} className={styles.faqItem}>
                <summary className={styles.faqQ}>
                  {f.q}
                  <span className={styles.faqSign} aria-hidden="true" />
                </summary>
                <p className={styles.faqA}>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── CTA + three views ────────────────────────────── */}
        <section className={styles.cta} id="request-access">
          <div className={styles.ctaInner}>
            <div className={styles.ctaLede}>
              <p className={styles.eyebrow}>Request access</p>
              <h2 className={styles.ctaTitle}>See today&rsquo;s Maricopa County leads.</h2>
              <p className={styles.sectionLede}>
                Today&rsquo;s list is live, and new filings post every morning.
                Three views on the same daily data: scan the ranked index, open
                any parcel as a dossier, or read the whole county on the map.
              </p>
              <RequestAccessForm />
              <p className={styles.ctaReassure}>
                Look before you commit. The ranked index and a sample dossier are
                open to browse.
              </p>
            </div>
            <ul className={styles.viewList}>
              {VIEWS.map((v) => (
                <li key={v.href} className={styles.viewItem}>
                  <a href={v.href} className={styles.viewLink}>
                    <span className={styles.viewName}>{v.name}</span>
                    <span className={styles.viewDesc}>{v.desc}</span>
                    <span className={styles.viewArrow} aria-hidden="true">
                      &rarr;
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmarkText}>MotivatedSignal</span>
          </div>
          <p className={styles.footerNote}>
            Motivated-seller data for Maricopa County, Arizona. Sourced from
            county public records, refreshed daily.
          </p>
        </div>
      </footer>
    </div>
  );
}
