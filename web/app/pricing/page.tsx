import type { Metadata } from 'next';
import Link from 'next/link';
import s from './pricing.module.css';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'MotivatedSignal Pro: the full daily Maricopa County motivated-seller report, $99 a month.',
};
export const dynamic = 'force-dynamic';

export default function PricingPage() {
  const checkout = process.env.STRIPE_PRO_LINK || '/#request-access';
  return (
    <div className={s.page}>
      <header className={s.nav}>
        <div className={s.navInner}>
          <Link href="/" className={s.wordmark}>Motivated<span>Signal</span></Link>
          <a href="/report" className={s.navLink}>Today’s report</a>
        </div>
      </header>

      <main className={s.wrap}>
        <div className={s.head}>
          <h1 className={s.title}>One plan. The whole county, every morning.</h1>
          <p className={s.lede}>
            Maricopa County’s new distress filings, matched to the owner and ranked on the web,
            days before the weekly lists have them. Cancel any time.
          </p>
        </div>

        <div className={s.plans}>
          <section className={`${s.plan} ${s.planPro}`}>
            <p className={s.planName}>Pro</p>
            <div className={s.price}>
              <span className={s.priceNum}>$99</span>
              <span className={s.pricePer}>per month, cancel any time</span>
            </div>
            <p className={s.planBlurb}>Everything the pipeline finds, ranked, with the document to prove it.</p>
            <ul className={s.list}>
              <li>7 signal types, including court probate and divorce, and six city code-enforcement systems</li>
              <li>A recorder document number or court case number on every row, linked to the source</li>
              <li>Refreshed every morning after the county posts, up to 50 leads a day, not 10</li>
              <li>Mailing address for every absentee owner, assessed value, and years owned</li>
              <li>CSV export pre-mapped for BatchLeads and PropStream skip tracing</li>
              <li>25 Pro seats in Maricopa County, then a waitlist</li>
            </ul>
            <p className={s.honest}>Phone numbers are not included; export to the skip-trace tool you already use.</p>
            <a href={checkout} className={`${s.cta} ${s.ctaPro}`}>Subscribe for $99/month</a>
            <p className={s.fine}>Secure checkout by Stripe. Monthly, cancel any time. Your access link arrives by email the same day.</p>
          </section>
        </div>

        <section className={s.sample} aria-label="Sample lead">
          <p className={s.sampleTitle}>What a Pro row looks like</p>
          <div className={s.row}>
            <span className={s.score}>165</span>
            <span>
              <span className={s.addr}>4742 W El Caminito Dr</span>
              <span className={s.sub}>Glendale, owner-occupied, $351k assessed, owned 2 yrs</span>
            </span>
            <span>
              <span className={s.tag}>Trustee sale</span>
              <span className={s.tag}>Probate</span>
              <span className={`${s.tag} ${s.tagQuiet}`}>Code violation</span>
            </span>
            <span className={s.lock}>Mailing address <b>included</b></span>
            <span className={s.lock}>Source doc <b>linked</b></span>
          </div>
          <p className={s.sampleNote}>A real row from a recent report. Three filings on one house; no single list would have shown it.</p>
        </section>

        <section className={s.faq}>
          <h2>Questions</h2>
          <div className={s.qa}>
            <h3>Can I cancel any time?</h3>
            <p>Yes. It is a month-to-month subscription with no contract. Cancel from your Stripe receipt, or email hello@motivatedsignal.com and it stops at the end of the billing period.</p>
          </div>
          <div className={s.qa}>
            <h3>What counties does this cover?</h3>
            <p>Maricopa County only, today: the Treasurer, the Recorder, the Superior Court dockets, and six city code-enforcement systems. Other counties aren’t built yet.</p>
          </div>
          <div className={s.qa}>
            <h3>Do you include phone numbers?</h3>
            <p>No. Every row is pre-mapped for CSV export to BatchLeads or PropStream, so you can skip-trace with the tool you already pay for.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
