'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import s from './admin.module.css';

type Campaign = { id: number; name: string; touch: number };

export function CampaignSelect({ campaigns, selectedId, adminKey }: { campaigns: Campaign[]; selectedId: number; adminKey: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function go(campaignId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('key', adminKey);
    params.set('campaign', campaignId);
    router.push(`/admin?${params.toString()}`);
  }

  return (
    <select
      className={s.select}
      value={selectedId}
      onChange={(e) => go(e.target.value)}
      aria-label="Campaign"
    >
      {campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} (touch {c.touch})
        </option>
      ))}
    </select>
  );
}

export function SegmentSelect({ segments, selected, adminKey }: { segments: string[]; selected: string; adminKey: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function go(segment: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('key', adminKey);
    if (segment) params.set('segment', segment);
    else params.delete('segment');
    router.push(`/admin?${params.toString()}#send-sheet`);
  }

  return (
    <select className={s.select} value={selected} onChange={(e) => go(e.target.value)} aria-label="Filter by segment">
      <option value="">All segments</option>
      {segments.map((seg) => (
        <option key={seg} value={seg}>
          {seg}
        </option>
      ))}
    </select>
  );
}

export function AssignVariantsButton({ adminKey }: { adminKey: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setResult(null);
    try {
      const res = await fetch('/api/admin/assign-variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { updated?: number; error?: string };
      if (!res.ok) {
        setResult(data.error ?? 'failed');
        return;
      }
      setResult(data.updated ? `assigned ${data.updated}` : 'nothing to assign');
      startTransition(() => router.refresh());
    } catch {
      setResult('failed');
    }
  }

  return (
    <div className={s.inlineAction}>
      <button type="button" className={s.btn} onClick={run} disabled={pending}>
        Assign variants
      </button>
      {result && <span className={s.dim}>{result}</span>}
    </div>
  );
}

export function NewCampaignForm({ adminKey }: { adminKey: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [touch, setTouch] = useState(1);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch('/api/admin/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ name, touch }),
      });
      const data = (await res.json()) as { id?: number; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? 'failed');
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.set('campaign', String(data.id));
      router.push(`/admin?${params.toString()}`);
      setOpen(false);
      setName('');
    } catch {
      setError('failed');
    }
  }

  if (!open) {
    return (
      <button type="button" className={s.btnGhost} onClick={() => setOpen(true)}>
        + New campaign
      </button>
    );
  }

  return (
    <form className={s.inlineAction} onSubmit={submit}>
      <input
        className={s.textInput}
        placeholder="Touch 2 · Oct 2026"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        className={s.numInput}
        type="number"
        min={1}
        value={touch}
        onChange={(e) => setTouch(Number(e.target.value))}
        aria-label="Touch number"
      />
      <button type="submit" className={s.btn}>
        Create
      </button>
      {error && <span className={s.dim}>{error}</span>}
    </form>
  );
}
