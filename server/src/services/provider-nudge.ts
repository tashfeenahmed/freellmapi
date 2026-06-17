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

export interface NudgeState {
  disabled: boolean;
  muted: string[];
  snoozed: string[];
}

const KEY_DISABLED = 'nudge_disabled';
const KEY_MUTED = 'nudge_muted_platforms';
const KEY_SNOOZED = 'nudge_snoozed_platforms';

function readList(key: string): string[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getNudgeState(): NudgeState {
  return {
    disabled: getSetting(KEY_DISABLED) === '1',
    muted: readList(KEY_MUTED),
    snoozed: readList(KEY_SNOOZED),
  };
}

export function dismissNudge(scope: 'snooze' | 'mute' | 'disable', platform?: string): void {
  if (scope === 'disable') {
    setSetting(KEY_DISABLED, '1');
    return;
  }
  if (scope === 'mute') {
    if (!platform) throw new Error('mute requires a platform');
    const muted = new Set(readList(KEY_MUTED));
    muted.add(platform);
    setSetting(KEY_MUTED, JSON.stringify([...muted]));
    return;
  }
  // snooze: snapshot the currently-shown set (raw unconfigured minus muted) so a
  // later brand-new unconfigured provider is absent and re-triggers the banner.
  const muted = new Set(readList(KEY_MUTED));
  const shown = getUnconfiguredProviders().map(p => p.platform).filter(p => !muted.has(p));
  setSetting(KEY_SNOOZED, JSON.stringify(shown));
}

/** Drop a platform from mute + snooze sets (called when its key is added). */
export function pruneNudgeState(platform: string): void {
  setSetting(KEY_MUTED, JSON.stringify(readList(KEY_MUTED).filter(p => p !== platform)));
  setSetting(KEY_SNOOZED, JSON.stringify(readList(KEY_SNOOZED).filter(p => p !== platform)));
}
