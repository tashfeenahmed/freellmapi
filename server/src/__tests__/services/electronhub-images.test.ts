import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration } from '../../services/media.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';

let image: string;
function seed(model: string) { getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('electronhub',?,?,'image',1,1)").run(model, model); }
beforeEach(async () => {
  const sharp = (await import('sharp')).default;
  image = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).jpeg().toBuffer()).toString('base64');
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  const e = encrypt('electronhub-synthetic-key'); getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('electronhub','test',?,?,?,'healthy',1)").run(e.encrypted, e.iv, e.authTag);
});
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
describe('ElectronHub image dispatch', () => {
  it.each(['qwen-image-2512', 'flux-2-flex', 'realvisxl-5.0', 'flux-2-klein-base-4b'])('routes catalog-managed %s to the correct image endpoint', async model => {
    seed(model); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model, data: [{ b64_json: image }] }));
    expect(await runImageGeneration(model, { prompt: 'A blue circle' })).toMatchObject({ platform: 'electronhub', modelId: model, images: [{ b64_json: image }] });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.electronhub.ai/v1/images/generations'); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer electronhub-synthetic-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model, prompt: 'A blue circle', n: 1, size: '1024x1024', response_format: 'b64_json' });
  });
  it('does not send an untested premium image route upstream', async () => {
    seed('krea-2-raw'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration('krea-2-raw', { prompt: 'circle' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, { data: [] }, { model: 'wrong', data: [{ b64_json: 'AAAA' }] }, { data: [{ url: 'http://169.254.169.254/' }] }, { data: [{ b64_json: Buffer.from('{}').toString('base64') }] }, { data: [{ b64_json: Buffer.from([255, 216, 255, 224, 1, 2, 3, 4, 255, 217]).toString('base64') }] }])('rejects invalid responses without following asset URLs %j', async body => {
    seed('qwen-image-2512'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body));
    await expect(runImageGeneration('qwen-image-2512', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 }); expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds image JSON and preserves native rate limits without leaking error bodies', async () => {
    seed('qwen-image-2512'); vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { headers: { 'Content-Length': String(33 * 1024 * 1024) } })).mockResolvedValueOnce(new Response('echoed-secret', { status: 429, headers: { 'Retry-After': '10' } }));
    await expect(runImageGeneration('qwen-image-2512', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    const error = await runImageGeneration('qwen-image-2512', { prompt: 'circle' }).catch(e => e); expect(error).toMatchObject({ status: 429, retryAfterMs: 10000 }); expect(error.message).not.toContain('echoed-secret');
  });
});
