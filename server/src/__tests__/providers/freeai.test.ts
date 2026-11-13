import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeAiProvider, freeAiAudioUrl } from '../../providers/freeai.js';
import { hasProvider } from '../../providers/index.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { checkKeyHealth } from '../../services/health.js';

const audioUrl = 'https://api.free.ai/static/outputs/1bcc722e-4ddf-4e15-995a-b274000f99e5.wav';

describe('Free.ai', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('registers a TTS-only provider without inventing a chat endpoint', async () => {
    expect(hasProvider('freeai')).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = new FreeAiProvider();
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.chatCompletion()).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion().next()).rejects.toMatchObject({ status: 400 });
    await expect(provider.validateKey('')).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves credential validity inconclusive without spending quota on public probes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = new FreeAiProvider();
    for (const key of ['test-key', 'invalid-freeai-control']) {
      await expect(provider.validateKey(key)).rejects.toThrow('key validity is unknown');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips unverifiable health probes, clears old errors and keeps the key routable', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const { encrypted, iv, authTag } = encrypt('test-key');
    const id = Number(getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled,last_health_error) VALUES ('freeai','test',?,?,?,'unknown',1,'stale validation error')").run(encrypted, iv, authTag).lastInsertRowid);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const validate = vi.spyOn(FreeAiProvider.prototype, 'validateKey');
    await expect(checkKeyHealth(id)).resolves.toBe('unknown');
    expect(getDb().prepare('SELECT status, enabled, last_health_error FROM api_keys WHERE id=?').get(id)).toMatchObject({
      status: 'unknown', enabled: 1, last_health_error: null,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, { audio_url: 'https://evil.example/a.wav' },
    { audio_url: 'http://api.free.ai/static/outputs/1bcc722e-4ddf-4e15-995a-b274000f99e5.wav' },
    { audio_url: 'https://api.free.ai@127.0.0.1/a.wav' }, { audio_url: `${audioUrl}?redirect=1` },
    { audio_url: 'https://api.free.ai/admin/' }, { audio_url: 'https://secret@api.free.ai/static/outputs/1bcc722e-4ddf-4e15-995a-b274000f99e5.wav' },
  ])('rejects unsafe or missing audio URLs', body => { expect(freeAiAudioUrl(body)).toBeNull(); });
});
