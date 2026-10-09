'use client';

import { useState } from 'react';
import styles from './page.module.css';

const SEGMENTS = [
  { value: 'wholesaler', label: 'Wholesaler' },
  { value: 'lender', label: 'Hard-money lender' },
  { value: 'attorney', label: 'Probate attorney' },
];

export default function RequestAccessForm() {
  const [email, setEmail] = useState('');
  const [segment, setSegment] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'sending') return;
    const honeypot = (new FormData(e.currentTarget).get('company') as string) ?? '';
    setStatus('sending');
    try {
      const res = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, segment, source: 'landing', company: honeypot }),
      });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className={styles.formDone} role="status">
        <span className={styles.formDoneMark} aria-hidden="true">
          &#10003;
        </span>
        <div>
          <p className={styles.formDoneTitle}>You&rsquo;re on the list.</p>
          <p className={styles.formDoneBody}>
            We&rsquo;ll reach out at <strong>{email}</strong> as seats open up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.accessForm} onSubmit={submit} id="request-access-form">
      <div className={styles.formRow}>
        <label htmlFor="ra-email" className={styles.srOnly}>
          Work email
        </label>
        <input
          id="ra-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className={styles.emailInput}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === 'sending'}
        />
        <button type="submit" className={styles.btnPrimary} disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Request access'}
        </button>
      </div>

      {/* Honeypot — hidden from humans, tempting to bots */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        className={styles.honeypot}
        aria-hidden="true"
      />

      <fieldset className={styles.segmentRow}>
        <legend className={styles.segmentLegend}>I&rsquo;m a&hellip; (optional)</legend>
        {SEGMENTS.map((s) => (
          <button
            key={s.value}
            type="button"
            className={`${styles.segmentPill} ${segment === s.value ? styles.segmentPillOn : ''}`}
            aria-pressed={segment === s.value}
            onClick={() => setSegment(segment === s.value ? null : s.value)}
          >
            {s.label}
          </button>
        ))}
      </fieldset>

      {status === 'error' && (
        <p className={styles.formError} role="alert">
          Something went wrong on our end. Try again in a minute.
        </p>
      )}
    </form>
  );
}
