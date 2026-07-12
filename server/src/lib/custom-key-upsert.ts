import type { Db } from '../db/types.js';
import { encrypt, decrypt } from './crypto.js';

// Custom-provider key upsert + binding helpers.
//
// A custom endpoint is identified by its base_url and may hold SEVERAL
// api_keys rows (e.g. multiple free-tier accounts against the same gateway).
// Which keys a given model may route through is recorded EXPLICITLY in the
// custom_key_bindings junction table — a model only uses the keys it was
// registered with, never every key on its endpoint. This keeps a finance model
// from burning a research key's quota while still allowing one model to pool
// several keys when the user registers it against each.
//
// `models/embedding_models/media_models.key_id` is kept as a display ANCHOR
// (= MIN(key_id) from its bindings) for the legacy JOIN-based listing queries;
// the routing source of truth is custom_key_bindings.

export interface CustomKeyUpsertInput {
  baseUrl: string;
  apiKey?: string;
  label?: string;
  enabled?: boolean;
}

export interface CustomKeyUpsertResult {
  anchorKeyId: number;
  processedKeyId: number;
  storedKeyForMask: string;
  isNewKey: boolean;
}

interface ExistingKeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

export function findOrInsertCustomKey(
  db: Db,
  input: CustomKeyUpsertInput,
): CustomKeyUpsertResult {
  const baseUrl = input.baseUrl;
  const providedKey = input.apiKey?.trim() || undefined;
  const label = input.label?.trim() || undefined;
  const enabled = input.enabled === false ? 0 : 1;

  const existing = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ? ORDER BY id",
  ).all(baseUrl) as ExistingKeyRow[];

  const reEnable = (id: number) =>
    db
      .prepare("UPDATE api_keys SET label = COALESCE(?, label), status = 'unknown', enabled = ? WHERE id = ?")
      .run(label ?? null, enabled, id);

  if (providedKey) {
    for (const row of existing) {
      let matches = false;
      try {
        matches = decrypt(row.encrypted_key, row.iv, row.auth_tag) === providedKey;
      } catch {
        matches = false;
      }
      if (matches) {
        reEnable(row.id);
        return {
          anchorKeyId: existing[0]!.id,
          processedKeyId: row.id,
          storedKeyForMask: providedKey,
          isNewKey: false,
        };
      }
    }
    const { encrypted, iv, authTag } = encrypt(providedKey);
    const r = db
      .prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url) VALUES ('custom', ?, ?, ?, ?, 'unknown', ?, ?)",
      )
      .run(label ?? 'Custom', encrypted, iv, authTag, enabled, baseUrl);
    const newId = Number(r.lastInsertRowid);
    return {
      anchorKeyId: existing.length > 0 ? existing[0]!.id : newId,
      processedKeyId: newId,
      storedKeyForMask: providedKey,
      isNewKey: true,
    };
  }

  if (existing.length > 0) {
    const anchor = existing[0]!;
    reEnable(anchor.id);
    let storedKeyForMask = 'no-key';
    try {
      storedKeyForMask = decrypt(anchor.encrypted_key, anchor.iv, anchor.auth_tag);
    } catch {
      storedKeyForMask = 'no-key';
    }
    return {
      anchorKeyId: anchor.id,
      processedKeyId: anchor.id,
      storedKeyForMask,
      isNewKey: false,
    };
  }

  const { encrypted, iv, authTag } = encrypt('no-key');
  const r = db
    .prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url) VALUES ('custom', ?, ?, ?, ?, 'unknown', ?, ?)",
    )
    .run(label ?? 'Custom', encrypted, iv, authTag, enabled, baseUrl);
  const newId = Number(r.lastInsertRowid);
  return {
    anchorKeyId: newId,
    processedKeyId: newId,
    storedKeyForMask: 'no-key',
    isNewKey: true,
  };
}

export function getEndpointKeyCount(db: Db, baseUrl: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom' AND base_url = ? AND enabled = 1",
    )
    .get(baseUrl) as { n: number };
  return row.n;
}

export type CustomModality = 'chat' | 'embedding' | 'image' | 'audio';

export function upsertBinding(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
  keyId: number,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO custom_key_bindings (modality, model_db_id, key_id) VALUES (?, ?, ?)',
  ).run(modality, modelDbId, keyId);
  rebindAnchor(db, modality, modelDbId);
}

export function rebindAnchor(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
): void {
  const row = db.prepare(
    'SELECT MIN(key_id) AS k FROM custom_key_bindings WHERE modality = ? AND model_db_id = ?',
  ).get(modality, modelDbId) as { k: number | null };
  const table = modality === 'chat' ? 'models'
    : modality === 'embedding' ? 'embedding_models' : 'media_models';
  db.prepare(`UPDATE ${table} SET key_id = ? WHERE id = ? AND platform = 'custom'`)
    .run(row.k, modelDbId);
}

export interface EndpointKeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
}

export function getModelBoundKeys(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
): EndpointKeyRow[] {
  return db.prepare(
    `SELECT k.id, k.encrypted_key, k.iv, k.auth_tag, k.status, k.enabled, k.base_url
       FROM custom_key_bindings ckb
       JOIN api_keys k ON k.id = ckb.key_id
      WHERE ckb.modality = ? AND ckb.model_db_id = ?
        AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
      ORDER BY k.id`,
  ).all(modality, modelDbId) as EndpointKeyRow[];
}

export function getModelBoundKeyIds(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
): number[] {
  return (db.prepare(
    'SELECT key_id FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? ORDER BY key_id',
  ).all(modality, modelDbId) as { key_id: number }[]).map(r => r.key_id);
}

export function removeBinding(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
  keyId: number,
): { modelHasBindings: boolean; keyHasBindings: boolean } {
  db.prepare(
    'DELETE FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? AND key_id = ?',
  ).run(modality, modelDbId, keyId);
  const modelRow = db.prepare(
    'SELECT 1 FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? LIMIT 1',
  ).get(modality, modelDbId);
  const keyRow = db.prepare(
    'SELECT 1 FROM custom_key_bindings WHERE key_id = ? LIMIT 1',
  ).get(keyId);
  return { modelHasBindings: Boolean(modelRow), keyHasBindings: Boolean(keyRow) };
}
