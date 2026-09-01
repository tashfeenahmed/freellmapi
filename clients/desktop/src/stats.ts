import { getDb } from './server.mjs';

export interface TodayStats {
  requests: number;
  tokens: number;
  lastModel: string;
}

// Direct SQL on the server bundle's own connection — no HTTP, no auth, no
// second better-sqlite3 handle (avoids WAL writer contention). `created_at`
// is stored as UTC text; compare in localtime so "today" matches the menu
// bar's wall clock.
export function todayStats(): TodayStats {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens
      FROM requests
      WHERE datetime(created_at, 'localtime') >= datetime('now', 'localtime', 'start of day')
    `).get() as { requests: number; tokens: number };
    const last = db.prepare(
      'SELECT model_id FROM requests ORDER BY id DESC LIMIT 1',
    ).get() as { model_id?: string } | undefined;
    return { requests: row.requests, tokens: row.tokens, lastModel: last?.model_id ?? '—' };
  } catch {
    return { requests: 0, tokens: 0, lastModel: '—' };
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// 24 hourly buckets, oldest → newest, for the popover chart. created_at is
// UTC "YYYY-MM-DD HH:MM:SS" text — parse with an explicit Z.
export function hourlyRequests(): number[] {
  const buckets = new Array<number>(24).fill(0);
  try {
    const rows = getDb().prepare(
      "SELECT created_at FROM requests WHERE created_at >= datetime('now', '-24 hours')",
    ).all() as { created_at: string }[];
    const now = Date.now();
    for (const r of rows) {
      const t = Date.parse(r.created_at.replace(' ', 'T') + 'Z');
      if (Number.isNaN(t)) continue;
      const hoursAgo = Math.floor((now - t) / 3_600_000);
      if (hoursAgo >= 0 && hoursAgo < 24) buckets[23 - hoursAgo]++;
    }
  } catch {
    // fresh DB / no requests table content — all zeros is fine
  }
  return buckets;
}

export function successRateToday(): number | null {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok
      FROM requests
      WHERE datetime(created_at, 'localtime') >= datetime('now', 'localtime', 'start of day')
    `).get() as { total: number; ok: number };
    if (!row.total) return null;
    return Math.round((row.ok / row.total) * 100);
  } catch {
    return null;
  }
}
