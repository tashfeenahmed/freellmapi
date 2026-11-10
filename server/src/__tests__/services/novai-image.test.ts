import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, listMediaModels } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import * as guard from '../../lib/url-guard.js';
import * as imageLibrary from '../../lib/image-normalize.js';

const model = 'cogview-3-flash';
const url = 'https://maas-watermark-prod-new.cn-wlcb.ufileos.com/image.png?Signature=test';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
let jpeg: Buffer, png: Buffer;
beforeAll(async () => {
  const options = { create: { width: 16, height: 8, channels: 3 as const, background: '#ff0000' } };
  jpeg = await sharp(options).jpeg().toBuffer();
  png = await sharp(options).png().toBuffer();
});
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:');
  const enc = encrypt('test-novai-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('novai','test',?,?,?,'healthy',1)").run(enc.encrypted, enc.iv, enc.authTag);
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('novai',?,'CogView','image',1,1,'shared daily free allowance')").run(model);
  vi.spyOn(guard, 'assessProviderUrl').mockResolvedValue({ allowed: true });
});
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('NovAI image adapter', () => {
  it.each(['jpeg', 'png'])('validates %s and returns PNG base64 without forwarding credentials', async format => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ url }] }))
      .mockResolvedValueOnce(new Response(format === 'jpeg' ? jpeg : png, { headers: { 'Content-Type': 'image/png' } }));
    const result = await runImageGeneration(model, { prompt: 'A red circle' });
    const output = Buffer.from(result.images[0].b64_json!, 'base64');
    expect(await sharp(output).metadata()).toMatchObject({ format: 'png', width: 16, height: 8 });
    expect(result.images[0].url).toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('https://aiapi-pro.com/v1/images/generations');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, prompt: 'A red circle', size: '1024x1024', n: 1 });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-novai-key');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
  });
  it.each([null, {}, { data: [] }, { data: [{ url }, { url }] }, { error: 'failed', data: [{ url }] }, { model: 'paid-model', data: [{ url }] }])('rejects malformed response %j', async body => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['http://127.0.0.1/a', 'https://169.254.169.254/a', 'https://evil.example/a', 'https://ufileos.com.evil.example/a', 'https://user@aiapi-pro.com/a', 'https://aiapi-pro.com:444/a', 'https://aiapi-pro.com/a#fragment'])('rejects unsafe output URL %s', async unsafe => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ url: unsafe }] }));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors private-address DNS guards even on an allowed hostname', async () => {
    vi.mocked(guard.assessProviderUrl).mockResolvedValue({ allowed: false, reason: 'private address' });
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ url }] }));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from('<html>error</html>'), Buffer.from([255, 216, 255, 0])])('rejects non-image and corrupt image bodies', async bytes => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ url }] })).mockResolvedValueOnce(new Response(bytes));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
  });
  it('rejects oversized downloads before reading the body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ url }] }))
      .mockResolvedValueOnce(new Response(png, { headers: { 'Content-Length': String(17 * 1024 * 1024) } }));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
  });
  it('bounds chunked downloads without a content length', async () => {
    const chunk = new Uint8Array(1024 * 1024); let sent = 0;
    const stream = new ReadableStream({ pull(controller) { if (sent++ < 17) controller.enqueue(chunk); else controller.close(); } });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ url }] })).mockResolvedValueOnce(new Response(stream));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ n: 2 }, { size: '512x512' }])('rejects unsupported options before spending quota: %j', async options => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration(model, { prompt: 'circle', ...options })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects untested paid model IDs before sending credentials', async () => {
    getDb().prepare('UPDATE media_models SET model_id=?').run('cogview-4');
    const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration('cogview-4', { prompt: 'circle' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves provider quota backoff', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '60' }));
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not load the native decoder or spend quota on an unsupported CPU', async () => {
    vi.spyOn(imageLibrary, 'cpuCanRunSharp').mockReturnValue(false);
    const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration(model, { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('imports only to the image registry and preserves local disables', () => {
    getDb().prepare('DELETE FROM media_models').run();
    const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, quirks: [], models: [
      { platform: 'novai', modelId: model, displayName: 'CogView', modality: 'image' as const, enabled: true, intelligenceRank: 100, speedRank: 5, sizeLabel: '', limits: { rpm: 5, rpd: 10, tpm: null, tpd: null }, monthlyTokenBudget: 'shared daily allowance', contextWindow: null, supportsTools: false, supportsVision: false },
    ] };
    applyCatalog(getDb(), catalog); applyCatalog(getDb(), catalog);
    expect(listMediaModels('image')).toHaveLength(1);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='novai'").get()).toEqual({ n: 0 });
    getDb().prepare("UPDATE media_models SET enabled=0 WHERE platform='novai'").run();
    applyCatalog(getDb(), catalog); expect(listMediaModels('image')).toHaveLength(0);
  });
});
