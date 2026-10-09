// Client-safe helper for the /api/actions endpoint.
// No server imports — plain fetch only.

export async function setAction(
  apn: string,
  action: 'saved' | 'hidden',
  on: boolean
): Promise<void> {
  const res = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apn, action, on }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`setAction failed: ${err.error ?? res.statusText}`);
  }
}

export async function getActions(): Promise<{ saved: string[]; hidden: string[] }> {
  const res = await fetch('/api/actions');
  if (!res.ok) {
    throw new Error(`getActions failed: ${res.statusText}`);
  }
  return res.json();
}
