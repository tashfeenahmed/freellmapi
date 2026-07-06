import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, setSetting } from '../../db/index.js';
import {
  computeCacheKey,
  getCachedResponse,
  storeCachedResponse,
  getCacheStats,
  clearCache,
  isCacheableTemperature,
  parseCacheDirective,
  cacheActive,
  isCacheEnabled,
  CACHE_ENABLED_SETTING,
} from '../../services/cache.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const CACHE_ENV = [
  'RESPONSE_CACHE',
  'RESPONSE_CACHE_TTL_SECONDS',
  'RESPONSE_CACHE_MAX_TEMPERATURE',
  'RESPONSE_CACHE_MAX_ENTRIES',
] as const;

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

const sampleBody = (text: string) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const store = (key: string, text: string, now?: number) =>
  storeCachedResponse(key, {
    body: sampleBody(text),
    platform: 'groq',
    modelId: 'llama-3.3-70b',
    keyId: 7,
    promptTokens: 10,
    completionTokens: 5,
  }, now);

describe('response cache', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const k of CACHE_ENV) saved[k] = process.env[k];
    // Fresh in-memory DB per test so the settings-backed toggle is isolated.
    initDb(':memory:');
    // The cache is module-level in-memory state: flush it between tests.
    clearCache();
  });

  afterEach(() => {
    clearCache();
    for (const k of CACHE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  describe('computeCacheKey', () => {
    it('is stable regardless of object key order', () => {
      const messages = [msg('user', 'hello')];
      const a = computeCacheKey({ model: 'auto', messages, temperature: 0.2, top_p: 1 });
      const b = computeCacheKey({ messages, top_p: 1, temperature: 0.2, model: 'auto' });
      expect(a).toBe(b);
    });

    it('treats omitted model and "auto" as the same bucket', () => {
      const messages = [msg('user', 'hello')];
      expect(computeCacheKey({ model: undefined, messages }))
        .toBe(computeCacheKey({ model: 'auto', messages }));
    });

    it('changes when the prompt changes', () => {
      expect(computeCacheKey({ model: 'auto', messages: [msg('user', 'a')] }))
        .not.toBe(computeCacheKey({ model: 'auto', messages: [msg('user', 'b')] }));
    });

    it('changes when sampling params change', () => {
      const messages = [msg('user', 'hello')];
      expect(computeCacheKey({ model: 'auto', messages, temperature: 0 }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, temperature: 0.9 }));
    });

    it('distinguishes a pinned model from auto', () => {
      const messages = [msg('user', 'hello')];
      expect(computeCacheKey({ model: 'gpt-oss-120b', messages }))
        .not.toBe(computeCacheKey({ model: 'auto', messages }));
    });

    // Tools policy: a tool-bearing request is cacheable, but its tool set is
    // part of the key, so a different tool set is a MISS and never serves
    // another request's cached answer.
    it('changes when the tool set changes (no cross-tool contamination)', () => {
      const messages = [msg('user', 'call a tool')];
      const toolsA = [{ type: 'function', function: { name: 'Read' } }];
      const toolsB = [{ type: 'function', function: { name: 'Write' } }];
      expect(computeCacheKey({ model: 'auto', messages, tools: toolsA }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, tools: toolsB }));
      // Same tools + same prompt collapse to the same key.
      expect(computeCacheKey({ model: 'auto', messages, tools: toolsA }))
        .toBe(computeCacheKey({ model: 'auto', messages, tools: toolsA }));
      // A tools request differs from the tool-free version of the same prompt.
      expect(computeCacheKey({ model: 'auto', messages, tools: toolsA }))
        .not.toBe(computeCacheKey({ model: 'auto', messages }));
    });

    // Collision guard for the remaining sampling/format knobs: requests that
    // differ ONLY in one of these must never share a key, or one could be
    // served the other's cached answer (worst case: a response_format
    // json_object request replayed a cached plain-text reply).
    it('changes when response_format changes (json_object vs none)', () => {
      const messages = [msg('user', 'give me data')];
      expect(computeCacheKey({ model: 'auto', messages, response_format: { type: 'json_object' } }))
        .not.toBe(computeCacheKey({ model: 'auto', messages }));
      expect(computeCacheKey({ model: 'auto', messages, response_format: { type: 'json_object' } }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, response_format: { type: 'text' } }));
    });

    it('changes when stop, seed, or n change', () => {
      const messages = [msg('user', 'hello')];
      const base = computeCacheKey({ model: 'auto', messages });
      expect(computeCacheKey({ model: 'auto', messages, stop: ['\n'] })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, stop: 'END' }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, stop: 'STOP' }));
      expect(computeCacheKey({ model: 'auto', messages, seed: 42 })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, seed: 42 }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, seed: 43 }));
      expect(computeCacheKey({ model: 'auto', messages, n: 2 })).not.toBe(base);
    });

    it('changes when penalties, logit_bias, or logprobs knobs change', () => {
      const messages = [msg('user', 'hello')];
      const base = computeCacheKey({ model: 'auto', messages });
      expect(computeCacheKey({ model: 'auto', messages, presence_penalty: 0.5 })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, frequency_penalty: 0.5 })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, logit_bias: { '50256': -100 } })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, logprobs: true })).not.toBe(base);
      expect(computeCacheKey({ model: 'auto', messages, logprobs: true, top_logprobs: 5 }))
        .not.toBe(computeCacheKey({ model: 'auto', messages, logprobs: true }));
    });

    it('identical requests with the new knobs present collapse to the same key', () => {
      const messages = [msg('user', 'give me data')];
      const full = () => computeCacheKey({
        model: 'auto', messages, temperature: 0.1,
        response_format: { type: 'json_object' },
        stop: ['END', 'STOP'], n: 1, seed: 42,
        presence_penalty: 0.25, frequency_penalty: 0.5,
        logit_bias: { '50256': -100 }, logprobs: true, top_logprobs: 3,
      });
      expect(full()).toBe(full());
      // Key-order independence holds for the new fields too.
      expect(computeCacheKey({ seed: 42, stop: 'END', model: 'auto', messages } as any))
        .toBe(computeCacheKey({ model: 'auto', messages, stop: 'END', seed: 42 }));
      // And absent knobs still hash like before (undefined dropped, not null-ed).
      expect(computeCacheKey({ model: 'auto', messages, seed: undefined }))
        .toBe(computeCacheKey({ model: 'auto', messages }));
    });
  });

  describe('store / get round-trip', () => {
    it('returns null on a miss', () => {
      expect(getCachedResponse('does-not-exist')).toBeNull();
    });

    it('returns the stored body on a hit', () => {
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      store(key, 'cached answer');
      const hit = getCachedResponse(key);
      expect(hit).not.toBeNull();
      expect((hit!.body as any).choices[0].message.content).toBe('cached answer');
      expect(hit!.platform).toBe('groq');
      expect(hit!.modelId).toBe('llama-3.3-70b');
      expect(hit!.keyId).toBe(7);
      expect(hit!.promptTokens).toBe(10);
      expect(hit!.completionTokens).toBe(5);
    });

    it('overwrites and refreshes an existing entry', () => {
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      store(key, 'first');
      store(key, 'second');
      expect((getCachedResponse(key)!.body as any).choices[0].message.content).toBe('second');
      expect(getCacheStats().entries).toBe(1);
    });

    it('skips an unserializable body rather than throwing', () => {
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      const circular: any = {};
      circular.self = circular;
      storeCachedResponse(key, {
        body: circular, platform: 'groq', modelId: 'm', keyId: 1, promptTokens: 1, completionTokens: 1,
      });
      expect(getCacheStats().entries).toBe(0);
      expect(getCachedResponse(key)).toBeNull();
    });
  });

  describe('TTL expiry', () => {
    it('treats an entry older than the TTL as a miss and deletes it', () => {
      process.env.RESPONSE_CACHE_TTL_SECONDS = '1';
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      const t0 = 1_000_000;
      store(key, 'stale', t0);
      // 2s later, past the 1s TTL → miss.
      expect(getCachedResponse(key, t0 + 2000)).toBeNull();
      // The expired entry was purged.
      expect(getCacheStats().entries).toBe(0);
    });

    it('serves an entry still within the TTL', () => {
      process.env.RESPONSE_CACHE_TTL_SECONDS = '60';
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      const t0 = 1_000_000;
      store(key, 'fresh', t0);
      expect(getCachedResponse(key, t0 + 30_000)).not.toBeNull();
    });
  });

  describe('hit accounting', () => {
    it('counts hits and tallies saved tokens', () => {
      const key = computeCacheKey({ model: 'auto', messages: [msg('user', 'hi')] });
      store(key, 'answer');
      getCachedResponse(key);
      getCachedResponse(key);
      getCachedResponse(key);
      const stats = getCacheStats();
      expect(stats.entries).toBe(1);
      expect(stats.totalHits).toBe(3);
      expect(stats.savedPromptTokens).toBe(30); // 3 hits × 10
      expect(stats.savedCompletionTokens).toBe(15); // 3 hits × 5
    });
  });

  describe('entry cap eviction (LRU)', () => {
    it('evicts the oldest entries past RESPONSE_CACHE_MAX_ENTRIES', () => {
      process.env.RESPONSE_CACHE_MAX_ENTRIES = '3';
      // Realistic, increasing timestamps so reads stay inside the default TTL;
      // the point under test is eviction by count, not TTL expiry.
      const base = 1_700_000_000_000;
      const keys = ['a', 'b', 'c', 'd', 'e'].map(t =>
        computeCacheKey({ model: 'auto', messages: [msg('user', t)] }));
      keys.forEach((k, i) => store(k, `v${i}`, base + i));

      expect(getCacheStats().entries).toBe(3);
      // Two oldest gone, three newest survive.
      expect(getCachedResponse(keys[0]!, base + 10)).toBeNull();
      expect(getCachedResponse(keys[1]!, base + 10)).toBeNull();
      expect(getCachedResponse(keys[4]!, base + 10)).not.toBeNull();
    });

    it('spares a recently-read entry from eviction (true LRU, not FIFO)', () => {
      process.env.RESPONSE_CACHE_MAX_ENTRIES = '3';
      const base = 1_700_000_000_000;
      const keys = ['a', 'b', 'c'].map(t =>
        computeCacheKey({ model: 'auto', messages: [msg('user', t)] }));
      keys.forEach((k, i) => store(k, `v${i}`, base + i)); // a,b,c
      // Touch 'a' so it becomes most-recently-used; 'b' is now the coldest.
      expect(getCachedResponse(keys[0]!, base + 5)).not.toBeNull();
      // Insert a 4th → evicts the LRU, which is now 'b', NOT 'a'.
      const d = computeCacheKey({ model: 'auto', messages: [msg('user', 'd')] });
      store(d, 'v3', base + 6);
      expect(getCachedResponse(keys[0]!, base + 7)).not.toBeNull(); // 'a' survived
      expect(getCachedResponse(keys[1]!, base + 7)).toBeNull();     // 'b' evicted
    });
  });

  describe('clearCache', () => {
    it('removes every entry', () => {
      store(computeCacheKey({ model: 'auto', messages: [msg('user', 'x')] }), 'x');
      store(computeCacheKey({ model: 'auto', messages: [msg('user', 'y')] }), 'y');
      expect(clearCache()).toBe(2);
      expect(getCacheStats().entries).toBe(0);
    });
  });

  describe('temperature guard', () => {
    it('caches omitted temperature', () => {
      expect(isCacheableTemperature(undefined)).toBe(true);
    });
    it('respects RESPONSE_CACHE_MAX_TEMPERATURE', () => {
      process.env.RESPONSE_CACHE_MAX_TEMPERATURE = '0.5';
      expect(isCacheableTemperature(0.2)).toBe(true);
      expect(isCacheableTemperature(0.5)).toBe(true);
      expect(isCacheableTemperature(0.9)).toBe(false);
    });
  });

  describe('directive parsing', () => {
    it('parses off/on aliases', () => {
      expect(parseCacheDirective('off')).toBe('off');
      expect(parseCacheDirective('bypass')).toBe('off');
      expect(parseCacheDirective('on')).toBe('on');
      expect(parseCacheDirective('force')).toBe('on');
      expect(parseCacheDirective(undefined)).toBe('default');
    });

    it('treats Cache-Control: no-store as off', () => {
      expect(parseCacheDirective(undefined, 'no-store')).toBe('off');
    });

    it('takes the first value of a repeated header', () => {
      expect(parseCacheDirective(['off', 'on'])).toBe('off');
    });
  });

  describe('cacheActive (env switch)', () => {
    it('off directive always wins; on directive forces; default follows env', () => {
      delete process.env.RESPONSE_CACHE;
      expect(isCacheEnabled()).toBe(false);
      expect(cacheActive('off')).toBe(false);
      expect(cacheActive('on')).toBe(true);
      expect(cacheActive('default')).toBe(false);
      process.env.RESPONSE_CACHE = 'on';
      expect(cacheActive('default')).toBe(true);
      expect(cacheActive('off')).toBe(false);
    });
  });

  describe('settings-backed toggle (no restart)', () => {
    it('the stored setting enables the cache even with the env var unset', () => {
      delete process.env.RESPONSE_CACHE;
      expect(isCacheEnabled()).toBe(false);
      setSetting(CACHE_ENABLED_SETTING, '1');
      expect(isCacheEnabled()).toBe(true);
    });

    it('the stored setting wins over the env var', () => {
      process.env.RESPONSE_CACHE = 'on';
      setSetting(CACHE_ENABLED_SETTING, '0');
      expect(isCacheEnabled()).toBe(false); // explicit off beats env on
      setSetting(CACHE_ENABLED_SETTING, ''); // cleared → fall back to env
      expect(isCacheEnabled()).toBe(true);
    });
  });
});
