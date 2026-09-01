import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// GET /api/media/usage backs the month-to-date card on the Image and Audio
// tabs. Image and audio calls are billed per image or per character, not per
// token, so the unit here is requests. There is deliberately no budget field:
// media_models only carries a free-text quota_label, so any percentage would
// be invented.

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function seedModels() {
  const insert = getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('cloudflare', 'flux-1-schnell', 'FLUX.1 [schnell]', 'image', 1, 1, 'Shared 10k neurons/day');
  insert.run('pollinations', 'turbo', 'Turbo', 'image', 2, 1, '1024x1024 - 40 req/min free');
  insert.run('pollinations', 'nova-reel', 'Nova Reel', 'video', 1, 1, 'Recurring daily Pollen refill');
  insert.run('groq', 'playai-tts', 'PlayAI TTS', 'audio', 1, 1, 'WAV/PCM - 30+ voices');
  // Disabled rows stay out of the summary entirely.
  insert.run('cloudflare', 'melotts', 'MeloTTS', 'audio', 2, 0, 'Shared 10k neurons/day');
  // STT models live in the same table with modality='transcription'; the
  // Audio tab lists them under the TTS section, so the usage summary has to
  // accept the modality too (it used to 400).
  insert.run('groq', 'whisper-large-v3', 'Whisper Large v3', 'transcription', 1, 1, 'MP3 output - multilingual');
}

function seedRequest(platform: string, modelId: string, type: string, when: string) {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, request_type)
    VALUES (?, ?, 'success', 0, 0, 10, ?, ?)
  `).run(platform, modelId, when, type);
}

describe('GET /api/media/usage', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    seedModels();
  });

  it('rejects a missing or unknown modality', async () => {
    expect((await get(app, '/api/media/usage')).status).toBe(400);
    expect((await get(app, '/api/media/usage?modality=not-real')).status).toBe(400);
  });

  it('counts this month\'s requests per model and separates today', async () => {
    seedRequest('cloudflare', 'flux-1-schnell', 'image', "datetime('now')");
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, request_type)
      VALUES ('cloudflare', 'flux-1-schnell', 'success', 0, 0, 10, datetime('now'), 'image'),
             ('cloudflare', 'flux-1-schnell', 'success', 0, 0, 10, datetime('now', 'start of month'), 'image'),
             ('pollinations', 'turbo', 'success', 0, 0, 10, datetime('now'), 'image')
    `).run();

    const { status, body } = await get(app, '/api/media/usage?modality=image');
    expect(status).toBe(200);
    expect(body.modality).toBe('image');

    const flux = body.models.find((m: any) => m.modelId === 'flux-1-schnell');
    expect(flux.requestsMonth).toBeGreaterThanOrEqual(2);
    expect(flux.requestsToday).toBeGreaterThanOrEqual(1);
    expect(flux.quotaLabel).toBe('Shared 10k neurons/day');
    expect(body.totalRequestsMonth).toBe(
      body.models.reduce((s: number, m: any) => s + m.requestsMonth, 0),
    );
  });

  it('scopes to one modality and skips disabled rows', async () => {
    const image = await get(app, '/api/media/usage?modality=image');
    const video = await get(app, '/api/media/usage?modality=video');
    const audio = await get(app, '/api/media/usage?modality=audio');

    expect(image.body.models.map((m: any) => m.modelId).sort()).toEqual(['flux-1-schnell', 'turbo']);
    expect(video.body.models.map((m: any) => m.modelId)).toEqual(['nova-reel']);
    // MeloTTS is disabled, so only PlayAI is reported.
    expect(audio.body.models.map((m: any) => m.modelId)).toEqual(['playai-tts']);
  });

  it('does not count chat or embedding traffic', async () => {
    seedRequest('cloudflare', 'flux-1-schnell', 'chat', "datetime('now')");
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, request_type)
      VALUES ('cloudflare', 'flux-1-schnell', 'success', 0, 0, 10, datetime('now'), 'chat')
    `).run();

    const { body } = await get(app, '/api/media/usage?modality=image');
    const flux = body.models.find((m: any) => m.modelId === 'flux-1-schnell');
    expect(flux.requestsMonth).toBe(0);
  });

  it('reports transcription usage from the same tagged request log', async () => {
    seedRequest('groq', 'whisper-large-v3', 'transcription', "datetime('now')");
    seedRequest('groq', 'whisper-large-v3', 'transcription', "datetime('now', 'start of month')");
    // Same provider AND model id, but TTS traffic: the join must exclude it by
    // request_type, not just by platform + model_id.
    seedRequest('groq', 'whisper-large-v3', 'audio', "datetime('now')");

    const { status, body } = await get(app, '/api/media/usage?modality=transcription');
    expect(status).toBe(200);
    expect(body.modality).toBe('transcription');
    expect(body.models.map((m: any) => m.modelId)).toEqual(['whisper-large-v3']);

    const whisper = body.models[0];
    // Exactly the two transcription requests — the audio one is filtered out
    // by request_type even though it shares platform and model id.
    expect(whisper.requestsMonth).toBe(2);
    expect(whisper.requestsToday).toBeGreaterThanOrEqual(1);
    expect(whisper.quotaLabel).toBe('MP3 output - multilingual');
    expect(body.totalRequestsMonth).toBe(2);
  });

  it('reports no budget field — media quota labels are not token budgets', async () => {
    const { body } = await get(app, '/api/media/usage?modality=audio');
    for (const m of body.models) {
      expect(m).not.toHaveProperty('budget');
      expect(m).not.toHaveProperty('totalBudget');
    }
    expect(body).not.toHaveProperty('totalBudget');
  });
});
