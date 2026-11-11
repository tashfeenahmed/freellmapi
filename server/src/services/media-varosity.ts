import { randomUUID } from 'node:crypto';
import { proxyFetch } from '../lib/proxy.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { cpuCanRunSharp } from '../lib/image-normalize.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { VAROSITY_BASE_URL } from '../providers/varosity.js';
import type { ImageParams, SpeechParams, VideoParams } from './media.js';

/** Only the ten live-tested routes. All share the account's daily credits;
 * this is not a promise of free unlimited use or an allowance per model. */
const IMAGES = new Set(['flux-3-klein', 'flux-2-pro', 'qwen-image-3.0', 'gpt-image-2.5-flare']);
const VOICES: Record<string, string> = {
  'openai-tts-1': 'openai-tts-1', 'elevenlabs-tts-v3': 'eleven_v3',
  'fal-kokoro': 'fal-kokoro', 'heygen-voice-turbo': 'heygen-voice-turbo',
};
const OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_HOST = 'nkluppgbrrxbfkaktnks.supabase.co';
const MB = 1024 * 1024;

export class VarosityMediaError extends Error {
  constructor(message: string, readonly status = 502, readonly code?: string, readonly retryAfterMs?: number) { super(message); }
}

/** A single deadline covers submission, polling and download. No automatic
 * resubmission, account top-up or billing-setting changes. */
function session(key: string | null, modality: 'image' | 'audio' | 'video', clientSignal?: AbortSignal) {
  if (!key) throw new VarosityMediaError('Varosity API key required', 401);
  const timeout = modality === 'image' ? 120_000 : 300_000;
  const deadline = Date.now() + timeout;
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(clientSignal ? [clientSignal] : [])]);
  const check = () => {
    if (clientSignal?.aborted) throw new VarosityMediaError('Client disconnected', 499);
    if (signal.aborted || Date.now() >= deadline) throw new VarosityMediaError('Varosity generation timed out', 504);
  };
  const fetch = async (url: string, init: RequestInit) => {
    check();
    let response: Response;
    try { response = await proxyFetch(url, { ...init, redirect: 'error', signal }, 'varosity', modality, Math.max(1, deadline - Date.now())); }
    catch { check(); throw new VarosityMediaError('Varosity request failed'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new VarosityMediaError(`Varosity returned HTTP ${response.status}`, response.status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
    }
    return response;
  };
  const bytes = async (response: Response, max: number): Promise<Buffer> => {
    if (!response.body || Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel(); throw new VarosityMediaError('Varosity output is missing or too large');
    }
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        check();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > max) throw new VarosityMediaError('Varosity output is too large');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      check(); throw error;
    } finally { reader.releaseLock(); }
    check();
    return Buffer.concat(chunks);
  };
  const json = async (path: string, body?: object, generate = false): Promise<Record<string, unknown>> => {
    const response = await fetch(`${VAROSITY_BASE_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(generate ? { 'Idempotency-Key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data: Record<string, unknown> | null;
    try { data = JSON.parse((await bytes(response, MB)).toString()); }
    catch (error) { if (error instanceof VarosityMediaError) throw error; throw new VarosityMediaError('Varosity returned invalid JSON'); }
    if (data?.code === 'insufficient_credits') throw new VarosityMediaError('Varosity credits exhausted; generation is held by the provider', 402, 'insufficient_credits');
    if (!data || data.ok !== true || data.error || (data.billing_mode !== undefined && data.billing_mode !== 'platform') || (data.billingMode !== undefined && data.billingMode !== 'platform')) {
      throw new VarosityMediaError('Varosity returned an unsuccessful or unexpected billing response');
    }
    return data;
  };
  const download = async (value: unknown, max: number) => {
    let url: URL;
    try { if (typeof value !== 'string') throw new Error(); url = new URL(value); }
    catch { throw new VarosityMediaError('Varosity returned no valid output URL'); }
    const storage = url.hostname === STORAGE_HOST && /^\/storage\/v1\/object\/public\/varosity-(assets|audio)\//.test(url.pathname);
    const fal = /^v\d+[a-z]?\.fal\.media$/.test(url.hostname) && url.pathname.startsWith('/files/');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(storage || fal) || !(await assessProviderUrl(url.href)).allowed) {
      throw new VarosityMediaError('Varosity returned an unsafe output URL');
    }
    // Never forward the API credential to storage/CDN hosts or follow redirects.
    return bytes(await fetch(url.href, { method: 'GET' }), max);
  };
  const wait = async () => {
    check();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); try { check(); } catch (error) { reject(error); } };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(2_000, deadline - Date.now()));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    check();
  };
  return { json, download, wait, check };
}

export async function varosityImage(model: string, key: string | null, p: ImageParams): Promise<Array<{ b64_json: string }>> {
  if (!IMAGES.has(model)) throw new VarosityMediaError('Varosity image model is not a tested route', 400);
  // Native API selects aspect ratio, not exact pixel dimensions. Keep the
  // tested square preset; Qwen may return 2048px rather than 1024px.
  if ((p.n !== undefined && p.n !== 1) || (p.size !== undefined && p.size !== '1024x1024')) throw new VarosityMediaError('Varosity supports one square image per request through this adapter', 400);
  if (!cpuCanRunSharp()) throw new VarosityMediaError('Varosity images require a compatible image decoder');
  let sharp: typeof import('sharp').default;
  try { sharp = (await import('sharp')).default; } catch { throw new VarosityMediaError('Varosity images require the optional image decoder'); }
  const work = session(key, 'image');
  const body = await work.json('/v1/images', { model, prompt: p.prompt, aspect_ratio: '1:1', ...(model === 'gpt-image-2.5-flare' ? { providerOptions: { quality: 'low' } } : {}) }, true);
  if (body.model !== model) throw new VarosityMediaError('Varosity returned a different or missing image model identity');
  const bytes = await work.download(body.imageUrl, 16 * MB);
  try {
    // Some JPEG outputs are labelled PNG upstream. Decode and normalize instead
    // of forwarding a false MIME type or an expiring signed URL.
    const png = await sharp(bytes, { limitInputPixels: 16 * MB, failOn: 'warning' }).png().toBuffer();
    if (png.length > 16 * MB) throw new Error('Too large');
    work.check();
    return [{ b64_json: png.toString('base64') }];
  } catch (error) {
    if (error instanceof VarosityMediaError) throw error;
    throw new VarosityMediaError('Varosity returned an invalid or oversized image');
  }
}

function audioResult(audio: Buffer): { audio: Buffer; contentType: string } {
  if (audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') return { audio, contentType: 'audio/wav' };
  if (audio.length > 10 && (audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 255 && (audio[1] & 0xe0) === 0xe0))) return { audio, contentType: 'audio/mpeg' };
  throw new VarosityMediaError('Varosity returned no recognized WAV or MP3 audio');
}

export async function varositySpeech(model: string, key: string | null, p: SpeechParams): Promise<{ audio: Buffer; contentType: string }> {
  if (!Object.hasOwn(VOICES, model) && model !== 'lyria-2') throw new VarosityMediaError('Varosity audio model is not a tested route', 400);
  if (p.format && !['mp3', 'wav'].includes(p.format)) throw new VarosityMediaError('Varosity supports MP3/WAV audio through this adapter', 400);
  if (model === 'lyria-2' && p.voice) throw new VarosityMediaError('Varosity Lyria is instrumental music and does not accept a voice', 400);
  if (model !== 'lyria-2' && p.voice && !OPENAI_VOICES.has(p.voice)) throw new VarosityMediaError('Varosity supports standard speech voices or the native default through this adapter', 400);
  const work = session(key, 'audio');
  if (model !== 'lyria-2') {
    const body = await work.json('/v1/tts', {
      voiceModel: model, text: p.input, format: p.format ?? 'mp3',
      ...(model === 'openai-tts-1' ? { voiceId: p.voice ?? 'alloy' } : {}),
    }, true);
    if (body.modelId !== VOICES[model]) throw new VarosityMediaError('Varosity returned a different or missing voice model identity');
    // Some providers ignore format=mp3 and deliver WAV. Report the actual bytes.
    return audioResult(await work.download(body.audioUrl, 32 * MB));
  }
  let job = await work.json('/v1/music', { modelId: model, prompt: p.input, durationSec: 30, instrumental: true }, true);
  const id = job.trackId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new VarosityMediaError('Varosity returned no valid music track ID');
  if (job.sync !== true && (job.sync !== false || typeof job.providerJobId !== 'string' || !job.providerJobId)) throw new VarosityMediaError('Varosity returned an invalid music submission');
  // /music/poll (without /v1) is the documented native polling route.
  while (job.sync !== true || !job.audioUrl) {
    if (job.trackId !== undefined && job.trackId !== id) throw new VarosityMediaError('Varosity returned a different music track');
    if (job.status === 'succeeded') break;
    if (job.status !== undefined && !['queued', 'pending', 'processing', 'rendering', 'running'].includes(String(job.status))) throw new VarosityMediaError('Varosity music job failed or returned an unknown status');
    await work.wait();
    job = await work.json('/music/poll', { trackId: id });
    if (typeof job.status !== 'string') throw new VarosityMediaError('Varosity returned no music job status');
  }
  if (job.trackId !== undefined && job.trackId !== id) throw new VarosityMediaError('Varosity returned a different music track');
  return audioResult(await work.download(job.audioUrl, 32 * MB));
}

export async function varosityVideo(model: string, key: string | null, p: VideoParams, clientSignal?: AbortSignal): Promise<{ video: Buffer; contentType: string }> {
  if (model !== 'grok-imagine-video') throw new VarosityMediaError('Varosity video model is not a tested route', 400);
  // One second costs less than the shared daily grant. Never silently use the
  // provider's more expensive multi-second default or a BYOK billing fallback.
  if ((p.duration !== undefined && p.duration !== 1) || (p.aspectRatio && p.aspectRatio !== '16:9') || p.image || p.seed !== undefined || p.audio === false) throw new VarosityMediaError('Varosity video supports one-second landscape text-to-video with audio through this adapter', 400);
  const work = session(key, 'video', clientSignal);
  let job = await work.json('/v1/video/generate', { modelId: model, prompt: p.prompt, durationSec: 1, aspectRatio: '16:9', authPreference: 'platform' }, true);
  const id = job.jobId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new VarosityMediaError('Varosity returned no valid video job ID');
  while (true) {
    if (job.jobId !== id) throw new VarosityMediaError('Varosity returned a different video job');
    if (job.status === 'succeeded') break;
    if (!['queued', 'rendering'].includes(String(job.status))) throw new VarosityMediaError('Varosity video job failed or returned an unknown status');
    await work.wait();
    job = await work.json(`/v1/jobs/${id}`);
  }
  const video = await work.download(job.outputUrl, 100 * MB);
  if (video.length < 16 || video.toString('ascii', 4, 8) !== 'ftyp') throw new VarosityMediaError('Varosity returned no valid MP4 video');
  return { video, contentType: 'video/mp4' };
}
