import { execSync } from 'child_process';
import { getDb } from '../db/index.js';

// ---------------------------------------------------------------------------
// Sync engine — generic provider model-sync registry.
// Each provider that can discover models at runtime registers a sync handler.
// The `POST /api/sync` endpoint dispatches to the registered handler.
// ---------------------------------------------------------------------------

export interface SyncResult {
  platform: string;
  providerId: number | null;
  success: boolean;
  modelsFound: number;
  modelsAdded: number;
  models: string[];
  error?: string;
}

export interface SyncHandler {
  (baseUrl?: string): { modelsFound: number; modelsAdded: number; models: string[] };
}

const syncHandlers = new Map<string, SyncHandler>();

/**
 * Register a sync handler for a given platform.
 * Called once at startup from the provider registration block.
 */
export function registerSyncHandler(platform: string, handler: SyncHandler): void {
  syncHandlers.set(platform, handler);
}

/** Check whether a platform has a registered sync handler. */
export function hasSyncHandler(platform: string): boolean {
  return syncHandlers.has(platform);
}

// ---------------------------------------------------------------------------
// ollama-local sync handler
// ---------------------------------------------------------------------------

registerSyncHandler('ollama-local', (overrideBaseUrl?: string) => {
  const db = getDb();
  const baseUrl = (overrideBaseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');

  // Fetch models from the Ollama API
  const raw = execSync(`curl -s ${baseUrl}/api/tags`, {
    encoding: 'utf8',
    timeout: 15000,
  });

  const parsed = JSON.parse(raw);
  const models = parsed.models || [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name,
      intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, 1)
  `);

  // Bump existing ollama-local priorities so new models get lower priority
  db.prepare(`
    UPDATE fallback_config
    SET priority = priority + 100
    WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = 'ollama-local'
    )
  `).run();

  let added = 0;
  for (const m of models) {
    const name = m.name as string;
    insert.run(
      'ollama-local',
      name,
      `${name} (Local)`,
      50,
      10,
      'Local',
      'unlimited',
      131072,
      1
    );

    const row = db.prepare(`
      SELECT id FROM models
      WHERE platform = 'ollama-local' AND model_id = ?
    `).get(name) as any;

    if (row) {
      upsertFallback.run(row.id, 1);
      added++;
    }
  }

  return {
    modelsFound: models.length,
    modelsAdded: added,
    models: models.map((m: any) => m.name),
  };
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface SyncRequest {
  /** Sync all keys of these provider types (e.g. ['ollama-local']) */
  providers?: string[];
  /** Sync specific key instances by their api_keys.id */
  providerIds?: number[];
}

/**
 * Run sync for the requested providers/keys.
 * - If `providers` is set, sync every enabled key of those platforms.
 * - If `providerIds` is set, sync only those specific keys.
 * - If neither is set, sync every key of every platform that has a handler.
 */
export function runSync(req: SyncRequest): SyncResult[] {
  const db = getDb();
  const results: SyncResult[] = [];

  // Resolve which keys to process
  let keys: { id: number; platform: string; base_url: string | null }[] = [];

  if (req.providerIds && req.providerIds.length > 0) {
    // Specific key IDs
    const placeholders = req.providerIds.map(() => '?').join(',');
    keys = db.prepare(
      `SELECT id, platform, base_url FROM api_keys WHERE id IN (${placeholders}) AND enabled = 1`
    ).all(...req.providerIds) as any[];
  } else {
    // By platform name(s)
    const platforms = req.providers && req.providers.length > 0
      ? req.providers
      : Array.from(syncHandlers.keys());

    if (platforms.length === 0) {
      return results;
    }

    const placeholders = platforms.map(() => '?').join(',');
    keys = db.prepare(
      `SELECT id, platform, base_url FROM api_keys WHERE platform IN (${placeholders}) AND enabled = 1`
    ).all(...platforms) as any[];
  }

  // Run sync for each key
  for (const key of keys) {
    const handler = syncHandlers.get(key.platform);
    if (!handler) continue;

    try {
      const result = handler(key.base_url || undefined);
      results.push({
        platform: key.platform,
        providerId: key.id,
        success: true,
        ...result,
      });
    } catch (err: any) {
      results.push({
        platform: key.platform,
        providerId: key.id,
        success: false,
        modelsFound: 0,
        modelsAdded: 0,
        models: [],
        error: err.message,
      });
    }
  }

  // If no keys matched but we were asked by platform, still try the default handler
  if (keys.length === 0 && req.providers && req.providers.length > 0) {
    for (const platform of req.providers) {
      const handler = syncHandlers.get(platform);
      if (!handler) continue;

      try {
        const result = handler();
        results.push({
          platform,
          providerId: null,
          success: true,
          ...result,
        });
      } catch (err: any) {
        results.push({
          platform,
          providerId: null,
          success: false,
          modelsFound: 0,
          modelsAdded: 0,
          models: [],
          error: err.message,
        });
      }
    }
  }

  return results;
}
