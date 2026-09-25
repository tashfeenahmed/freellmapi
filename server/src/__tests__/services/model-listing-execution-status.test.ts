import { describe, it, expect, beforeEach } from 'vitest';
import { getPostgresPool } from '../../db/postgres.js';
import { initDb } from '../../db/index.js';
import { buildModelListing } from '../../services/model-listing.js';
import { reloadRoutingRegistry } from '../../services/router-registry.js';
import { setCooldown } from '../../services/ratelimit.js';
import { encrypt } from '../../lib/crypto.js';

async function ensureProvider(key: string): Promise<number> {
  const pool = getPostgresPool();
  const existing = await pool.query('SELECT id FROM providers WHERE provider_key = $1', [key]);
  if (existing.rows.length > 0 && existing.rows[0]?.id) return existing.rows[0].id;
  const res = await pool.query(
    'INSERT INTO providers (provider_key, display_name, enabled, priority) VALUES ($1, $2, true, 10) RETURNING id',
    [key, key.toUpperCase()]
  );
  return res.rows[0].id;
}

async function seedModel(platform: string, modelId: string, enabled = 1) {
  const pId = await ensureProvider(platform);
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO models (provider_id, model_id, canonical_name, display_name, enabled, priority)
     VALUES ($1, $2, $3, $4, $5, 10)`,
    [pId, modelId, modelId, modelId, Boolean(enabled)]
  );
  await reloadRoutingRegistry();
}

let keySeq = 0;
async function seedKey(platform: string, status: string, enabled = 1, scope: string[] | null = null): Promise<number> {
  keySeq += 1;
  const pId = await ensureProvider(platform);
  const pool = getPostgresPool();
  const isEnabled = enabled === 1 && status !== 'disabled' && status !== 'invalid';
  const enc = encrypt(`key-${keySeq}`);
  const cooldownUntil = status === 'rate_limited' ? new Date(Date.now() + 60000) : null;
  const res = await pool.query(
    `INSERT INTO credentials (provider_id, credential_name, encrypted_value, iv, auth_tag, enabled, priority, cooldown_until, model_scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [pId, `${platform}-${status}-${keySeq}`, enc.encrypted, enc.iv, enc.authTag, isEnabled, 10, cooldownUntil, scope ? JSON.stringify(scope) : null]
  );
  await reloadRoutingRegistry();
  return res.rows[0].id;
}

function statusFor(modelId: string) {
  const m = buildModelListing().models.find(x => x.id === modelId);
  return m?.executionStatus;
}

describe('buildModelListing execution_status (#1100)', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    const pool = await initDb();
    await pool.query('DELETE FROM credentials');
    await pool.query('DELETE FROM models');
    await reloadRoutingRegistry();
  });

  it('marks a model ready when a healthy enabled key exists', async () => {
    await seedModel('groq', 'ready-model');
    await seedKey('groq', 'healthy');
    expect(statusFor('ready-model')).toBe('ready');
  });

  it('treats an unprobed (unknown) key as ready, not exhausted', async () => {
    await seedModel('groq', 'unknown-model');
    await seedKey('groq', 'unknown');
    expect(statusFor('unknown-model')).toBe('ready');
  });

  it('marks a model needsKey when no enabled key exists', async () => {
    await seedModel('groq', 'nokey-model');
    expect(statusFor('nokey-model')).toBe('needsKey');
  });

  it('marks a model exhausted when every candidate key is rate-limited or invalid', async () => {
    await seedModel('groq', 'exhausted-model');
    await seedKey('groq', 'rate_limited');
    await seedKey('groq', 'invalid');
    expect(statusFor('exhausted-model')).toBe('exhausted');
  });

  it('stays ready when at least one of several keys is healthy', async () => {
    await seedModel('groq', 'mixed-model');
    await seedKey('groq', 'invalid');
    await seedKey('groq', 'healthy');
    expect(statusFor('mixed-model')).toBe('ready');
  });

  it('marks a disabled model needsKey regardless of keys', async () => {
    await seedModel('groq', 'disabled-model', 0);
    await seedKey('groq', 'healthy');
    expect(statusFor('disabled-model')).toBe('needsKey');
  });

  it('marks a model exhausted when its only key is on cooldown', async () => {
    await seedModel('groq', 'cooling-model');
    const keyId = await seedKey('groq', 'healthy');
    setCooldown('groq', 'cooling-model', keyId, 60_000, 'header');
    expect(statusFor('cooling-model')).toBe('exhausted');
  });

  it('stays ready when a sibling key is not on cooldown', async () => {
    await seedModel('groq', 'sibling-model');
    const cooling = await seedKey('groq', 'healthy');
    await seedKey('groq', 'healthy');
    setCooldown('groq', 'sibling-model', cooling, 60_000, 'header');
    expect(statusFor('sibling-model')).toBe('ready');
  });

  it('ignores a key scoped away from the model', async () => {
    await seedModel('groq', 'scoped-out-model');
    await seedKey('groq', 'healthy', 1, ['some-other-model']);
    expect(statusFor('scoped-out-model')).toBe('exhausted');
  });

  it('counts a key scoped to the model itself', async () => {
    await seedModel('groq', 'scoped-in-model');
    await seedKey('groq', 'healthy', 1, ['scoped-in-model']);
    expect(statusFor('scoped-in-model')).toBe('ready');
  });
});
