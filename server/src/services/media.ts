// Generative-media routing (image generation + audio/TTS).
//
// Self-contained, exactly like embeddings: media models live in their OWN
// `media_models` table so they can NEVER enter the chat router's candidate pool
// (a chat request can't misroute to an image model) and never pollute the chat
// token budget. Each platform has a small adapter here; routing fails over
// across the providers serving the same modality. The rows are maintained in the
// published catalog and arrive via catalog-sync (premium on the live tier within
// ~12h, free at the monthly promote) — never seeded by migrations.
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';

/** Platforms with a media adapter below. catalog-sync gates media rows on this
 *  (decoupled from the chat provider registry — e.g. SiliconFlow is media-only). */
export const MEDIA_PLATFORMS = new Set(['nvidia', 'pollinations', 'cloudflare', 'siliconflow', 'google']);

/** Platforms whose free media path needs no API key (anonymous). */
const KEYLESS_CAPABLE = new Set(['pollinations']);

export type MediaModality = 'image' | 'audio';

export interface MediaModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  modality: MediaModality;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
}

export class MediaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ImageResult {
  platform: string;
  modelId: string;
  images: Array<{ b64_json?: string; url?: string }>;
}
export interface SpeechResult {
  platform: string;
  modelId: string;
  audio: Buffer;
  contentType: string;
}
export interface ImageParams { prompt: string; n?: number; size?: string }
export interface SpeechParams { input: string; voice?: string; format?: string }

// Media generations are slower than chat — a cold FLUX/SDXL run can take 30-60s.
const FETCH_TIMEOUT_MS = 60_000;

export function listMediaModels(modality: MediaModality): MediaModelRow[] {
  return getDb()
    .prepare('SELECT * FROM media_models WHERE modality = ? AND enabled = 1 ORDER BY priority, id')
    .all(modality) as MediaModelRow[];
}

/** All media models (both modalities, including disabled) for the dashboard. */
export function listAllMediaModels(): MediaModelRow[] {
  return getDb()
    .prepare('SELECT * FROM media_models ORDER BY modality, priority, id')
    .all() as MediaModelRow[];
}

interface ProviderCredential {
  id: number | null;
  key: string | null;
  baseUrl: string | null;
}

function getProviderCredential(row: MediaModelRow): ProviderCredential | null {
  if (row.key_id != null) {
    const keyRow = getDb()
      .prepare("SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1")
      .get(row.key_id) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
    if (!keyRow) return null;
    try {
      return {
        id: keyRow.id,
        key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
      };
    } catch {
      return null;
    }
  }
  if (row.platform === 'custom') return null;

  const keyRow = getDb()
    .prepare("SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id LIMIT 1")
    .get(row.platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;
  if (!keyRow) return null;
  try {
    return {
      id: keyRow.id,
      key: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
      baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
    };
  } catch {
    return null;
  }
}

async function mediaFetch(url: string, platform: string, init: RequestInit): Promise<Response> {
  const r = await proxyFetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, platform);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new MediaError(`${platform} ${r.status}: ${body.slice(0, 200)}`, r.status);
  }
  return r;
}

function parseSize(size?: string): [number, number] {
  if (size && /^\d+x\d+$/.test(size)) {
    const [w, h] = size.split('x').map(Number);
    return [w, h];
  }
  return [1024, 1024];
}

function parseCfKey(key: string | null): { accountId: string; token: string } {
  if (!key) throw new MediaError('cloudflare key required (account_id:token)', 401);
  const sep = key.indexOf(':');
  if (sep === -1) throw new MediaError('cloudflare key is not in account_id:token form', 500);
  return { accountId: key.slice(0, sep), token: key.slice(sep + 1) };
}

function contentTypeFor(fmt: string): string {
  switch (fmt) {
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'pcm': return 'audio/L16';
    case 'mp3':
    default: return 'audio/mpeg';
  }
}

function parseRate(mime?: string): number | undefined {
  const m = mime?.match(/rate=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Wrap raw 16-bit mono PCM (what Gemini TTS returns) in a WAV header so any
 *  client can play it without knowing the sample rate out of band. */
function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function callImageProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: ImageParams,
): Promise<Array<{ b64_json?: string; url?: string }>> {
  const key = credential.key;
  const [w, h] = parseSize(p.size);
  switch (row.platform) {
    case 'custom': {
      if (!credential.baseUrl) throw new MediaError('custom image provider is missing base_url', 500);
      const body: Record<string, unknown> = { model: row.model_id, prompt: p.prompt };
      if (p.n !== undefined) body.n = p.n;
      if (p.size) body.size = p.size;
      const r = await mediaFetch(`${credential.baseUrl}/images/generations`, 'custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key ?? 'no-key'}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { data?: { b64_json?: string; url?: string }[] };
      return (j.data ?? []).map(i => ({ b64_json: i.b64_json, url: i.url }));
    }
    case 'nvidia': {
      // NVIDIA NIM image models live at ai.api.nvidia.com/v1/genai/{model};
      // response is { artifacts: [{ base64 }] }.
      const r = await mediaFetch(`https://ai.api.nvidia.com/v1/genai/${row.model_id}`, 'nvidia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ prompt: p.prompt, mode: 'base', steps: 4, width: w, height: h }),
      });
      const j = (await r.json()) as { artifacts?: { base64?: string }[] };
      return (j.artifacts ?? []).map(a => ({ b64_json: a.base64 }));
    }
    case 'pollinations': {
      // Keyless GET image endpoint returns raw image bytes.
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p.prompt)}?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(row.model_id)}`;
      const r = await mediaFetch(url, 'pollinations', { method: 'GET' });
      const buf = Buffer.from(await r.arrayBuffer());
      return [{ b64_json: buf.toString('base64') }];
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const r = await mediaFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`, 'cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: p.prompt, width: w, height: h }),
      });
      // FLUX returns JSON { result: { image: <b64> } }; SDXL returns raw PNG bytes.
      const ct = r.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const j = (await r.json()) as { result?: { image?: string } };
        const b64 = j.result?.image;
        if (!b64) throw new MediaError('cloudflare returned no image', 502);
        return [{ b64_json: b64 }];
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return [{ b64_json: buf.toString('base64') }];
    }
    case 'siliconflow': {
      const r = await mediaFetch('https://api.siliconflow.com/v1/images/generations', 'siliconflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, prompt: p.prompt, image_size: `${w}x${h}` }),
      });
      const j = (await r.json()) as { images?: { url?: string }[]; data?: { url?: string }[] };
      return (j.images ?? j.data ?? []).map(i => ({ url: i.url }));
    }
    default:
      throw new MediaError(`no image adapter for platform '${row.platform}'`, 500);
  }
}

async function callSpeechProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: SpeechParams,
): Promise<{ audio: Buffer; contentType: string }> {
  const key = credential.key;
  switch (row.platform) {
    case 'custom': {
      if (!credential.baseUrl) throw new MediaError('custom audio provider is missing base_url', 500);
      const fmt = p.format ?? 'mp3';
      const body: Record<string, unknown> = { model: row.model_id, input: p.input };
      if (p.voice) body.voice = p.voice;
      if (p.format) body.response_format = p.format;
      const r = await mediaFetch(`${credential.baseUrl}/audio/speech`, 'custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key ?? 'no-key'}` },
        body: JSON.stringify(body),
      });
      return {
        audio: Buffer.from(await r.arrayBuffer()),
        contentType: r.headers.get('content-type') ?? contentTypeFor(fmt),
      };
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const r = await mediaFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`, 'cloudflare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: p.input, lang: p.voice ?? 'en' }),
      });
      const j = (await r.json()) as { result?: { audio?: string } };
      const b64 = j.result?.audio;
      if (!b64) throw new MediaError('cloudflare returned no audio', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
    }
    case 'siliconflow': {
      const fmt = p.format ?? 'mp3';
      const r = await mediaFetch('https://api.siliconflow.com/v1/audio/speech', 'siliconflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, input: p.input, voice: p.voice ?? `${row.model_id}:alex`, response_format: fmt }),
      });
      return { audio: Buffer.from(await r.arrayBuffer()), contentType: contentTypeFor(fmt) };
    }
    case 'pollinations': {
      // OpenAI-shaped chat-completions with the audio modality returns b64 audio.
      // The anonymous tier needs no key; only send one when it's a real sk_ token.
      const realKey = key && key.startsWith('sk_') ? key : null;
      const r = await mediaFetch('https://gen.pollinations.ai/v1/chat/completions', 'pollinations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(realKey ? { Authorization: `Bearer ${realKey}` } : {}) },
        body: JSON.stringify({
          model: row.model_id,
          modalities: ['text', 'audio'],
          audio: { voice: p.voice ?? 'alloy', format: p.format ?? 'mp3' },
          messages: [{ role: 'user', content: p.input }],
        }),
      });
      const j = (await r.json()) as { choices?: { message?: { audio?: { data?: string } } }[] };
      const b64 = j.choices?.[0]?.message?.audio?.data;
      if (!b64) throw new MediaError('pollinations returned no audio', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: contentTypeFor(p.format ?? 'mp3') };
    }
    case 'google': {
      // Gemini TTS via generateContent (AUDIO modality) returns base64 PCM
      // (L16, mono, ~24kHz); wrap it in a WAV header so clients can play it.
      const r = await mediaFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${row.model_id}:generateContent?key=${encodeURIComponent(key ?? '')}`,
        'google',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: p.input }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice ?? 'Kore' } } },
            },
          }),
        },
      );
      const j = (await r.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
      };
      const part = j.candidates?.[0]?.content?.parts?.find(pt => pt.inlineData?.data);
      const b64 = part?.inlineData?.data;
      if (!b64) throw new MediaError('gemini returned no audio', 502);
      const rate = parseRate(part?.inlineData?.mimeType) ?? 24000;
      return { audio: wrapPcmAsWav(Buffer.from(b64, 'base64'), rate), contentType: 'audio/wav' };
    }
    default:
      throw new MediaError(`no speech adapter for platform '${row.platform}'`, 500);
  }
}

/** Map the request's `model` to a candidate chain within one modality:
 *  'auto'/empty → every enabled provider for the modality (failover order),
 *  a provider model id → just that row. */
function resolveMediaChain(model: string | undefined, modality: MediaModality): MediaModelRow[] {
  const rows = listMediaModels(modality);
  if (rows.length === 0) {
    throw new MediaError(`No enabled ${modality} providers configured.`, 503);
  }
  if (!model || model === 'auto') return rows;
  const matches = rows.filter(r => r.model_id === model);
  if (matches.length === 0) {
    throw new MediaError(`Unknown ${modality} model '${model}'. Use 'auto' or a provider model id.`, 400);
  }
  return matches;
}

function logMedia(row: MediaModelRow, keyId: number | null, status: 'success' | 'error', latencyMs: number, error: string | null): void {
  try {
    getDb()
      .prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`)
      .run(row.platform, row.model_id, keyId, status, latencyMs, error, row.modality);
  } catch (e) {
    console.error('Failed to log media request:', e);
  }
}

function chainError(modality: MediaModality, lastError: MediaError | null): MediaError {
  return new MediaError(
    `All ${modality} providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
  );
}

/** Generate image(s), failing over across providers serving the modality. */
export async function runImageGeneration(model: string | undefined, params: ImageParams): Promise<ImageResult> {
  const chain = resolveMediaChain(model, 'image');
  let lastError: MediaError | null = null;
  for (const row of chain) {
    const credential = KEYLESS_CAPABLE.has(row.platform)
      ? { id: null, key: null, baseUrl: null }
      : getProviderCredential(row);
    if (!credential) continue; // no usable key for this provider — try the next
    const started = Date.now();
    try {
      const images = await callImageProvider(row, credential, params);
      if (!images.length || images.every(i => !i.b64_json && !i.url)) {
        throw new MediaError('upstream returned no image', 502);
      }
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, images };
    } catch (err: any) {
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      lastError = e;
    }
  }
  throw chainError('image', lastError);
}

/** Synthesize speech, failing over across providers serving the modality. */
export async function runSpeech(model: string | undefined, params: SpeechParams): Promise<SpeechResult> {
  const chain = resolveMediaChain(model, 'audio');
  let lastError: MediaError | null = null;
  for (const row of chain) {
    const credential = KEYLESS_CAPABLE.has(row.platform)
      ? { id: null, key: null, baseUrl: null }
      : getProviderCredential(row);
    if (!credential) continue;
    const started = Date.now();
    try {
      const out = await callSpeechProvider(row, credential, params);
      if (!out.audio.length) throw new MediaError('upstream returned no audio', 502);
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, audio: out.audio, contentType: out.contentType };
    } catch (err: any) {
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      lastError = e;
    }
  }
  throw chainError('audio', lastError);
}
