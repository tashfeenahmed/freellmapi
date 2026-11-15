import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import * as proxy from '../../lib/proxy.js';
import { RimeProvider } from '../../providers/rime.js';
import { getProvider } from '../../providers/index.js';
import { runSpeech, runTranscription } from '../../services/media.js';
import { rimePcm } from '../../services/media-rime.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';

function wav(rate = 16000, channels = 1) {
  const dataBytes = rate * channels * 2 / 10, out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(dataBytes, 40);
  return out;
}
class Socket extends EventTarget {
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  close = vi.fn();
  terminal: unknown = { done: { text: 'Hello', language: { tag: 'en' } } };
  send(body: string) {
    const message = JSON.parse(body); this.sent.push(message);
    if (message.start) setTimeout(() => this.emit({ started: { requestId: 'test' } }), 0);
    if (message.end && this.terminal) setTimeout(() => this.emit(this.terminal), 0);
  }
  emit(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
const params = { file: wav(), filename: 'test.wav', responseFormat: 'json' };
let keyId: number;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  const e = encrypt('test-rime-key');
  keyId = Number(getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('rime','test',?,?,?,'unknown',1)").run(e.encrypted, e.iv, e.authTag).lastInsertRowid);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });
function seed(model: string, modality: string) {
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('rime',?,?,?,1,1)").run(model, model, modality);
}
function connection(socket = new Socket()) {
  const mock = vi.spyOn(proxy, 'openProviderWebSocket').mockImplementation(async () => {
    setTimeout(() => socket.dispatchEvent(new Event('open')), 0);
    return socket as unknown as Awaited<ReturnType<typeof proxy.openProviderWebSocket>>;
  });
  return { socket, mock };
}
describe('Rime integration', () => {
  it('registers speech only, with no quota-spending health probe or bundled rows', async () => {
    const provider = getProvider('rime')!;
    expect(provider).toBeInstanceOf(RimeProvider); expect(provider.supportsChat).toBe(false); expect(provider.supportsKeyValidation).toBe(false);
    expect(isBuiltinDiscoveryEligible(getDb(), 'rime')).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='rime'").get()).toEqual({ n: 0 });
    await expect(provider.validateKey('test')).rejects.toThrow('first speech request');
    await expect(provider.chatCompletion('test', [], 'coda')).rejects.toMatchObject({ status: 400 });
    expect(inferPoolForPlatform('rime', 'coda')).toBe(inferPoolForPlatform('rime', 'rime-stt'));
  });
  it.each([['coda', 'coda', 'celeste'], ['mistv3', 'mist', 'cove']])('routes %s TTS to the native host with a default voice', async (model, host, voice) => {
    seed(model, 'audio'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav(24000)));
    expect(await runSpeech(model, { input: 'Hello', voice: 'alloy', format: 'wav' })).toMatchObject({ platform: 'rime', modelId: model, contentType: 'audio/wav' });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe(`https://${host}.api.rime.ai/`);
    expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-rime-key');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Hello', speaker: voice, lang: 'en', samplingRate: 24000 });
  });
  it('passes a native TTS voice, not a modelId field', async () => {
    seed('coda', 'audio'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav()));
    await runSpeech('coda', { input: 'Hi', voice: 'astra' }); expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).speaker).toBe('astra');
  });
  it.each([{ input: 'x', format: 'mp3' }, { input: 'x'.repeat(1001) }, { input: ' ' }])('rejects unsupported TTS input before spending quota %j', async p => {
    seed('coda', 'audio'); const fetch = vi.spyOn(global, 'fetch'); await expect(runSpeech('coda', p)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed successful audio and preserves rate-limit backoff', async () => {
    seed('coda', 'audio'); vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(runSpeech('coda', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
    await expect(runSpeech('coda', { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 45000 });
  });
  it.each([[16000, 1], [24000, 1], [48000, 2]])('converts %d Hz/%d channels to 16k mono without ffmpeg', (rate, channels) => {
    const output = rimePcm(wav(rate, channels)); expect(output.length).toBe(3200); expect(output.every(byte => byte === 0)).toBe(true);
  });
  it('accepts a streaming WAV sentinel but rejects compressed, truncated and float uploads', () => {
    const streaming = wav(); streaming.writeUInt32LE(0xffffffff, 4); streaming.writeUInt32LE(0xffffffff, 40); expect(rimePcm(streaming).length).toBe(3200);
    const floating = wav(); floating.writeUInt16LE(3, 20);
    for (const file of [Buffer.from('ID3fake'), wav().subarray(0, 48), floating]) expect(() => rimePcm(file)).toThrow('PCM16 WAV');
  });
  it('sends authenticated STT start/audio/end, requires final completion, logs success', async () => {
    seed('rime-stt', 'transcription'); const { socket, mock } = connection();
    expect(await runTranscription('rime-stt', params)).toMatchObject({ platform: 'rime', text: 'Hello', language: 'en', duration: 0.1 });
    expect(mock).toHaveBeenCalledWith('wss://stt.api.rime.ai/ws', 'rime', { protocols: ['rime.v1.json'], headers: { Authorization: 'Bearer test-rime-key' } });
    expect(socket.sent[0]).toEqual({ start: { language: 'en', outputContract: 'STREAMING_OUTPUT_CONTRACT_APPEND_FRAGMENTS' } });
    expect(socket.sent.at(-1)).toEqual({ end: {} }); expect(socket.close).toHaveBeenCalled();
  });
  it.each([{ language: 'fr' }, { file: Buffer.from('ID3') }, { prompt: 'hint' }, { temperature: 0.5 }, { responseFormat: 'vtt' }])('rejects unsupported STT input without opening a socket %j', async overrides => {
    seed('rime-stt', 'transcription'); const { mock } = connection(); await expect(runTranscription('rime-stt', { ...params, ...overrides })).rejects.toMatchObject({ status: 400 }); expect(mock).not.toHaveBeenCalled();
  });
  it('treats no recognized speech as a valid empty transcript', async () => {
    seed('rime-stt', 'transcription'); const { socket } = connection(); socket.terminal = { done: { language: { tag: 'en' } } };
    await expect(runTranscription('rime-stt', params)).resolves.toMatchObject({ text: '' });
  });
  it('preserves structured exhaustion as 429 and benches the key/model', async () => {
    seed('rime-stt', 'transcription'); const { socket } = connection(); socket.terminal = { error: { kind: 'resource_exhausted' } };
    await expect(runTranscription('rime-stt', params)).rejects.toMatchObject({ status: 429 }); expect(isOnCooldown('rime', 'rime-stt', keyId)).toBe(true);
  });
  it('never reports a partial transcript after early close', async () => {
    seed('rime-stt', 'transcription'); const { socket } = connection(); socket.terminal = null;
    const result = runTranscription('rime-stt', params);
    setTimeout(() => { socket.emit({ hypothesis: { text: 'partial' } }); socket.dispatchEvent(new Event('close')); }, 20);
    await expect(result).rejects.toMatchObject({ status: 502 });
  });
  it('bounds a stalled socket and closes it on timeout', async () => {
    seed('rime-stt', 'transcription'); vi.useFakeTimers(); const { socket } = connection(); socket.terminal = null;
    const result = expect(runTranscription('rime-stt', params)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('timed out') });
    await vi.advanceTimersByTimeAsync(115001); await result; expect(socket.close).toHaveBeenCalled();
  });
  it('catalogs two TTS rows and one STT row without leaking them into chat', () => {
    applyCatalog(getDb(), { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: ['coda', 'mistv3'].map(modelId => ({ platform: 'rime', modelId, displayName: modelId, modality: 'audio', enabled: true, intelligenceRank: 100, speedRank: 10, sizeLabel: 'TTS', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: '$50/month shared', contextWindow: null, supportsTools: false, supportsVision: false })),
      transcriptionModels: [{ platform: 'rime', modelId: 'rime-stt', displayName: 'Rime STT', enabled: true, priority: 1 }],
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='rime'").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='rime'").get()).toEqual({ n: 3 });
  });
});
