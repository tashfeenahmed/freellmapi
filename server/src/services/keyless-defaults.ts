// No-key providers on by default (#1870).
//
// Providers that work without an account (Kilo, OVH, AI Horde, ...) used to
// stay off until someone found them on the Keys page and pressed Enable, so a
// fresh install opened on "No models configured". Now:
//
//  - A NEW install enables them itself, once, right after its first catalog
//    sync. Only providers that install's catalog lists are enabled, and the
//    catalog server decides that per tier: Premium gets the live catalog, free
//    installs get rows only once they are 30 days old. So a free install never
//    gets a provider early, and a Premium one gets it straight away.
//  - An EXISTING install changes nothing on its own. The Keys page shows how
//    many no-key providers its catalog offers that it has not added, with an
//    "Enable all" action and a dismiss.
//
// Either way a provider the user removed or switched off stays that way: the
// automatic step runs once, and "available" skips any platform that already
// has a key row (enabled or not) or that the user dismissed.
import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { getAllProviders } from '../providers/index.js';

// Set once by initDb: 'pending' on a brand-new database, 'skip' otherwise.
const SETTING_STATE = 'keyless_defaults';
const SETTING_DISMISSED = 'keyless_notice_dismissed';
const SETTING_APPLIED_JSON = 'catalog_applied_json';

type State = 'pending' | 'done' | 'skip';

interface CatalogRows {
  models?: { platform: string; enabled?: boolean }[];
  embeddings?: { platform: string; enabled?: boolean }[];
  transcriptionModels?: { platform: string; enabled?: boolean }[];
  videoModels?: { platform: string; enabled?: boolean }[];
  searchEngines?: { platform: string; enabled?: boolean }[];
  decisionModels?: { platform: string; enabled?: boolean }[];
}

function keylessPlatforms(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of getAllProviders()) if (p.keyless) out.set(p.platform, p.name);
  return out;
}

/**
 * No-key platforms a catalog document serves. Counts enabled rows only, so a
 * platform the free tier has not reached yet (its rows are still inside the
 * 30-day window) is not in a free catalog at all.
 */
export function keylessPlatformsInCatalog(catalog: CatalogRows): string[] {
  const keyless = keylessPlatforms();
  const found = new Set<string>();
  const lists = [
    catalog.models, catalog.embeddings, catalog.transcriptionModels,
    catalog.videoModels, catalog.searchEngines, catalog.decisionModels,
  ];
  for (const rows of lists) {
    for (const row of rows ?? []) {
      if (row.enabled !== false && keyless.has(row.platform)) found.add(row.platform);
    }
  }
  return [...found].sort();
}

function platformsWithKeys(db: Db): Set<string> {
  const rows = db.prepare('SELECT DISTINCT platform FROM api_keys').all() as { platform: string }[];
  return new Set(rows.map(r => r.platform));
}

function addSentinelKey(db: Db, platform: string): void {
  // Same row the Keys page's keyless "Enable" creates: the 'no-key' sentinel,
  // which routing treats as configured and the provider calls anonymously.
  const { encrypted, iv, authTag } = encrypt('no-key');
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, '', ?, ?, ?, 'unknown', 1)
  `).run(platform, encrypted, iv, authTag);
}

/**
 * Run after every verified catalog fetch. On a new install that has not done so
 * yet, enable the no-key providers this catalog lists; otherwise do nothing.
 * Returns the platforms it enabled.
 */
export function applyKeylessDefaults(catalog: CatalogRows, db: Db = getDb()): string[] {
  if ((getSetting(SETTING_STATE) as State | undefined) !== 'pending') return [];
  const existing = platformsWithKeys(db);
  const toAdd = keylessPlatformsInCatalog(catalog).filter(p => !existing.has(p));
  db.transaction(() => {
    for (const platform of toAdd) addSentinelKey(db, platform);
    setSetting(SETTING_STATE, 'done');
  })();
  if (toAdd.length > 0) console.log(`[keyless] new install: enabled ${toAdd.length} no-key provider(s): ${toAdd.join(', ')}`);
  return toAdd;
}

function appliedCatalog(db: Db): CatalogRows | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_APPLIED_JSON) as { value: string } | undefined;
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as CatalogRows; } catch { return null; }
}

function dismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(getSetting(SETTING_DISMISSED) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []);
  } catch { return new Set(); }
}

/**
 * No-key providers the applied catalog offers that this install has not added
 * and has not dismissed: what the Keys page notice counts.
 */
export function availableKeylessProviders(db: Db = getDb()): { platform: string; name: string }[] {
  const catalog = appliedCatalog(db);
  if (!catalog) return [];
  const names = keylessPlatforms();
  const existing = platformsWithKeys(db);
  const hidden = dismissed();
  return keylessPlatformsInCatalog(catalog)
    .filter(p => !existing.has(p) && !hidden.has(p))
    .map(platform => ({ platform, name: names.get(platform) ?? platform }));
}

/** "Enable all": add every available no-key provider. Returns what it added. */
export function enableAvailableKeylessProviders(db: Db = getDb()): string[] {
  const platforms = availableKeylessProviders(db).map(p => p.platform);
  db.transaction(() => { for (const platform of platforms) addSentinelKey(db, platform); })();
  return platforms;
}

/** Hide the notice for the providers it shows now; a later arrival shows again. */
export function dismissAvailableKeylessProviders(db: Db = getDb()): void {
  const next = dismissed();
  for (const p of availableKeylessProviders(db)) next.add(p.platform);
  setSetting(SETTING_DISMISSED, JSON.stringify([...next].sort()));
}
