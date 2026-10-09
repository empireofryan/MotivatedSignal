import type { Metadata } from 'next';
import Link from 'next/link';
import s from '../pricing/pricing.module.css';

export const metadata: Metadata = { title: 'Welcome to Pro' };

export default function WelcomePage() {
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
          <h1 className={s.title}>You’re in. Your access link is on its way.</h1>
          <p className={s.lede}>
            I’ll email your private report link from hello@motivatedsignal.com later today. Open it
            once and the full report stays unlocked on this browser, refreshed every morning after
            the county posts.
          </p>
          <p className={s.lede}>
            Didn’t get it, or want it sent somewhere else? Reply to your Stripe receipt or write to{' '}
            <a href="mailto:hello@motivatedsignal.com">hello@motivatedsignal.com</a>. A person answers.
          </p>
          <a href="/report" className={`${s.cta} ${s.ctaFree}`} style={{ width: 'auto', marginTop: 28 }}>
            Open today’s report
          </a>
        </div>
      </main>
    </div>
  );
}
