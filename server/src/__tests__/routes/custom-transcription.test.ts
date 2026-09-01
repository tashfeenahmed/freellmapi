import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// End-to-end cover for a user-registered speech-to-text endpoint: POST
// /api/media/custom writes the media_models row AND the api_keys row that
// carries its base_url, and /v1/audio/transcriptions must then actually reach
// that endpoint. Registration alone is not enough — the STT candidate has to
// carry its key_id (getProviderCredential refuses to guess a key for platform
// 'custom') and the service needs a 'custom' adapter.

const realFetch = globalThis.fetch;

let dashToken = '';

const BASE_URL = 'http://127.0.0.1:9911/v1';
const AUDIO = Buffer.from('RIFFfakewavbytes');

async function listen(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  return { server, port: addr.port as number };
}

async function post(app: Express, path: string, body: unknown) {
  const { server, port } = await listen(app);
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function get(app: Express, path: string) {
  const { server, port } = await listen(app);
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

/** POST multipart/form-data to /v1/audio/transcriptions on a live listener via
 *  the saved real fetch, so a mocked globalThis.fetch only ever intercepts the
 *  upstream provider call. */
async function postTranscription(app: Express, fields: Record<string, string>) {
  const { server, port } = await listen(app);
  const form = new FormData();
  form.append('file', new Blob([AUDIO], { type: 'audio/wav' }), 'clip.wav');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await realFetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
    body: form,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* text/plain response_format */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

function registerStt(app: Express, overrides: Record<string, unknown> = {}) {
  return post(app, '/api/media/custom', {
    baseUrl: BASE_URL,
    model: 'Systran/faster-whisper-large-v3',
    modality: 'transcription',
    displayName: 'Local Whisper',
    apiKey: 'stt-secret-key',
    label: 'Local STT',
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('custom speech-to-text endpoint, end to end', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Cooldowns live in a module-level map that outlives the per-test :memory:
    // DB; key ids restart at 1 in every test, so stale entries must be purged.
    for (let id = 1; id <= 10; id++) clearCooldownsForKey(id);
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('transcribes through the registered endpoint with its own base URL and key', async () => {
    const reg = await registerStt(app);
    expect(reg.status).toBe(201);
    expect(reg.body.modality).toBe('transcription');

    const fetchMock = vi.fn(async () => jsonResponse({ text: 'hello from my box', language: 'en', duration: 1.25 }));
    globalThis.fetch = fetchMock as any;

    const r = await postTranscription(app, {
      model: 'Systran/faster-whisper-large-v3',
      language: 'en',
      prompt: 'ctx',
      temperature: '0.2',
    });

    expect(r.status).toBe(200);
    expect(r.body.text).toBe('hello from my box');
    expect(r.headers.get('X-Provider')).toBe('custom');
    expect(r.headers.get('X-Model')).toBe('Systran/faster-whisper-large-v3');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // The user's own base URL, not a hardcoded provider host.
    expect(url).toBe(`${BASE_URL}/audio/transcriptions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stt-secret-key');
    // Content-Type must NOT be set by hand — FormData supplies the boundary.
    expect(headers['Content-Type']).toBeUndefined();

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('Systran/faster-whisper-large-v3');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('ctx');
    expect(form.get('temperature')).toBe('0.2');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('clip.wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);

    // The request is logged under the transcription modality like any other.
    const row = getDb()
      .prepare("SELECT platform, model_id, status, request_type FROM requests ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(row).toMatchObject({ platform: 'custom', request_type: 'transcription', status: 'success' });
  });

  it("'whisper-1' auto-routes to the only registered STT model (stock OpenAI clients)", async () => {
    expect((await registerStt(app)).status).toBe(201);
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'auto routed' }));
    globalThis.fetch = fetchMock as any;

    const r = await postTranscription(app, { model: 'whisper-1' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('auto routed');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE_URL}/audio/transcriptions`);
  });

  it('keyless endpoint (auth off) still reaches the box with the placeholder bearer', async () => {
    expect((await registerStt(app, { apiKey: undefined })).status).toBe(201);
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'no auth needed' }));
    globalThis.fetch = fetchMock as any;

    const r = await postTranscription(app, { model: 'whisper-1' });
    expect(r.status).toBe(200);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer no-key');
  });

  it('an upstream failure surfaces as a transcription error, not a silent skip', async () => {
    expect((await registerStt(app)).status).toBe(201);
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500)) as any;

    const r = await postTranscription(app, { model: 'whisper-1' });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('transcription error');
  });

  it("GET /api/keys lists the model under its endpoint with kind 'transcription'", async () => {
    const reg = await registerStt(app);
    expect(reg.status).toBe(201);

    const keys = await get(app, '/api/keys');
    expect(keys.status).toBe(200);
    const custom = keys.body.find((k: any) => k.platform === 'custom' && k.baseUrl === BASE_URL);
    expect(custom).toBeTruthy();
    expect(custom.models).toEqual([
      expect.objectContaining({
        kind: 'transcription',
        modelId: 'Systran/faster-whisper-large-v3',
        displayName: 'Local Whisper',
      }),
    ]);
  });

  it('sorts transcription after the other kinds on the same endpoint', async () => {
    expect((await post(app, '/api/keys/custom', {
      baseUrl: BASE_URL,
      models: ['local-chat'],
      apiKey: 'stt-secret-key',
    })).status).toBe(201);
    expect((await post(app, '/api/media/custom', {
      baseUrl: BASE_URL,
      model: 'local-tts',
      modality: 'audio',
      apiKey: 'stt-secret-key',
    })).status).toBe(201);
    expect((await registerStt(app)).status).toBe(201);

    const keys = await get(app, '/api/keys');
    const custom = keys.body.find((k: any) => k.platform === 'custom' && k.baseUrl === BASE_URL);
    expect(custom.models.map((m: any) => m.kind)).toEqual(['chat', 'audio', 'transcription']);
  });
});
