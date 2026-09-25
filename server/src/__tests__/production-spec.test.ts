import { describe, it, expect, beforeEach } from 'vitest';
import { initEncryptionKey, encrypt, decrypt, maskKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import { RouterRegistry, type ProviderRecord, type CredentialRecord, type ModelRecord } from '../services/router-registry.js';
import { matchModelImplementations, computeRouteScore, SmartRouterError } from '../services/smart-router.js';
import { analyticsAggregator } from '../services/analytics-aggregator.js';
import { initPostgresPool } from '../db/postgres.js';
import { runMigrations, getMigrationStatuses } from '../db/migrate/runner.js';

describe('Production Implementation Specification Tests', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.NODE_ENV = 'test';
    initEncryptionKey();
  });

  describe('1. Credential Security & AES-256-GCM Encryption', () => {
    it('encrypts and decrypts API keys correctly', () => {
      expect(isEncryptionKeyInitialized()).toBe(true);
      const plaintext = 'sk-or-v1-abcdef1234567890abcdef1234567890';
      const { encrypted, iv, authTag } = encrypt(plaintext);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toBeDefined();
      expect(iv).toBeDefined();
      expect(authTag).toBeDefined();

      const decrypted = decrypt(encrypted, iv, authTag);
      expect(decrypted).toBe(plaintext);
    });

    it('masks credentials securely for frontend display', () => {
      const plaintext = 'sk-or-v1-abcdef1234567890abcdef1234567890';
      const masked = maskKey(plaintext);
      expect(masked).not.toBe(plaintext);
      expect(masked.startsWith('sk-or-v1-')).toBe(true);
      expect(masked.includes('\u2022\u2022\u2022\u2022')).toBe(true);
      expect(masked.endsWith('7890')).toBe(true);
    });

    it('never leaks plaintext on invalid decryption attempts', () => {
      const { encrypted, iv } = encrypt('my-secret-key');
      const fakeAuthTag = '00000000000000000000000000000000';
      expect(() => decrypt(encrypted, iv, fakeAuthTag)).toThrow();
    });
  });

  describe('2. In-Memory Routing Registry & Capability Filtering', () => {
    const mockProviders: ProviderRecord[] = [
      {
        id: 1,
        key: 'openrouter',
        displayName: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        enabled: true,
        priority: 10,
      },
      {
        id: 2,
        key: 'groq',
        displayName: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        enabled: true,
        priority: 20,
      },
    ];

    const mockCredentials: CredentialRecord[] = [
      {
        id: 101,
        providerId: 1,
        providerKey: 'openrouter',
        name: 'OpenRouter Key 1',
        decryptedKey: 'sk-or-key1',
        maskedKey: 'sk-or-\u2022\u2022\u2022\u2022key1',
        credentialType: 'api_key',
        enabled: true,
        priority: 5,
        modelScope: null,
        runtime: {
          activeRequests: 0,
          circuitState: 'HEALTHY',
          cooldownUntil: 0,
          ewmaLatencyMs: 220,
          rollingSuccessCount: 50,
          rollingFailureCount: 0,
          rolling429Count: 0,
          lastUsedAt: null,
          lastFailedAt: null,
        },
      },
      {
        id: 102,
        providerId: 2,
        providerKey: 'groq',
        name: 'Groq Key 1',
        decryptedKey: 'gsk-key1',
        maskedKey: 'gsk-\u2022\u2022\u2022\u2022key1',
        credentialType: 'api_key',
        enabled: true,
        priority: 10,
        modelScope: null,
        runtime: {
          activeRequests: 0,
          circuitState: 'HEALTHY',
          cooldownUntil: 0,
          ewmaLatencyMs: 90,
          rollingSuccessCount: 80,
          rollingFailureCount: 0,
          rolling429Count: 0,
          lastUsedAt: null,
          lastFailedAt: null,
        },
      },
    ];

    const mockModels: ModelRecord[] = [
      {
        id: 201,
        providerId: 1,
        providerKey: 'openrouter',
        modelId: 'meta-llama/llama-3.3-70b-instruct',
        canonicalName: 'llama-3.3-70b',
        displayName: 'Llama 3.3 70B (OpenRouter)',
        enabled: true,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        capabilities: { streaming: true, tools: true, vision: true, structuredOutput: true, reasoning: false },
        inputPrice: 0,
        outputPrice: 0,
        priority: 5,
      },
      {
        id: 202,
        providerId: 2,
        providerKey: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        canonicalName: 'llama-3.3-70b',
        displayName: 'Llama 3.3 70B Versatile (Groq)',
        enabled: true,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        capabilities: { streaming: true, tools: true, vision: false, structuredOutput: true, reasoning: false },
        inputPrice: 0,
        outputPrice: 0,
        priority: 10,
      },
    ];

    it('correctly maps canonical model to candidate providers', () => {
      const registry = new RouterRegistry(mockProviders, mockCredentials, mockModels);
      const candidates = registry.findModelCandidates('llama-3.3-70b');
      expect(candidates.length).toBe(2);
      expect(candidates.map(c => c.providerKey)).toContain('openrouter');
      expect(candidates.map(c => c.providerKey)).toContain('groq');
    });

    it('enforces capability requirements without silent downgrade (e.g. vision support)', () => {
      const registry = new RouterRegistry(mockProviders, mockCredentials, mockModels);

      // Vision required: Groq does not support vision on llama-3.3-70b, only OpenRouter does
      const routes = matchModelImplementations(registry, {
        requestedModel: 'llama-3.3-70b',
        messages: [],
        streaming: false,
        vision: true,
        structuredOutput: false,
        reasoning: false,
      });

      expect(routes.length).toBe(1);
      expect(routes[0].provider.key).toBe('openrouter');
    });

    it('throws NO_CAPABLE_PROVIDER when requested capability is unsupported by all candidates', () => {
      const registry = new RouterRegistry(mockProviders, mockCredentials, mockModels);

      expect(() => {
        matchModelImplementations(registry, {
          requestedModel: 'llama-3.3-70b',
          messages: [],
          streaming: false,
          vision: false,
          structuredOutput: false,
          reasoning: true, // Neither provider supports reasoning on this model
        });
      }).toThrowError(SmartRouterError);
    });

    it('ranks candidates by speed/health/priority scoring', () => {
      const scoreOpenRouter = computeRouteScore(mockModels[0], mockProviders[0], mockCredentials[0]);
      const scoreGroq = computeRouteScore(mockModels[1], mockProviders[1], mockCredentials[1]);

      // Groq has lower latency (90ms vs 220ms) and higher priority (20 vs 10)
      expect(scoreGroq).toBeGreaterThan(scoreOpenRouter);
    });

    it('isolates 429 cooldown to specific exhausted credential without disabling provider', () => {
      const credsWithCooldown = [
        {
          ...mockCredentials[0],
          id: 101,
          runtime: { ...mockCredentials[0].runtime, cooldownUntil: Date.now() + 60000 },
        },
        {
          ...mockCredentials[0],
          id: 103,
          name: 'OpenRouter Key 2 (Healthy)',
          runtime: { ...mockCredentials[0].runtime, cooldownUntil: 0 },
        },
      ];

      const registry = new RouterRegistry(mockProviders, credsWithCooldown, [mockModels[0]]);
      const routes = matchModelImplementations(registry, {
        requestedModel: 'llama-3.3-70b',
        messages: [],
        streaming: false,
        vision: false,
        structuredOutput: false,
        reasoning: false,
      });

      // Key 101 is cooling down, Key 103 should be selected
      expect(routes.length).toBe(1);
      expect(routes[0].credential.id).toBe(103);
    });
  });

  describe('3. Memory-First Analytics Aggregator & Batch Persistence', () => {
    it('aggregates request telemetry in memory into hourly buckets', () => {
      analyticsAggregator.record({
        providerId: 1,
        providerKey: 'openrouter',
        modelId: 'llama-3.3-70b',
        success: true,
        inputTokens: 150,
        outputTokens: 75,
        totalTokens: 225,
        latencyMs: 310,
      });

      analyticsAggregator.record({
        providerId: 1,
        providerKey: 'openrouter',
        modelId: 'llama-3.3-70b',
        success: true,
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
        latencyMs: 190,
      });

      const buffer = analyticsAggregator.getUnflushedBuffer();
      expect(buffer.length).toBeGreaterThan(0);

      const bucket = buffer.find(b => b.providerId === 1 && b.modelId === 'llama-3.3-70b');
      expect(bucket).toBeDefined();
      expect(bucket!.requestCount).toBeGreaterThanOrEqual(2);
      expect(bucket!.inputTokens).toBeGreaterThanOrEqual(200);
      expect(bucket!.outputTokens).toBeGreaterThanOrEqual(100);
      expect(bucket!.totalTokens).toBeGreaterThanOrEqual(300);
    });
  });

  describe('4. PostgreSQL Migration & Schema Validation', () => {
    it('runs migrations and tracks status', async () => {
      const pool = initPostgresPool();
      await runMigrations(pool, 'up');
      const statuses = await getMigrationStatuses(pool);

      expect(statuses.length).toBe(4);
      expect(statuses[0].filename).toBe('001_initial_schema.ts');
      expect(statuses[0].status).toBe('applied');
      expect(statuses[1].filename).toBe('002_seed_providers_models.ts');
      expect(statuses[1].status).toBe('applied');
    });
  });
});
