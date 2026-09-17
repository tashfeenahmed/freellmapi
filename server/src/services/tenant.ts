/**
 * Tenant service — multi-tenant API key management for freellmapi.
 *
 * Each tenant gets a unique API key (freetenant-*) with optional:
 * - Per-tenant rate limits (RPM, RPD, TPM)
 * - Model allowlist
 * - Server-enforced system prompt
 * - Usage tracking
 *
 * The unified key continues to work as before (admin access).
 * Tenant keys resolve through resolveAuth alongside client-profile keys.
 */
import crypto from 'crypto';
import { getDb } from '../db/index.js';

const TENANT_KEY_PREFIX = 'freetenant-';

export interface Tenant {
  id: number;
  name: string;
  enabled: boolean;
  systemPrompt: string | null;
  maxRpm: number;
  maxRpd: number;
  maxTpm: number;
  allowedModels: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantCreate {
  name: string;
  systemPrompt?: string | null;
  maxRpm?: number;
  maxRpd?: number;
  maxTpm?: number;
  allowedModels?: string[] | null;
}

export interface TenantWithKey extends Tenant {
  apiKey: string; // plaintext key — only returned on creation
}

function generateTenantKey(): string {
  return TENANT_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Create a new tenant. Returns the tenant with its plaintext API key.
 * The key is only shown once — store it securely.
 */
export function createTenant(input: TenantCreate): TenantWithKey {
  const db = getDb();
  const key = generateTenantKey();
  const tokenHash = hashKey(key);

  const stmt = db.prepare(`
    INSERT INTO tenants (name, token_hash, system_prompt, max_rpm, max_rpd, max_tpm, allowed_models)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const allowedModels = input.allowedModels ? input.allowedModels.join(',') : null;
  const result = stmt.run(
    input.name,
    tokenHash,
    input.systemPrompt ?? null,
    input.maxRpm ?? 0,
    input.maxRpd ?? 0,
    input.maxTpm ?? 0,
    allowedModels,
  );

  const tenant = getTenant(Number(result.lastInsertRowid))!;
  return { ...tenant, apiKey: key };
}

/**
 * Get a tenant by ID.
 */
export function getTenant(id: number): Tenant | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as any;
  if (!row) return null;
  return rowToTenant(row);
}

/**
 * List all tenants.
 */
export function listTenants(): Tenant[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all() as any[];
  return rows.map(rowToTenant);
}

/**
 * Update a tenant's settings.
 */
export function updateTenant(id: number, updates: Partial<TenantCreate> & { enabled?: boolean }): boolean {
  const db = getDb();
  const existing = getTenant(id);
  if (!existing) return false;

  const sets: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.systemPrompt !== undefined) { sets.push('system_prompt = ?'); values.push(updates.systemPrompt); }
  if (updates.maxRpm !== undefined) { sets.push('max_rpm = ?'); values.push(updates.maxRpm); }
  if (updates.maxRpd !== undefined) { sets.push('max_rpd = ?'); values.push(updates.maxRpd); }
  if (updates.maxTpm !== undefined) { sets.push('max_tpm = ?'); values.push(updates.maxTpm); }
  if (updates.allowedModels !== undefined) { sets.push('allowed_models = ?'); values.push(updates.allowedModels?.join(',') ?? null); }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

/**
 * Delete a tenant.
 */
export function deleteTenant(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Rotate a tenant's API key. Returns the new plaintext key.
 */
export function rotateTenantKey(id: number): string | null {
  const db = getDb();
  const existing = getTenant(id);
  if (!existing) return null;

  const newKey = generateTenantKey();
  const newHash = hashKey(newKey);
  db.prepare("UPDATE tenants SET token_hash = ?, updated_at = datetime('now') WHERE id = ?").run(newHash, id);
  return newKey;
}

/**
 * Resolve a tenant from an API token hash.
 * Used by resolveAuth to check if a token belongs to a tenant.
 */
export function resolveTenantByTokenHash(tokenHash: string): { id: number; name: string; systemPrompt: string | null; allowedModels: string | null } | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, name, system_prompt, allowed_models FROM tenants WHERE token_hash = ? AND enabled = 1',
  ).get(tokenHash) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt ?? null,
    allowedModels: row.allowed_models ?? null,
  };
}

/**
 * Check if a model is allowed for a tenant.
 * Returns true if the tenant has no model restrictions or the model is in the allowlist.
 */
export function isModelAllowed(tenantId: number, modelId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT allowed_models FROM tenants WHERE id = ?').get(tenantId) as any;
  if (!row || !row.allowed_models) return true; // no restriction
  const allowed = row.allowed_models.split(',');
  return allowed.includes(modelId) || allowed.some((m: string) => modelId.startsWith(m + '/'));
}

/**
 * Record a request for tenant usage tracking.
 */
export function recordTenantUsage(tenantId: number, inputTokens: number, outputTokens: number): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  // Daily
  db.prepare(`
    INSERT INTO tenant_usage (tenant_id, period, requests, input_tokens, output_tokens)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(tenant_id, period) DO UPDATE SET
      requests = requests + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens
  `).run(tenantId, today, inputTokens, outputTokens);

  // Monthly
  db.prepare(`
    INSERT INTO tenant_usage (tenant_id, period, requests, input_tokens, output_tokens)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(tenant_id, period) DO UPDATE SET
      requests = requests + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens
  `).run(tenantId, month, inputTokens, outputTokens);
}

/**
 * Check if a tenant has exceeded its rate limits.
 * Returns null if OK, or an error message.
 */
export function checkTenantRateLimit(tenantId: number): string | null {
  const db = getDb();
  const tenant = getTenant(tenantId);
  if (!tenant) return 'tenant not found';

  const today = new Date().toISOString().slice(0, 10);

  if (tenant.maxRpm > 0) {
    // Check RPM (approximate: requests in last minute from requests table)
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM requests
      WHERE tenant_id = ? AND created_at >= datetime('now', '-1 minute')
    `).get(tenantId) as any;
    if (row && row.cnt >= tenant.maxRpm) {
      return `rate limit exceeded: ${row.cnt}/${tenant.maxRpm} RPM`;
    }
  }

  if (tenant.maxRpd > 0) {
    const row = db.prepare(
      'SELECT requests FROM tenant_usage WHERE tenant_id = ? AND period = ?',
    ).get(tenantId, today) as any;
    if (row && row.requests >= tenant.maxRpd) {
      return `daily limit exceeded: ${row.requests}/${tenant.maxRpd} RPD`;
    }
  }

  return null;
}

/**
 * Get tenant usage summary.
 */
export function getTenantUsage(tenantId: number): { daily: any; monthly: any } {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const daily = db.prepare(
    'SELECT * FROM tenant_usage WHERE tenant_id = ? AND period = ?',
  ).get(tenantId, today) || { requests: 0, input_tokens: 0, output_tokens: 0 };

  const monthly = db.prepare(
    'SELECT * FROM tenant_usage WHERE tenant_id = ? AND period = ?',
  ).get(tenantId, month) || { requests: 0, input_tokens: 0, output_tokens: 0 };

  return { daily, monthly };
}

function rowToTenant(row: any): Tenant {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    systemPrompt: row.system_prompt ?? null,
    maxRpm: row.max_rpm,
    maxRpd: row.max_rpd,
    maxTpm: row.max_tpm,
    allowedModels: row.allowed_models ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
