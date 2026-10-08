import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { discoverProviderModels, type DiscoveredModel } from './model-discovery.js';
import { appliedCatalogPlatforms, DISCOVERED_MODEL_SOURCE } from './catalog-sync.js';
import { clearCatalogModelTombstone, isCatalogModelTombstoned } from './model-state.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';
import { customModelSyncFreePatterns, customModelSyncIntervalMs } from './custom-model-sync.js';

// ── Model discovery for built-in providers the catalog does not carry (#1348) ──
//
// Some registered OpenAI-compatible providers have NO rows in the signed
// catalog, so a healthy key for them served nothing and the dashboard had no
// way to fill the gap. This asks the provider's own /models (through the
// registered adapter, with the operator's own key) and registers what it
// serves, the same way custom-endpoint discovery (#488) does.
//
// The signed, audited catalog stays authoritative:
//  - Only an explicit allowlist of platforms is eligible. The rule behind the
//    list is "zero rows in the signed catalog on every tier". A free install
//    cannot see the Premium (live) catalog, so it cannot tell a provider the
//    catalog has never carried from one still inside its 30-day Premium window
//    (radeon, routeway) or one the audit keeps switched off with disabled rows
//    (reka, navy, opencode, orcarouter, xfyun). Discovering those would hand
//    free installs models the catalog gates or has ruled out, so the list is
//    decided here, in the binary, not inferred at runtime.
//  - Even an allowlisted platform stops being eligible the moment the applied
//    catalog manages it (any row, or a managedPlatforms entry), or the local
//    DB holds catalog-owned rows for it (the bundled baseline before the first
//    sync). catalog-sync then adopts or retires the discovered rows.
//  - Rows are written with models.source = 'discovered', never 'user': a
//    'user' row outranks the catalog on a collision, a discovered row never
//    does. Writes are INSERT-only: an existing row (catalog, user or an earlier
//    discovery the operator has since tuned) is never touched.
//  - Deleting a discovered model records a catalog tombstone (they count as
//    catalog-managed, see isCatalogManagedModel), and every automatic pass
//    honors it. Only an explicit pick in the dashboard lifts it.

/** Built-in platforms eligible for discovery. Each is OpenAI-compatible and has
 *  zero rows, enabled or disabled, in the signed live catalog (checked against
 *  2026.09.27). Remove a platform here in the same change that adds it to the
 *  catalog; managedPlatforms in the catalog covers binaries already shipped. */
export const BUILTIN_DISCOVERY_PLATFORMS: readonly Platform[] = ['github', 'longcat', 'siliconflow'];

/** `BUILTIN_MODEL_DISCOVERY`: 'manual' (default) keeps only the dashboard's
 *  Fetch models action, so nothing is registered without the operator picking
 *  it; 'auto' also discovers on key save, after a healthy check and on the
 *  custom-model sync cadence; 'off' disables both. Manual is the default
 *  because these providers bill funded accounts (SiliconFlow, LongCat) and
 *  label paid models inconsistently, so an automatic pass could route traffic
 *  to models that cost money. */
export type BuiltinDiscoveryMode = 'auto' | 'manual' | 'off';

export function builtinDiscoveryMode(): BuiltinDiscoveryMode {
  const raw = process.env.BUILTIN_MODEL_DISCOVERY?.trim().toLowerCase();
  if (raw === 'auto' || raw === 'off') return raw;
  if (raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  return 'manual';
}

export type IneligibleReason = 'disabled' | 'not_allowlisted' | 'not_openai_compatible' | 'catalog_managed';

export interface DiscoveryEligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  /** The registered adapter, when eligible. */
  provider?: OpenAICompatProvider;
}

/** Whether `platform` may fill its model list from its own /models. */
export function builtinDiscoveryEligibility(db: Db, platform: string): DiscoveryEligibility {
  if (builtinDiscoveryMode() === 'off') return { eligible: false, reason: 'disabled' };
  if (!(BUILTIN_DISCOVERY_PLATFORMS as readonly string[]).includes(platform)) {
    return { eligible: false, reason: 'not_allowlisted' };
  }
  const provider = getProvider(platform as Platform);
  if (!(provider instanceof OpenAICompatProvider)) return { eligible: false, reason: 'not_openai_compatible' };
  if (appliedCatalogPlatforms(db).has(platform) || hasCatalogOwnedRows(db, platform)) {
    return { eligible: false, reason: 'catalog_managed' };
  }
  return { eligible: true, provider };
}

export function isBuiltinDiscoveryEligible(db: Db, platform: string): boolean {
  return builtinDiscoveryEligibility(db, platform).eligible;
}

/** A human sentence for an ineligible platform, for route errors. */
export function ineligibleMessage(platform: string, reason: IneligibleReason | undefined): string {
  switch (reason) {
    case 'disabled':
      return 'Model discovery for built-in providers is turned off (BUILTIN_MODEL_DISCOVERY=off).';
    case 'catalog_managed':
      return `${platform} models come from the catalog, so they cannot be fetched from the provider.`;
    default:
      return `${platform} models come from the catalog, not from the provider's model list.`;
  }
}

// Catalog-owned rows for this platform in the local DB: chat rows the catalog
// (or the bundled baseline) wrote, or any embedding / media row, which only
// the catalog and the bundled baseline write for a built-in platform.
function hasCatalogOwnedRows(db: Db, platform: string): boolean {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM models           WHERE platform = ? AND source = 'catalog')
         + (SELECT COUNT(*) FROM embedding_models WHERE platform = ?)
         + (SELECT COUNT(*) FROM media_models     WHERE platform = ?) AS c
  `).get(platform, platform, platform) as { c: number };
  return row.c > 0;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  proxy_encrypted?: string | null;
  proxy_iv?: string | null;
  proxy_auth_tag?: string | null;
}

/** Fetch the platform's /models with one of its keys, through that key's own
 *  proxy (#590), exactly as the health check reaches it. */
export async function discoverBuiltinModels(
  provider: OpenAICompatProvider,
  key: KeyRow,
  apiKeyOverride?: string,
): Promise<DiscoveredModel[]> {
  const apiKey = apiKeyOverride?.trim() || decrypt(key.encrypted_key, key.iv, key.auth_tag);
  return withKeyProxy(decryptProxyUrl(key), () => discoverProviderModels(provider, apiKey, provider.modelsUrl.replace(/\/models\/?$/, '')));
}

/** Discovered model ids already present on this platform, in any provenance. */
export function registeredModelIds(db: Db, platform: string): Set<string> {
  return new Set(
    (db.prepare("SELECT model_id FROM models WHERE platform = ? AND endpoint_scope = ''").all(platform) as { model_id: string }[])
      .map(r => r.model_id),
  );
}

export interface DiscoveredEntry {
  modelId: string;
  contextWindow?: number;
  vision?: boolean;
}

export interface RegisterDiscoveredResult {
  created: string[];
  /** Already present (catalog, user or earlier discovery): left untouched. */
  existing: string[];
  /** Deleted by the operator and not lifted (automatic passes only). */
  tombstoned: string[];
}

/**
 * Insert discovered chat models for a built-in platform. INSERT-only: a row
 * that already exists for (platform, model_id) in the built-in scope is never
 * updated, so catalog rows, user rows and anything the operator tuned by hand
 * all win. `explicit` marks a pick the operator made in the dashboard, which
 * lifts a previous deletion, the way re-adding a custom model does (#926).
 */
export function registerDiscoveredModels(
  db: Db,
  platform: string,
  entries: DiscoveredEntry[],
  options: { explicit: boolean },
): RegisterDiscoveredResult {
  return db.transaction(() => {
    const result: RegisterDiscoveredResult = { created: [], existing: [], tombstoned: [] };
    const seed = customModelSeed(db);
    const exists = db.prepare("SELECT 1 FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''");
    const insert = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id,
         supports_tools, supports_vision, source, endpoint_scope)
      VALUES (@platform, @modelId, @modelId, @intelligenceRank, @speedRank, @sizeLabel,
         NULL, NULL, NULL, NULL, '', @contextWindow, 1, NULL,
         1, @vision, @source, '')
      ON CONFLICT(platform, model_id, endpoint_scope) DO NOTHING
    `);
    const selectId = db.prepare("SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''");
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?');
    const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config');
    const addToChain = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');

    for (const entry of entries) {
      if (exists.get(platform, entry.modelId)) {
        result.existing.push(entry.modelId);
        continue;
      }
      if (isCatalogModelTombstoned(db, 'chat', platform, entry.modelId)) {
        if (!options.explicit) {
          result.tombstoned.push(entry.modelId);
          continue;
        }
        clearCatalogModelTombstone(db, 'chat', platform, entry.modelId);
      }
      insert.run({
        platform,
        modelId: entry.modelId,
        intelligenceRank: seed.intelligenceRank,
        speedRank: seed.speedRank,
        sizeLabel: seed.sizeLabel,
        contextWindow: entry.contextWindow ?? null,
        vision: entry.vision ? 1 : 0,
        source: DISCOVERED_MODEL_SOURCE,
      });
      const row = selectId.get(platform, entry.modelId) as { id: number };
      if (!inChain.get(row.id)) {
        addToChain.run(row.id, (maxPriority.get() as { m: number }).m + 1);
      }
      ensureModelInProfiles(db, row.id);
      result.created.push(entry.modelId);
    }
    return result;
  })();
}

/** Glob match where `*` matches any run of chars (incl. empty). */
function patternMatches(pattern: string, id: string): boolean {
  const escaped = pattern.split('*').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(id);
}

/**
 * Which discovered models an AUTOMATIC pass may register. Stricter than a
 * dashboard pick, because nobody looked at the list:
 *  - chat only: embedding, image, audio, transcription and video ids are
 *    skipped (#1051), as in the custom-model sync;
 *  - an upstream that prices a model and says it is not free is skipped;
 *  - CUSTOM_MODEL_SYNC_FREE_PATTERNS, when set, applies here too (#746).
 */
export function autoRegistrable(models: DiscoveredModel[]): { accepted: DiscoveredModel[]; nonChat: number; paid: number } {
  const freePatterns = customModelSyncFreePatterns();
  const accepted: DiscoveredModel[] = [];
  let nonChat = 0;
  let paid = 0;
  for (const model of models) {
    if (model.kind !== undefined) { nonChat += 1; continue; }
    if (model.priceNote !== undefined && model.isFree !== true) { paid += 1; continue; }
    if (freePatterns.length > 0 && !freePatterns.some(p => patternMatches(p, model.id))) { paid += 1; continue; }
    accepted.push(model);
  }
  return { accepted, nonChat, paid };
}

export interface BuiltinDiscoveryResult {
  platforms: number;
  added: number;
  skipped: number;
  tombstoned: number;
  nonChatSkipped: number;
  paidSkipped: number;
  failures: Array<{ platform: string; error: string }>;
}

function usableKeys(db: Db, platform: string): KeyRow[] {
  return db.prepare(`
    SELECT id, platform, encrypted_key, iv, auth_tag, proxy_encrypted, proxy_iv, proxy_auth_tag
      FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status != 'invalid'
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
  `).all(platform) as KeyRow[];
}

/**
 * One automatic discovery pass over every eligible platform that has a usable
 * key (or just `only`, when given). ADD-ONLY, like the custom-model sync: a
 * model that vanishes upstream is left for the health and retirement paths.
 */
export async function runBuiltinModelDiscovery(db: Db, only?: string): Promise<BuiltinDiscoveryResult> {
  const result: BuiltinDiscoveryResult = {
    platforms: 0, added: 0, skipped: 0, tombstoned: 0, nonChatSkipped: 0, paidSkipped: 0, failures: [],
  };
  if (builtinDiscoveryMode() !== 'auto') return result;

  const platforms = only ? [only] : [...BUILTIN_DISCOVERY_PLATFORMS];
  for (const platform of platforms) {
    const eligibility = builtinDiscoveryEligibility(db, platform);
    if (!eligibility.eligible || !eligibility.provider) continue;
    const keys = usableKeys(db, platform);
    if (keys.length === 0) continue;
    result.platforms += 1;
    try {
      const discovered = await discoverBuiltinModels(eligibility.provider, keys[0]!);
      // Re-check after the network round-trip: a catalog sync may have landed
      // in between, and the catalog always wins.
      if (!isBuiltinDiscoveryEligible(db, platform)) continue;
      const { accepted, nonChat, paid } = autoRegistrable(discovered);
      result.nonChatSkipped += nonChat;
      result.paidSkipped += paid;
      const registered = registerDiscoveredModels(
        db,
        platform,
        accepted.map(m => ({ modelId: m.id, contextWindow: m.contextWindow, vision: m.vision })),
        { explicit: false },
      );
      result.added += registered.created.length;
      result.skipped += registered.existing.length;
      result.tombstoned += registered.tombstoned.length;
      if (registered.created.length > 0) {
        console.log(`[builtin-model-discovery] ${platform}: registered ${registered.created.length} discovered model(s)`);
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      result.failures.push({ platform, error: message });
      console.error(`[builtin-model-discovery] ${platform}: ${message}`);
    }
  }
  return result;
}

// Event-driven passes (key saved, key checked healthy) for one platform. At
// most one in flight per platform, and a platform that already has models is
// left to the scheduled pass, so the 5-minute health cycle never turns into a
// 5-minute /models poll.
const inFlight = new Map<string, Promise<BuiltinDiscoveryResult>>();
const lastEventRunMs = new Map<string, number>();
const EVENT_MIN_GAP_MS = 60 * 60 * 1000;

export function triggerBuiltinModelDiscovery(
  db: Db,
  platform: string,
  reason: 'key_added' | 'healthy',
): Promise<BuiltinDiscoveryResult> | null {
  if (builtinDiscoveryMode() !== 'auto') return null;
  if (!isBuiltinDiscoveryEligible(db, platform)) return null;
  const pending = inFlight.get(platform);
  if (pending) return pending;
  if (reason === 'healthy') {
    const hasModels = db.prepare('SELECT 1 FROM models WHERE platform = ? LIMIT 1').get(platform);
    if (hasModels) return null;
    const last = lastEventRunMs.get(platform) ?? 0;
    if (Date.now() - last < EVENT_MIN_GAP_MS) return null;
  }
  lastEventRunMs.set(platform, Date.now());
  const run = runBuiltinModelDiscovery(db, platform)
    .catch((err: unknown): BuiltinDiscoveryResult => {
      console.error(`[builtin-model-discovery] ${platform}: ${(err as Error)?.message ?? err}`);
      return { platforms: 0, added: 0, skipped: 0, tombstoned: 0, nonChatSkipped: 0, paidSkipped: 0, failures: [] };
    })
    .finally(() => inFlight.delete(platform));
  inFlight.set(platform, run);
  return run;
}

/** Test hook: forget event throttling between cases. */
export function resetBuiltinDiscoveryThrottle(): void {
  inFlight.clear();
  lastEventRunMs.clear();
}

/** Run the pass on the custom-model sync cadence (CUSTOM_MODEL_SYNC_INTERVAL_MS,
 *  daily by default; 0 disables both). */
export function startBuiltinModelDiscovery(db: Db, scheduler: Scheduler): (() => void) | null {
  const intervalMs = customModelSyncIntervalMs();
  if (intervalMs <= 0 || builtinDiscoveryMode() !== 'auto') return null;
  return scheduler.every(intervalMs, () => { void runBuiltinModelDiscovery(db); }, { name: 'builtin-model-discovery' });
}
