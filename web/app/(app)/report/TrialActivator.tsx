'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Starts the prospect's free week on the first real human input. /r/<code> no longer grants the
// trial because mail-gateway sandboxes open every emailed link within a minute and never touch the
// page; they would otherwise burn the prospect's one trial. Programmatic scrolls don't count, only
// trusted pointer movement (with real distance), taps, wheel and keys. Rendered only for visitors
// carrying a valid ms_pid cookie and no trial yet.
const MIN_POINTER_PX = 40;

export default function TrialActivator() {
  const router = useRouter();

  useEffect(() => {
    let done = false;
    let lastX: number | null = null;
    let lastY: number | null = null;
    let moved = 0;

    const activate = (e: Event) => {
      if (done || !e.isTrusted) return;
      done = true;
      cleanup();
      fetch('/api/trial/activate', { method: 'POST', credentials: 'same-origin' })
        .then((r) => (r.ok ? router.refresh() : undefined))
        .catch(() => {});
    };
    const onMove = (e: PointerEvent) => {
      if (!e.isTrusted) return;
      if (lastX != null && lastY != null) moved += Math.hypot(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
      if (moved >= MIN_POINTER_PX) activate(e);
    };
    const direct = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      direct.forEach((t) => window.removeEventListener(t, activate));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    direct.forEach((t) => window.addEventListener(t, activate, { passive: true }));
    return cleanup;
  }, [router]);

  return null;
}
