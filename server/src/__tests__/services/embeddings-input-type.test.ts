// Asymmetric embedding endpoints (NVIDIA's Nemotron 3.5 family) keep "query"
// and "passage" in different vector spaces and refuse a request that carries
// no input_type:
//
//   HTTP 400 "'input_type' parameter is required for asymmetric models"
//
// The native nvidia adapter always sent input_type: 'query', but a CUSTOM
// endpoint had no way to say it — so an operator could not even REGISTER such
// a model: the dimension probe failed with the same 400 upstream sends.
//
// These cover the three places the value has to reach:
//   1. the outgoing request body (the request path),
//   2. the dimension probe (the registration path),
//   3. the stored row (so the choice survives a restart).
//
// And the two things that must NOT change: a symmetric custom endpoint keeps
// sending exactly the body it sent before, and a stored value is never dropped
// by a submit that stayed silent about it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  asEmbeddingInputType,
  probeEmbeddingDimensions,
  registerCustomEmbeddingModel,
  runEmbeddings,
} from '../../services/embeddings.js';
import { stubPublicDns } from '../helpers/dns.js';

// Fake relay hosts must resolve for the URL guard (#1875).
beforeEach(() => stubPublicDns());

const realFetch = globalThis.fetch;

function addCustomKey(baseUrl: string, raw = 'custom-test-key'): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  return Number(row.lastInsertRowid);
}

function okEmbeddingResponse(dims: number, count = 1) {
  return new Response(JSON.stringify({
    data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: Array(dims).fill(0.1) })),
    usage: { prompt_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Typed fetch mock so .mock.calls is properly indexed without `as any` on
// every call site — the same pattern the rest of the suite uses.
function mockFetch(impl: typeof fetch): MockedFunction<typeof fetch> {
  const m = vi.fn(impl) as MockedFunction<typeof fetch>;
  globalThis.fetch = m as unknown as typeof fetch;
  return m;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('custom embedding input_type', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('asEmbeddingInputType', () => {
    it('narrows the two values the wire contract defines', () => {
      expect(asEmbeddingInputType('query')).toBe('query');
      expect(asEmbeddingInputType('passage')).toBe('passage');
    });

    it('treats anything else as no opinion rather than forwarding it', () => {
      // The column is TEXT, so a hand-edited row could hold anything. A bogus
      // input_type is as fatal upstream as a missing one, so it is dropped
      // rather than passed through.
      expect(asEmbeddingInputType(null)).toBeNull();
      expect(asEmbeddingInputType(undefined)).toBeNull();
      expect(asEmbeddingInputType('')).toBeNull();
      expect(asEmbeddingInputType('Query')).toBeNull();
      expect(asEmbeddingInputType('search_document')).toBeNull();
      expect(asEmbeddingInputType('document')).toBeNull();
    });
  });

  describe('registration', () => {
    it('stores the input_type a custom endpoint was registered with', () => {
      const keyId = addCustomKey('https://embeddings.example/v1');

      const { modelDbId, created } = registerCustomEmbeddingModel(getDb(), {
        keyId,
        modelId: 'nemotron-embed',
        displayName: 'Nemotron Embed',
        family: 'nemotron-embed',
        dimensions: 2048,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
        inputType: 'query',
      });

      expect(created).toBe(true);
      const row = getDb().prepare('SELECT input_type FROM embedding_models WHERE id = ?').get(modelDbId) as { input_type: string | null };
      expect(row.input_type).toBe('query');
    });

    it('leaves input_type NULL for an endpoint registered without one', () => {
      const keyId = addCustomKey('https://embeddings.example/v1');

      const { modelDbId } = registerCustomEmbeddingModel(getDb(), {
        keyId,
        modelId: 'bge-m3',
        displayName: 'BGE M3',
        family: 'bge-m3',
        dimensions: 1024,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      });

      const row = getDb().prepare('SELECT input_type FROM embedding_models WHERE id = ?').get(modelDbId) as { input_type: string | null };
      expect(row.input_type).toBeNull();
    });

    it('keeps the stored input_type when a later submit stays silent about it', () => {
      const keyId = addCustomKey('https://embeddings.example/v1');
      const reg = {
        keyId,
        modelId: 'nemotron-embed',
        displayName: 'Nemotron Embed',
        family: 'nemotron-embed',
        dimensions: 2048,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      };
      registerCustomEmbeddingModel(getDb(), { ...reg, inputType: 'query' });

      // A re-submit that says nothing (a rename, a family change) must not
      // drop the choice: an asymmetric endpoint that no longer names its side
      // answers every request with a 400.
      const { modelDbId, created } = registerCustomEmbeddingModel(getDb(), reg);

      expect(created).toBe(false);
      const row = getDb().prepare('SELECT input_type FROM embedding_models WHERE id = ?').get(modelDbId) as { input_type: string | null };
      expect(row.input_type).toBe('query');
    });

    it('replaces a stored input_type when a later submit names a different one', () => {
      const keyId = addCustomKey('https://embeddings.example/v1');
      const reg = {
        keyId,
        modelId: 'nemotron-embed',
        displayName: 'Nemotron Embed',
        family: 'nemotron-embed',
        dimensions: 2048,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      };
      registerCustomEmbeddingModel(getDb(), { ...reg, inputType: 'query' });
      const { modelDbId } = registerCustomEmbeddingModel(getDb(), { ...reg, inputType: 'passage' });

      const row = getDb().prepare('SELECT input_type FROM embedding_models WHERE id = ?').get(modelDbId) as { input_type: string | null };
      expect(row.input_type).toBe('passage');
    });

    it('clears a stored input_type when the operator declares the endpoint symmetric', () => {
      const keyId = addCustomKey('https://embeddings.example/v1');
      const reg = {
        keyId,
        modelId: 'nemotron-embed',
        displayName: 'Nemotron Embed',
        family: 'nemotron-embed',
        dimensions: 2048,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      };
      registerCustomEmbeddingModel(getDb(), { ...reg, inputType: 'query' });
      // An explicit null is the operator saying "this endpoint is symmetric" —
      // the opposite of "no opinion", which keeps the stored value.
      const { modelDbId } = registerCustomEmbeddingModel(getDb(), { ...reg, inputType: null });

      const row = getDb().prepare('SELECT input_type FROM embedding_models WHERE id = ?').get(modelDbId) as { input_type: string | null };
      expect(row.input_type).toBeNull();
    });
  });

  describe('the dimension probe', () => {
    it('includes the input_type so an asymmetric endpoint answers the probe', async () => {
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2048));

      const dims = await probeEmbeddingDimensions('https://embeddings.example/v1', 'key', 'nemotron-embed', 'query');

      expect(dims).toBe(2048);
      expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ model: 'nemotron-embed', input_type: 'query' });
    });

    it('sends no input_type at all when none was named', async () => {
      const fetchMock = mockFetch(async () => okEmbeddingResponse(1024));

      await probeEmbeddingDimensions('https://embeddings.example/v1', 'key', 'bge-m3');

      const body = bodyOf(fetchMock.mock.calls[0]);
      // Not merely "no input_type value" — the field must be ABSENT, because
      // symmetric providers reject an unknown field.
      expect(body).not.toHaveProperty('input_type');
      expect(body).toEqual({ model: 'bge-m3', input: ['dimension probe'] });
    });
  });

  describe('the request path', () => {
    it('sends the input_type the model was registered with', async () => {
      const keyId = addCustomKey('http://127.0.0.1:8181/v1', 'asymmetric-key');
      getDb().prepare(`
        INSERT INTO embedding_models
          (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id, input_type)
        VALUES ('nemotron-embed', 'custom', 'nemotron-embed', 'Nemotron Embed', 2, NULL, 1, 1, '', ?, 'passage')
      `).run(keyId);
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2));

      const result = await runEmbeddings('nemotron-embed', ['hello']);

      expect(result.dimensions).toBe(2);
      expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ model: 'nemotron-embed', input: ['hello'], input_type: 'passage' });
    });

    it('sends a byte-identical body for a custom endpoint without an input_type', async () => {
      // The backward-compatibility guarantee. A symmetric endpoint (bge-m3,
      // text-embedding-3-*) has never seen an input_type field, and some of
      // them reject one outright.
      const keyId = addCustomKey('http://127.0.0.1:8181/v1', 'symmetric-key');
      getDb().prepare(`
        INSERT INTO embedding_models
          (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
        VALUES ('symmetric-embed', 'custom', 'symmetric-embed', 'Symmetric Embed', 2, NULL, 1, 1, '', ?)
      `).run(keyId);
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2));

      await runEmbeddings('symmetric-embed', ['hello']);

      const body = bodyOf(fetchMock.mock.calls[0]);
      expect(body).not.toHaveProperty('input_type');
      expect(body).toEqual({ model: 'symmetric-embed', input: ['hello'] });
    });

    it('sends no input_type when the stored value is not one of the two the contract defines', async () => {
      // A hand-edited row must not put a bogus input_type on the wire.
      const keyId = addCustomKey('http://127.0.0.1:8181/v1', 'odd-key');
      getDb().prepare(`
        INSERT INTO embedding_models
          (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id, input_type)
        VALUES ('odd-embed', 'custom', 'odd-embed', 'Odd Embed', 2, NULL, 1, 1, '', ?, 'search_document')
      `).run(keyId);
      const fetchMock = mockFetch(async () => okEmbeddingResponse(2));

      await runEmbeddings('odd-embed', ['hello']);

      expect(bodyOf(fetchMock.mock.calls[0])).not.toHaveProperty('input_type');
    });
  });
});
