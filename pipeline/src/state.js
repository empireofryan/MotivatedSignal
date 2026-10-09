/** Scraper resume state — tiny key/JSONB store on top of scraper_state. */

import { query } from './db.js';

export async function getState(key) {
  const { rows } = await query('SELECT value FROM scraper_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setState(key, value) {
  await query(
    `INSERT INTO scraper_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}
