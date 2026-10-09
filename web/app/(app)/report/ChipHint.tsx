'use client';

import { useLinkStatus } from 'next/link';
import s from './report.module.css';

// Subtle pending dot for the filter chips (window/filed/homeowners). Chips
// are prefetched, so this should rarely show — it only fires on a cache miss
// or slow network, confirming the click landed instead of leaving the chip
// looking unresponsive. Fixed-size + reserved space so it never shifts layout.
export default function ChipHint() {
  const { pending } = useLinkStatus();
  return <span aria-hidden className={`${s.chipHint} ${pending ? s.chipHintPending : ''}`} />;
}
