import { getDb } from '../db/index.js';
import { getAllPenalties } from './router.js';
import { rateLimitFactor } from './scoring.js';

const INSPECTOR_LOOKBACK_MINUTES = 30;
const MAX_ERRORS_PER_MODEL = 5;

export type InspectorReason = 'penalty' | 'cooldown' | 'recent_errors';

export interface InspectorRow {
  modelDbId: number | null;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  fallbackEnabled: boolean;
  priority: number | null;
  penalty: {
    hits: number;
    value: number;
    rateLimitFactor: number;
  };
  cooldowns: Array<{
    keyId: number;
    keyLabel: string | null;
    keyStatus: string | null;
    expiresAtMs: number;
    expiresInMs: number;
  }>;
  recentErrors: Array<{
    id: number;
    keyId: number | null;
    keyLabel: string | null;
    error: string;
    latencyMs: number;
    createdAt: string;
  }>;
  recentErrorCount: number;
  reasons: InspectorReason[];
}

export interface PenaltyInspectorSnapshot {
  generatedAtMs: number;
  lookbackMinutes: number;
  rows: InspectorRow[];
}

function toSqliteDateTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

function rowKey(modelDbId: number | null, platform: string, modelId: string): string {
  return modelDbId != null ? `id:${modelDbId}` : `model:${platform}:${modelId}`;
}

function ensureInspectorRow(
  rows: Map<string, InspectorRow>,
  input: {
    modelDbId: number | null;
    platform: string;
    modelId: string;
    displayName?: string | null;
    modelEnabled?: number | null;
    fallbackEnabled?: number | null;
    priority?: number | null;
  },
): InspectorRow {
  const key = rowKey(input.modelDbId, input.platform, input.modelId);
  const existing = rows.get(key);
  if (existing) return existing;

  const row: InspectorRow = {
    modelDbId: input.modelDbId,
    platform: input.platform,
    modelId: input.modelId,
    displayName: input.displayName ?? input.modelId,
    enabled: input.modelEnabled !== 0,
    fallbackEnabled: input.fallbackEnabled !== 0,
    priority: input.priority ?? null,
    penalty: { hits: 0, value: 0, rateLimitFactor: 1 },
    cooldowns: [],
    recentErrors: [],
    recentErrorCount: 0,
    reasons: [],
  };
  rows.set(key, row);
  return row;
}

function addReason(row: InspectorRow, reason: InspectorReason): void {
  if (!row.reasons.includes(reason)) row.reasons.push(reason);
}

export function getPenaltyInspector(): PenaltyInspectorSnapshot {
  const db = getDb();
  const now = Date.now();
  const rows = new Map<string, InspectorRow>();

  const penalties = getAllPenalties();
  if (penalties.length > 0) {
    const placeholders = penalties.map(() => '?').join(',');
    const models = db.prepare(`
      SELECT m.id AS model_db_id, m.platform, m.model_id, m.display_name,
             m.enabled AS model_enabled, fc.enabled AS fallback_enabled, fc.priority
        FROM models m
        LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.id IN (${placeholders})
    `).all(...penalties.map(p => p.modelDbId)) as Array<{
      model_db_id: number;
      platform: string;
      model_id: string;
      display_name: string;
      model_enabled: number;
      fallback_enabled: number | null;
      priority: number | null;
    }>;
    const modelById = new Map(models.map(m => [m.model_db_id, m]));
    for (const p of penalties) {
      const model = modelById.get(p.modelDbId);
      if (!model) continue;
      const row = ensureInspectorRow(rows, {
        modelDbId: model.model_db_id,
        platform: model.platform,
        modelId: model.model_id,
        displayName: model.display_name,
        modelEnabled: model.model_enabled,
        fallbackEnabled: model.fallback_enabled,
        priority: model.priority,
      });
      row.penalty = { hits: p.count, value: p.penalty, rateLimitFactor: rateLimitFactor(p.penalty) };
      addReason(row, 'penalty');
    }
  }

  const cooldownRows = db.prepare(`
    SELECT c.platform, c.model_id, c.key_id, c.expires_at_ms,
           m.id AS model_db_id, m.display_name, m.enabled AS model_enabled,
           fc.enabled AS fallback_enabled, fc.priority,
           ak.label AS key_label, ak.status AS key_status
      FROM rate_limit_cooldowns c
      LEFT JOIN models m ON m.platform = c.platform AND m.model_id = c.model_id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      LEFT JOIN api_keys ak ON ak.id = c.key_id
     WHERE c.expires_at_ms > ?
     ORDER BY c.expires_at_ms ASC
  `).all(now) as Array<{
    platform: string;
    model_id: string;
    key_id: number;
    expires_at_ms: number;
    model_db_id: number | null;
    display_name: string | null;
    model_enabled: number | null;
    fallback_enabled: number | null;
    priority: number | null;
    key_label: string | null;
    key_status: string | null;
  }>;
  for (const c of cooldownRows) {
    const row = ensureInspectorRow(rows, {
      modelDbId: c.model_db_id,
      platform: c.platform,
      modelId: c.model_id,
      displayName: c.display_name,
      modelEnabled: c.model_enabled,
      fallbackEnabled: c.fallback_enabled,
      priority: c.priority,
    });
    row.cooldowns.push({
      keyId: c.key_id,
      keyLabel: c.key_label,
      keyStatus: c.key_status,
      expiresAtMs: c.expires_at_ms,
      expiresInMs: Math.max(0, c.expires_at_ms - now),
    });
    addReason(row, 'cooldown');
  }

  const since = toSqliteDateTime(now - INSPECTOR_LOOKBACK_MINUTES * 60 * 1000);
  const errorRows = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.key_id, r.error, r.latency_ms, r.created_at,
           m.id AS model_db_id, m.display_name, m.enabled AS model_enabled,
           fc.enabled AS fallback_enabled, fc.priority,
           ak.label AS key_label
      FROM requests r
      LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      LEFT JOIN api_keys ak ON ak.id = r.key_id
     WHERE r.status = 'error'
       AND r.created_at >= ?
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 250
  `).all(since) as Array<{
    id: number;
    platform: string;
    model_id: string;
    key_id: number | null;
    error: string | null;
    latency_ms: number;
    created_at: string;
    model_db_id: number | null;
    display_name: string | null;
    model_enabled: number | null;
    fallback_enabled: number | null;
    priority: number | null;
    key_label: string | null;
  }>;
  for (const e of errorRows) {
    const row = ensureInspectorRow(rows, {
      modelDbId: e.model_db_id,
      platform: e.platform,
      modelId: e.model_id,
      displayName: e.display_name,
      modelEnabled: e.model_enabled,
      fallbackEnabled: e.fallback_enabled,
      priority: e.priority,
    });
    row.recentErrorCount++;
    if (row.recentErrors.length < MAX_ERRORS_PER_MODEL) {
      row.recentErrors.push({
        id: e.id,
        keyId: e.key_id,
        keyLabel: e.key_label,
        error: e.error ?? 'Unknown upstream error',
        latencyMs: e.latency_ms,
        createdAt: e.created_at,
      });
    }
    addReason(row, 'recent_errors');
  }

  const ordered = [...rows.values()].sort((a, b) =>
    b.penalty.value - a.penalty.value ||
    b.cooldowns.length - a.cooldowns.length ||
    b.recentErrorCount - a.recentErrorCount ||
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.displayName.localeCompare(b.displayName),
  );

  return {
    generatedAtMs: now,
    lookbackMinutes: INSPECTOR_LOOKBACK_MINUTES,
    rows: ordered,
  };
}
