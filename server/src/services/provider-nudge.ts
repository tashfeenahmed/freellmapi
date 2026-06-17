import type { Platform } from '@freellmapi/shared/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getAllProviders } from '../providers/index.js';

export interface UnconfiguredProvider {
  platform: string;
  name: string;
  models: number;
}

/**
 * Providers with at least one enabled model and no enabled key — the RAW list,
 * with NO mute/snooze/disable filtering applied (that is banner-only display
 * state, derived on the frontend). Excludes `custom`, keyless providers (they
 * route without a key), and platforms this binary can't route.
 */
export function getUnconfiguredProviders(): UnconfiguredProvider[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.platform AS platform, COUNT(*) AS models
    FROM models m
    WHERE m.enabled = 1 AND m.platform != 'custom'
      AND NOT EXISTS (
        SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1
      )
    GROUP BY m.platform
  `).all() as { platform: string; models: number }[];

  const byPlatform = new Map(getAllProviders().map(p => [p.platform, p]));
  const out: UnconfiguredProvider[] = [];
  for (const r of rows) {
    const provider = byPlatform.get(r.platform as Platform);
    if (!provider) continue;        // not routable by this binary
    if (provider.keyless) continue; // routes without a key — nothing to nudge
    out.push({ platform: r.platform, name: provider.name, models: r.models });
  }
  return out;
}
