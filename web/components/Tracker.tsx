'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// Tracker — mounted once in web/app/layout.tsx. First-party analytics only (Turso-backed via
// POST /api/track), no third-party service. Logs, for every page except /admin:
//   - `pageview`      (path, referrer) on mount and every client-side route change
//   - `engaged_time`  (ms visible + active) accumulated via visibilitychange + a 15s heartbeat
//                      while visible, flushed via sendBeacon on pagehide/hide/route change
//   - `scroll_depth`  max scroll % reached this page, fired once each at 25/50/75/100
//
// Other components call the exported `track()` helper for custom events on the current page —
// e.g. track('row_expand', { apn }), track('export_click'), track('cta_click', { label }).
//
//   track(event: string, meta?: Record<string, unknown>): void
//
// Identity: the visitor id (`ms_vid` cookie) and prospect id (signed `ms_pid` cookie, verified in
// /api/track) are set server-side — this component never reads or writes them, it only POSTs
// events and lets same-origin requests carry the cookies automatically.

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'] as const;
const HEARTBEAT_MS = 15_000;
const IDLE_AFTER_MS = 60_000;
const SCROLL_THRESHOLDS = [25, 50, 75, 100];

let moduleSessionId: string | null = null;

function getSessionId(): string {
  if (typeof window === 'undefined') return 'ssr';
  if (!moduleSessionId) {
    moduleSessionId =
      typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return moduleSessionId;
}

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

function send(payload: Record<string, unknown>, useBeacon: boolean): void {
  if (typeof window === 'undefined') return;
  const path = currentPath();
  if (path.startsWith('/admin')) return;

  let body: string;
  try {
    body = JSON.stringify({ sessionId: getSessionId(), path, ...payload });
  } catch {
    return;
  }

  try {
    if (useBeacon && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/track', blob)) return;
    }
  } catch {
    // fall through to fetch
  }

  try {
    void fetch('/api/track', {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch {
    // tracking must never throw into the caller
  }
}

/** Log a custom event on the current page. No-ops under /admin and never throws — safe to call
 * from any client component without a guard. */
export function track(event: string, meta?: Record<string, unknown>): void {
  send({ event, meta }, false);
}

export default function Tracker() {
  const pathname = usePathname();
  const engagedMsRef = useRef(0);
  const lastActivityRef = useRef(0);
  const scrollMaxRef = useRef(0);
  const scrollFiredRef = useRef<Set<number>>(new Set());

  // Pageview + per-page state reset on every route change.
  useEffect(() => {
    if (!pathname || pathname.startsWith('/admin')) return;
    send(
      { event: 'pageview', meta: { referrer: typeof document !== 'undefined' ? document.referrer : null } },
      false
    );
    scrollMaxRef.current = 0;
    scrollFiredRef.current = new Set();
    engagedMsRef.current = 0;
    lastActivityRef.current = Date.now();
  }, [pathname]);

  // Activity tracking + 15s heartbeat + flush on hide/pagehide/route change.
  useEffect(() => {
    if (!pathname || pathname.startsWith('/admin')) return;

    const markActive = () => {
      lastActivityRef.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));

    const flush = (useBeacon: boolean) => {
      if (engagedMsRef.current <= 0) return;
      send({ event: 'engaged_time', ms: engagedMsRef.current }, useBeacon);
      engagedMsRef.current = 0;
    };

    const heartbeat = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivityRef.current > IDLE_AFTER_MS) return;
      engagedMsRef.current += HEARTBEAT_MS;
      flush(false);
    }, HEARTBEAT_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    const onPageHide = () => flush(true);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      clearInterval(heartbeat);
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, markActive));
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      flush(true);
    };
  }, [pathname]);

  // Scroll depth: max % reached this page, each threshold fired at most once.
  useEffect(() => {
    if (!pathname || pathname.startsWith('/admin')) return;

    const onScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const pct = scrollable > 0 ? Math.min(100, Math.round((window.scrollY / scrollable) * 100)) : 100;
      if (pct <= scrollMaxRef.current) return;
      scrollMaxRef.current = pct;
      for (const threshold of SCROLL_THRESHOLDS) {
        if (pct >= threshold && !scrollFiredRef.current.has(threshold)) {
          scrollFiredRef.current.add(threshold);
          send({ event: 'scroll_depth', meta: { depth: threshold } }, false);
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pathname]);

  return null;
}
