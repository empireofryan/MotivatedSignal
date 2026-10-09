'use client';

import { useRouter } from 'next/navigation';
import { track } from '../../../components/Tracker';
import s from './report.module.css';

// First-visit trial orientation block, shown above the hot-stacks strip until
// dismissed. Dismissal is a plain cookie (not localStorage, per project
// rule) so it survives across devices only as far as the cookie does — good
// enough for "don't show this again on this browser." page.tsx reads the
// cookie server-side and skips rendering this component entirely once set,
// so there is no flash; the dismiss button just needs to trigger that re-read.
const DISMISS_COOKIE = 'ms_welcome_dismissed';
const DISMISS_MAX_AGE_DAYS = 30;

const HOW_TO: string[] = [
  'Start with the hottest stacks',
  'Expand any row for the source document',
  'Export to BatchLeads or PropStream for phones',
];

export default function TrialWelcome({
  trialEndLabel,
  checkoutHref,
}: {
  trialEndLabel: string | null;
  checkoutHref: string;
}) {
  const router = useRouter();

  function dismiss() {
    try {
      document.cookie = `${DISMISS_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * DISMISS_MAX_AGE_DAYS}; samesite=lax`;
    } catch {
      // Cookies blocked: the strip just won't stay dismissed across reloads.
    }
    router.refresh();
  }

  return (
    <section className={s.welcome} aria-label="Welcome to your trial">
      <button type="button" className={s.welcomeDismiss} onClick={dismiss} aria-label="Dismiss this welcome message">
        &times;
      </button>
      <p className={s.welcomeLede}>
        Every Maricopa distress filing from 10 county and court sources, ranked, with the document
        to prove it.
      </p>
      <ol className={s.welcomeHints}>
        {HOW_TO.map((hint, i) => (
          <li key={hint}>
            <span className={s.welcomeHintNum} aria-hidden="true">{i + 1}</span>
            {hint}
          </li>
        ))}
      </ol>
      <div className={s.welcomeFoot}>
        {trialEndLabel ? <span className={s.welcomeUntil}>Trial through {trialEndLabel}</span> : null}
        <a
          className={s.welcomeCta}
          href={checkoutHref}
          onClick={() => track('trial_welcome_cta_click', { href: checkoutHref })}
        >
          Keep it for $99/mo
        </a>
      </div>
    </section>
  );
}
