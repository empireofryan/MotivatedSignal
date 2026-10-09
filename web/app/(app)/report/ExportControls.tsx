'use client';

import { useState } from 'react';
import { track } from '../../../components/Tracker';
import s from './report.module.css';

// Format dropdown + Export button, next to the filter chips. Pro-only (the
// page only renders this branch when isPro); free visitors still see the
// plain disabled "Export CSV" look-alike. `baseParams` carries the current
// window/filed/homeowners selection so the export always matches what's on
// screen — only `format` changes client-side.
const FORMATS: { key: string; label: string }[] = [
  { key: 'csv', label: 'CSV' },
  { key: 'batchleads', label: 'BatchLeads' },
  { key: 'propstream', label: 'PropStream' },
];

export default function ExportControls({ baseParams }: { baseParams: Record<string, string> }) {
  const [format, setFormat] = useState('csv');
  const q = new URLSearchParams(baseParams);
  if (format !== 'csv') q.set('format', format);
  const href = `/api/report/export?${q.toString()}`;
  const label = FORMATS.find((f) => f.key === format)?.label ?? 'CSV';

  return (
    <div className={s.exportGroup}>
      <select
        className={s.exportSelect}
        value={format}
        onChange={(e) => setFormat(e.target.value)}
        aria-label="Export format"
      >
        {FORMATS.map((f) => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
      <a
        className={s.exportBtn}
        href={href}
        onClick={() => track('report_export_click', { format, ...baseParams })}
      >
        Export {label}
      </a>
    </div>
  );
}
