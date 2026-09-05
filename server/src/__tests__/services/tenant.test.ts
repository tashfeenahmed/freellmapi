import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { resolveAuth } from '../../lib/system-prompt.js';
import { mintDashboardToken } from '../helpers/auth.js';
import {
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  deleteTenant,
  rotateTenantKey,
  resolveTenantByTokenHash,
  isModelAllowed,
  recordTenantUsage,
  checkTenantRateLimit,
  getTenantUsage,
} from '../../services/tenant.js';

// Multi-tenant API key management (#267): CRUD + rotation + rate limits +
// allowlists + usage, plus resolveAuth integration so a freetenant-* key
// authenticates the /v1 inference surface exactly like a client-profile key.

let dashToken = '';
let app: Express;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token ?? dashToken}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

describe('tenant service (#267)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM tenants').run();
  });

  it('createTenant returns a freetenant-* key that resolves through resolveAuth', () => {
    const t = createTenant({ name: 'Acme', systemPrompt: 'Be polite', maxRpm: 10 });
    expect(t.apiKey.startsWith('freetenant-')).toBe(true);
    expect(t.id).toBeGreaterThan(0);

    const auth = resolveAuth(t.apiKey);
    expect(auth).toMatchObject({ kind: 'tenant', tenantId: t.id, name: 'Acme', systemPrompt: 'Be polite' });
    // Hash is stored, never the plaintext key.
    const row = getDb().prepare('SELECT token_hash FROM tenants WHERE id = ?').get(t.id) as any;
    expect(row.token_hash).not.toContain(t.apiKey);
  });

  it('keys are unique and unusable across tenants', () => {
    const a = createTenant({ name: 'A' });
    const b = createTenant({ name: 'B' });
    expect(a.apiKey).not.toBe(b.apiKey);
    // Rotating A must not affect B.
    rotateTenantKey(a.id);
    expect(resolveAuth(a.apiKey)).toBeNull();
    expect(resolveAuth(b.apiKey)).toMatchObject({ kind: 'tenant', tenantId: b.id });
  });

  it('disabled tenants stop resolving but keep their row', () => {
    const t = createTenant({ name: 'Off' });
    updateTenant(t.id, { enabled: false });
    expect(resolveAuth(t.apiKey)).toBeNull();
    expect(getTenant(t.id)?.enabled).toBe(false);
  });

  it('updateTenant applies allowlist and rate limits; isModelAllowed honors exact + family-prefix matching', () => {
    const t = createTenant({ name: 'Gated' });
    updateTenant(t.id, { allowedModels: ['groq/llama-3.3-70b-versatile'], maxRpd: 5 });
    let fresh = getTenant(t.id)!;
    expect(fresh.allowedModels).toBe('groq/llama-3.3-70b-versatile');
    expect(isModelAllowed(t.id, 'groq/llama-3.3-70b-versatile')).toBe(true); // exact id
    expect(isModelAllowed(t.id, 'openai/gpt-4o')).toBe(false);
    // A family entry ('groq') opens every 'groq/…' model via prefix matching.
    updateTenant(t.id, { allowedModels: ['groq'] });
    fresh = getTenant(t.id)!;
    expect(isModelAllowed(t.id, 'groq/llama-3.3-70b-versatile')).toBe(true);
    expect(isModelAllowed(t.id, 'openai/gpt-4o')).toBe(false);
    // NULL allowlist = unrestricted.
    updateTenant(t.id, { allowedModels: null });
    expect(isModelAllowed(t.id, 'anything')).toBe(true);
  });

  it('recordTenantUsage feeds getTenantUsage and checkTenantRateLimit', () => {
    const t = createTenant({ name: 'Metered', maxRpd: 2 });
    recordTenantUsage(t.id, 100, 50);
    const usage = getTenantUsage(t.id);
    expect(usage.daily.requests).toBe(1);
    expect(usage.daily.input_tokens).toBe(100);
    expect(usage.daily.output_tokens).toBe(50);
    expect(usage.monthly.requests).toBe(1);

    expect(checkTenantRateLimit(t.id)).toBeNull(); // 1/2 within the cap
    recordTenantUsage(t.id, 10, 10);
    // Reaching the cap rejects the next request (>= semantics).
    expect(checkTenantRateLimit(t.id)).toContain('daily limit exceeded: 2/2');
  });

  it('rotateTenantKey invalidates the old key and returns a working new one', () => {
    const t = createTenant({ name: 'Rotate' });
    const next = rotateTenantKey(t.id)!;
    expect(next.startsWith('freetenant-')).toBe(true);
    expect(resolveAuth(t.apiKey)).toBeNull();
    expect(resolveAuth(next)).toMatchObject({ kind: 'tenant', tenantId: t.id });
    // resolveTenantByTokenHash agrees with resolveAuth on the new hash.
    const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
    const byHash = resolveTenantByTokenHash(sha256(next));
    expect(byHash?.id).toBe(t.id);
  });

  it('deleteTenant removes the row and stops resolution', () => {
    const t = createTenant({ name: 'Gone' });
    expect(deleteTenant(t.id)).toBe(true);
    expect(getTenant(t.id)).toBeNull();
    expect(resolveAuth(t.apiKey)).toBeNull();
    expect(listTenants()).toHaveLength(0);
  });
});

describe('POST /api/tenants admin routes (#267)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM tenants').run();
  });

  it('creates a tenant and lists it', async () => {
    const created = await api('POST', '/api/tenants', { name: 'Acme', systemPrompt: 'short' });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^freetenant-/);

    const list = await api('GET', '/api/tenants');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Acme');
  });

  it('rejects bad payloads', async () => {
    const r = await api('POST', '/api/tenants', { name: '' });
    expect(r.status).toBe(400);
  });

  it('requires a dashboard session (unified key is not enough)', async () => {
    const r = await api('GET', '/api/tenants', undefined, getUnifiedApiKey());
    expect(r.status).toBe(401);
  });

  it('updates, rotates and reports usage', async () => {
    const created = await api('POST', '/api/tenants', { name: 'Full', maxRpd: 3 });
    const id = created.body.id;

    const patched = await api('PATCH', `/api/tenants/${id}`, { enabled: false });
    expect(patched.status).toBe(200);
    expect(getTenant(id)?.enabled).toBe(false);

    const rotated = await api('POST', `/api/tenants/${id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.apiKey).toMatch(/^freetenant-/);

    const usage = await api('GET', `/api/tenants/${id}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.body.daily.requests).toBe(0);

    const gone = await api('DELETE', `/api/tenants/${id}`);
    expect(gone.status).toBe(200);
    expect(getTenant(id)).toBeNull();
  });
});
