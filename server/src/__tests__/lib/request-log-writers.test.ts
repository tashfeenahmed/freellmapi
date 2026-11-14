// Every `requests` row must reach the durable aggregates (request_hourly + the
// lifetime settings counters). Embeddings, media and moderation used to write
// their rows with a raw INSERT, so the dashboard's headline totals, its
// timeline and the MCP usage summary silently left that traffic out while the
// by-model and recent-request views (which read the raw table) included it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { logRequest } from '../../lib/request-log.js';
import { runEmbeddings } from '../../services/embeddings.js';
import { runImageGeneration } from '../../services/media.js';
import { runModerations } from '../../services/moderation.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import * as urlGuard from '../../lib/url-guard.js';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function addKey(platform: string, baseUrl: string | null = null): number {
  const s = encrypt(`${platform}-key`);
  return Number(getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?)`).run(platform, s.encrypted, s.iv, s.authTag, baseUrl).lastInsertRowid);
}

function addEmbedding(modelId: string, priority: number, keyId: number) {
  getDb().prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
    VALUES ('agg-embed', 'custom', ?, ?, 2, ?, 1, '', ?)`).run(modelId, modelId, priority, keyId);
}

function hourly() {
  return getDb().prepare(`SELECT COALESCE(SUM(total_requests), 0) AS total, COALESCE(SUM(success_count), 0) AS ok,
    COALESCE(SUM(error_count), 0) AS err, COALESCE(SUM(input_tokens), 0) AS input FROM request_hourly`).get() as
    { total: number; ok: number; err: number; input: number };
}

function lifetime(key: string): number {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return Number(row?.value ?? 0);
}

function rawCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
}

describe('every request writer feeds the durable aggregates', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    clearAllCooldowns();
    // proxyFetch re-checks a custom base URL by DNS (#1879); the .test hosts
    // never resolve, and the guard is not what this suite is about.
    vi.spyOn(urlGuard, 'assertProviderUrlAllowed').mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('logRequest keeps writing chat rows by default', () => {
    logRequest('groq', 'llama', null, 'success', 5, 7, 10, null);
    const row = getDb().prepare('SELECT request_type FROM requests').get() as { request_type: string };
    expect(row.request_type).toBe('chat');
    expect(hourly()).toMatchObject({ total: 1, ok: 1, err: 0, input: 5 });
  });

  it('a non-chat row is never attributed to a chat models row that shares its id', () => {
    getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('groq', 'same-id', 'same-id', 1, 1, 'Small', 1)`).run();
    logRequest('groq', 'same-id', null, 'success', 0, 0, 1, null, null, null, null, null, null, 'embedding');
    const row = getDb().prepare('SELECT request_type, model_db_id FROM requests').get() as { request_type: string; model_db_id: number | null };
    expect(row).toEqual({ request_type: 'embedding', model_db_id: null });
  });

  it('embeddings: every attempt row reaches request_hourly and the lifetime totals', async () => {
    addEmbedding('agg-bad', 1, addKey('custom', 'http://bad.test/v1'));
    addEmbedding('agg-ok', 2, addKey('custom', 'http://ok.test/v1'));
    globalThis.fetch = vi.fn(async (url: string) => String(url).includes('ok.test')
      ? json({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4 } })
      : new Response('boom', { status: 500 })) as unknown as typeof fetch;

    await runEmbeddings('agg-embed', ['hello']);

    const types = getDb().prepare('SELECT request_type, status FROM requests ORDER BY id').all();
    expect(types).toEqual([
      { request_type: 'embedding', status: 'error' },
      { request_type: 'embedding', status: 'success' },
    ]);
    expect(hourly()).toMatchObject({ total: 2, ok: 1, err: 1, input: 4 });
    expect(lifetime('total_requests')).toBe(2);
    expect(lifetime('total_input_tokens')).toBe(4);
  });

  it('media: an image row reaches request_hourly and keeps its modality as request_type', async () => {
    const keyId = addKey('custom', 'http://img.test/v1');
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
      VALUES ('custom', 'agg-image', 'agg-image', 'image', 1, 1, '', ?)`).run(keyId);
    globalThis.fetch = vi.fn(async () => json({ data: [{ url: 'https://example.test/x.png' }] })) as unknown as typeof fetch;

    await runImageGeneration('agg-image', { prompt: 'a cat' });

    const row = getDb().prepare('SELECT request_type, status, key_id FROM requests').get();
    expect(row).toEqual({ request_type: 'image', status: 'success', key_id: keyId });
    expect(hourly()).toMatchObject({ total: 1, ok: 1, err: 0 });
    expect(lifetime('total_requests')).toBe(1);
  });

  it('moderation: a moderation row reaches request_hourly', async () => {
    const keyId = addKey('openai');
    globalThis.fetch = vi.fn(async () => json({
      id: 'modr-1', model: 'omni-moderation-latest',
      results: [{ flagged: false, categories: {}, category_scores: {} }],
    })) as unknown as typeof fetch;

    await runModerations(undefined, ['hello']);

    const row = getDb().prepare('SELECT request_type, status, key_id FROM requests').get();
    expect(row).toEqual({ request_type: 'moderation', status: 'success', key_id: keyId });
    expect(hourly()).toMatchObject({ total: 1, ok: 1, err: 0 });
    expect(lifetime('total_requests')).toBe(1);
  });

  it('the aggregate never disagrees with the raw row count across writers', async () => {
    logRequest('groq', 'llama', null, 'canceled', 0, 0, 1, null);
    addEmbedding('agg-ok', 1, addKey('custom', 'http://ok.test/v1'));
    globalThis.fetch = vi.fn(async () => json({ data: [{ index: 0, embedding: [0.1, 0.2] }] })) as unknown as typeof fetch;
    await runEmbeddings('agg-embed', ['hello']);

    expect(hourly().total).toBe(rawCount());
    expect(lifetime('total_requests')).toBe(rawCount());
  });
});
