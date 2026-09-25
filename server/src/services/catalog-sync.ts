import crypto from 'crypto';
import { getPostgresPool } from '../db/postgres.js';
import { getSetting, setSetting } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { reloadRoutingRegistry } from './router-registry.js';

const DEFAULT_BASE_URL = 'https://api.freellmapi.co';

const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----
`;

export const MIN_CATALOG_VERSION = '2026.06.07';

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;

export const SETTING_LICENSE_KEY = 'premium_license_key';
export const SETTING_LICENSE_STATUS = 'premium_license_status';
const SETTING_APPLIED_VERSION = 'catalog_applied_version';
const SETTING_APPLIED_TIER = 'catalog_applied_tier';
const SETTING_APPLIED_JSON = 'catalog_applied_json';
const SETTING_LAST_SYNC_MS = 'catalog_last_sync_ms';
const SETTING_LAST_ERROR = 'catalog_last_error';

export function catalogBaseUrl(): string {
  return (process.env.CATALOG_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function catalogPublicKey(): crypto.KeyObject {
  const pem = process.env.CATALOG_PUBKEY ? process.env.CATALOG_PUBKEY.replace(/\\n/g, '\n') : PINNED_CATALOG_PUBKEY;
  return crypto.createPublicKey({ key: pem, format: 'pem' });
}

export interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}

interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  modality?: string;
}

interface Catalog {
  version: string;
  generatedAt: string;
  tier: 'live' | 'monthly';
  models: CatalogModel[];
  quirks: CatalogQuirk[];
}

export interface SyncResult {
  ok: boolean;
  action: 'applied' | 'up_to_date' | 'skipped_older' | 'error';
  version?: string;
  tier?: string;
  detail?: string;
  counts?: { updated: number; inserted: number; removed: number; skippedUnknownPlatform: number; quirks: number };
}

function isCatalog(value: unknown): value is Catalog {
  const c = value as Catalog;
  return (
    !!c &&
    typeof c.version === 'string' &&
    (c.tier === 'live' || c.tier === 'monthly') &&
    Array.isArray(c.models) &&
    Array.isArray(c.quirks)
  );
}

export async function applyCatalog(_db: any, catalog: Catalog): Promise<NonNullable<SyncResult['counts']>> {
  const counts = { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 };
  const pool = getPostgresPool();

  const providerRes = await pool.query('SELECT id, provider_key FROM providers');
  const providerMap = new Map<string, number>();
  for (const row of providerRes.rows) {
    providerMap.set(row.provider_key, row.id);
  }

  for (const m of catalog.models) {
    if (!hasProvider(m.platform as Platform)) {
      counts.skippedUnknownPlatform++;
      continue;
    }
    const providerId = providerMap.get(m.platform);
    if (!providerId) continue;

    const existingRes = await pool.query('SELECT id FROM models WHERE provider_id = $1 AND model_id = $2', [
      providerId,
      m.modelId,
    ]);

    if (existingRes.rows.length > 0) {
      await pool.query(
        `UPDATE models SET
           display_name = $1, context_window = $2, supports_vision = $3,
           supports_tools = $4, priority = $5, updated_at = NOW()
         WHERE id = $6`,
        [
          m.displayName,
          m.contextWindow,
          m.supportsVision,
          m.supportsTools,
          m.intelligenceRank || 0,
          existingRes.rows[0].id,
        ]
      );
      counts.updated++;
    } else {
      await pool.query(
        `INSERT INTO models (
           provider_id, model_id, canonical_name, display_name, enabled,
           context_window, supports_streaming, supports_tools, supports_vision,
           supports_structured_output, priority
         ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, true, $9)`,
        [
          providerId,
          m.modelId,
          m.modelId,
          m.displayName,
          m.enabled,
          m.contextWindow,
          m.supportsTools,
          m.supportsVision,
          m.intelligenceRank || 0,
        ]
      );
      counts.inserted++;
    }
  }

  await reloadRoutingRegistry();
  return counts;
}

export async function syncCatalog(force = false): Promise<SyncResult> {
  const key = getSetting(SETTING_LICENSE_KEY);
  const applied = getSetting(SETTING_APPLIED_VERSION);

  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(`${catalogBaseUrl()}/v1/latest`);
    if (applied && !force) url.searchParams.set('since', applied);

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (res.status === 304) {
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'up_to_date', version: applied ?? undefined };
    }
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);

    const signature = res.headers.get('x-catalog-signature');
    if (!signature) throw new Error('catalog response missing signature');
    const bytes = Buffer.from(await res.arrayBuffer());
    const verified = crypto.verify(null, bytes, catalogPublicKey(), Buffer.from(signature, 'base64'));
    if (!verified) throw new Error('catalog signature verification FAILED — discarding response');

    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isCatalog(parsed)) throw new Error('catalog payload has unexpected shape');
    const catalog = parsed;

    if (catalog.version < MIN_CATALOG_VERSION) {
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'skipped_older', version: catalog.version, tier: catalog.tier };
    }

    const sameAsApplied = applied === catalog.version && getSetting(SETTING_APPLIED_TIER) === catalog.tier;
    if (!sameAsApplied) {
      const counts = await applyCatalog(null, catalog);
      setSetting(SETTING_APPLIED_VERSION, catalog.version);
      setSetting(SETTING_APPLIED_TIER, catalog.tier);
      setSetting(SETTING_APPLIED_JSON, bytes.toString('utf8'));
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'applied', version: catalog.version, tier: catalog.tier, counts };
    }

    setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
    setSetting(SETTING_LAST_ERROR, '');
    return { ok: true, action: 'up_to_date', version: catalog.version, tier: catalog.tier };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[catalog-sync] ${message}`);
    setSetting(SETTING_LAST_ERROR, message);
    return { ok: false, action: 'error', detail: message };
  }
}

export async function refreshLicenseStatus(): Promise<LicenseStatus | null> {
  const key = getSetting(SETTING_LICENSE_KEY);
  if (!key) return null;
  try {
    const res = await fetch(`${catalogBaseUrl()}/v1/license/check`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Omit<LicenseStatus, 'checkedAtMs'>;
    const status: LicenseStatus = { ...body, checkedAtMs: Date.now() };
    setSetting(SETTING_LICENSE_STATUS, JSON.stringify(status));
    return status;
  } catch (err) {
    console.warn(`[catalog-sync] license check unreachable: ${err instanceof Error ? err.message : err}`);
    return getCachedLicenseStatus();
  }
}

export function getCachedLicenseStatus(): LicenseStatus | null {
  const raw = getSetting(SETTING_LICENSE_STATUS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseStatus;
  } catch {
    return null;
  }
}

export interface CatalogSyncState {
  baseUrl: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
}

export function getSyncState(): CatalogSyncState {
  return {
    baseUrl: catalogBaseUrl(),
    appliedVersion: getSetting(SETTING_APPLIED_VERSION) ?? null,
    appliedTier: getSetting(SETTING_APPLIED_TIER) ?? null,
    lastSyncMs: Number(getSetting(SETTING_LAST_SYNC_MS)) || null,
    lastError: getSetting(SETTING_LAST_ERROR) || null,
  };
}

export async function reapplyCachedCatalog(): Promise<{ reapplied: boolean; version?: string }> {
  try {
    const raw = getSetting(SETTING_APPLIED_JSON);
    if (!raw) return { reapplied: false };
    const parsed: unknown = JSON.parse(raw);
    if (!isCatalog(parsed) || parsed.version < MIN_CATALOG_VERSION) return { reapplied: false };
    await applyCatalog(null, parsed);
    return { reapplied: true, version: parsed.version };
  } catch (err) {
    console.warn(`[catalog-sync] cached catalog re-apply failed: ${err instanceof Error ? err.message : err}`);
    return { reapplied: false };
  }
}

let cancelBootTimer: (() => void) | null = null;
let cancelInterval: (() => void) | null = null;

export function startCatalogSync(scheduler: Scheduler): void {
  if (cancelInterval) return;
  if (process.env.CATALOG_SYNC_DISABLED === '1') {
    console.log('[catalog-sync] disabled via CATALOG_SYNC_DISABLED=1');
    return;
  }
  void reapplyCachedCatalog();
  const run = () => {
    void refreshLicenseStatus();
    void syncCatalog();
  };
  cancelBootTimer = scheduler.after(BOOT_DELAY_MS, run);
  cancelInterval = scheduler.every(SYNC_INTERVAL_MS, run);
  console.log(`[catalog-sync] polling ${catalogBaseUrl()} every ${SYNC_INTERVAL_MS / 3600000}h`);
}

export function stopCatalogSync(): void {
  if (cancelBootTimer) {
    cancelBootTimer();
    cancelBootTimer = null;
  }
  if (cancelInterval) {
    cancelInterval();
    cancelInterval = null;
  }
}

/** Raw response from the catalog service's license activation endpoint. */
export interface LicenseActivation {
  valid: boolean;
  plan: string | null;
  status: string | null;
  expiresAt: string | null;
  reason?: string;
}

/**
 * Validate a key with the license service. Returns null when the service is
 * unreachable — distinguishable from a rejected key, so a transient outage can
 * be warned about instead of reported as a bad key. Shared by the dashboard's
 * POST /api/premium/key and declarative `license` config.
 */
export async function validateLicenseKey(key: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<LicenseActivation | null> {
  try {
    const res = await fetch(`${catalogBaseUrl()}/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as LicenseActivation;
  } catch {
    return null;
  }
}

