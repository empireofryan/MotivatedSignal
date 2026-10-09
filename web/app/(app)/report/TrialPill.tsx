'use client';

import { track } from '../../../components/Tracker';
import s from './report.module.css';

// Persistent conversion nudge, up for the whole trial (not dismissible,
// unlike TrialWelcome). A tiny client wrapper around what would otherwise
// be a plain server-rendered <a> purely so the click can call track().
export default function TrialPill({
  daysLeft,
  checkoutHref,
}: {
  daysLeft: number;
  checkoutHref: string;
}) {
  return (
    <a
      className={s.trialPill}
      href={checkoutHref}
      onClick={() => track('trial_pill_click', { href: checkoutHref, daysLeft })}
    >
      Trial: {daysLeft} day{daysLeft === 1 ? '' : 's'} left &middot; Keep it $99/mo
    </a>
  );
}
