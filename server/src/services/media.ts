// Generative-media routing (image, video, and audio/TTS).
//
// Self-contained, exactly like embeddings: media models live in their OWN
// `media_models` table so they can NEVER enter the chat router's candidate pool
// (a chat request can't misroute to an image model) and never pollute the chat
// token budget. Each platform has a small adapter here; routing fails over
// across the providers serving the same modality. The rows are maintained in the
// published catalog and arrive via catalog-sync (premium on the live tier within
// ~12h, free once each model is 30 days old) — never seeded by migrations.
import { getDb } from '../db/index.js';
import { getClientContext } from '../lib/client-context.js';
import { decrypt } from '../lib/crypto.js';
import { proxyFetch } from '../lib/proxy.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { isOnCooldown, setCooldown } from './ratelimit.js';

/** Platforms with a media adapter below. catalog-sync gates media rows on this
 *  (decoupled from the chat provider registry — e.g. SiliconFlow is media-only). */
export const MEDIA_PLATFORMS = new Set(['nvidia', 'pollinations', 'cloudflare', 'siliconflow', 'google']);

/** Video uses a dedicated optional catalog registry so binaries that predate
 *  this modality ignore the rows instead of accidentally ingesting them as
 *  chat models. Keep its adapter allowlist separate for the same reason. */
export const VIDEO_PLATFORMS = new Set(['pollinations', 'huggingface']);

/** Platforms whose free media path needs no API key (anonymous). */
const KEYLESS_CAPABLE = new Set(['pollinations']);

/** Platforms with a speech-to-text adapter below. catalog-sync gates the
 *  catalog's `transcriptionModels` entries on this, the way MEDIA_PLATFORMS
 *  gates the generative-media rows. */
export const TRANSCRIPTION_PLATFORMS = new Set(['groq', 'cloudflare']);

// 'transcription' rows live in media_models like the other modalities; they
// arrive via the catalog's dedicated `transcriptionModels` array (see
// catalog-sync), never via migrations. Their per-model adapter metadata
// (native subtitle formats, upload ceiling, request flavor) rides in the
// meta_json column — see TranscriptionMeta below.
export type MediaModality = 'image' | 'video' | 'audio' | 'transcription';

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
  meta_json: string | null;
}

export class MediaError extends Error {
  status: number;
  /** Optional machine-readable error code surfaced in the OpenAI-shaped body. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
export interface VideoResult {
  platform: string;
  modelId: string;
  video: Buffer;
  contentType: string;
}
export interface ImageParams { prompt: string; n?: number; size?: string }
export interface SpeechParams { input: string; voice?: string; format?: string }
export interface VideoParams {
  prompt: string;
  duration?: number;
  aspectRatio?: '16:9' | '9:16';
  image?: string;
  seed?: number;
  audio?: boolean;
}

// OpenAI clients commonly send one of these voice names even when the user did
// not choose a voice explicitly. Native TTS providers use unrelated voice
// vocabularies, so forwarding the value verbatim makes an otherwise ordinary
// OpenAI request fail. Keep the translation here, at the provider boundary;
// custom OpenAI-compatible endpoints still receive the caller's value as-is.
// Pollinations' openai-audio route exposes the original OpenAI TTS vocabulary.
const POLLINATIONS_VOICES = new Set([
  'alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer',
]);

const SILICONFLOW_NATIVE_VOICES = new Set([
  'alex', 'anna', 'bella', 'benjamin', 'charles', 'claire', 'david', 'diana',
]);

const SILICONFLOW_OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: 'alex',
  ash: 'claire',
  ballad: 'diana',
  coral: 'bella',
  echo: 'benjamin',
  fable: 'charles',
  nova: 'anna',
  onyx: 'david',
  sage: 'benjamin',
  shimmer: 'bella',
  verse: 'charles',
  marin: 'anna',
  cedar: 'david',
};

const GEMINI_NATIVE_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const GEMINI_NATIVE_VOICE_LOOKUP = new Map(
  GEMINI_NATIVE_VOICES.map(voice => [voice.toLowerCase(), voice]),
);

const GEMINI_OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: 'Schedar',       // even
  ash: 'Charon',          // informative
  ballad: 'Enceladus',    // breathy
  coral: 'Sulafat',       // warm
  echo: 'Iapetus',        // clear
  fable: 'Puck',          // upbeat
  nova: 'Zephyr',         // bright
  onyx: 'Gacrux',         // mature
  sage: 'Sadaltager',     // knowledgeable
  shimmer: 'Achernar',    // soft
  verse: 'Laomedeia',     // upbeat
  marin: 'Aoede',         // breezy
  cedar: 'Kore',          // firm
};

function normalizedVoice(voice?: string): string | undefined {
  const value = voice?.trim().toLowerCase();
  return value || undefined;
}

function siliconFlowVoice(modelId: string, requested?: string): string {
  const raw = requested?.trim();
  const prefix = `${modelId}:`;
  const qualifiedNative = raw?.startsWith(prefix)
    ? normalizedVoice(raw.slice(prefix.length))
    : undefined;
  const name = qualifiedNative && SILICONFLOW_NATIVE_VOICES.has(qualifiedNative)
    ? qualifiedNative
    : normalizedVoice(raw);
  const native = name && SILICONFLOW_NATIVE_VOICES.has(name) ? name : undefined;
  const mapped = name ? SILICONFLOW_OPENAI_VOICE_MAP[name] : undefined;
  return `${modelId}:${native ?? mapped ?? 'alex'}`;
}

function pollinationsVoice(requested?: string): string {
  const voice = normalizedVoice(requested);
  return voice && POLLINATIONS_VOICES.has(voice) ? voice : 'alloy';
}

function geminiVoice(requested?: string): string {
  const voice = normalizedVoice(requested);
  if (!voice) return 'Kore';
  return GEMINI_NATIVE_VOICE_LOOKUP.get(voice)
    ?? GEMINI_OPENAI_VOICE_MAP[voice]
    ?? 'Kore';
}

// Media generations are slower than chat — a cold FLUX/SDXL run can take 30-60s.
const FETCH_TIMEOUT_MS = 60_000;
// Video providers submit long-running jobs and can legitimately need several
// minutes before the MP4 is ready. This is still bounded end-to-end.
const VIDEO_FETCH_TIMEOUT_MS = 5 * 60_000;

/** Bail out of a long-running media job whose API caller has hung up. Video is
 *  the only surface here that can poll for minutes, so without this a client
 *  that disconnects after two seconds still costs a full generation — and a
 *  second one, when the chain fails over to the next provider. */
function throwIfClientGone(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaError('client closed the request', 499);
}

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

function getProviderCredential(row: Pick<MediaModelRow, 'platform' | 'key_id'>): ProviderCredential | null {
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
    .prepare("SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY RANDOM() LIMIT 1")
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

async function mediaFetch(
  url: string,
  platform: string,
  modality: MediaModality,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
  /** The caller's own cancellation (a disconnected API client), folded in on
   *  top of the per-request timeout so a departed client drops the upstream
   *  request instead of leaving it to run out the clock. */
  clientSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = clientSignal ? AbortSignal.any([timeoutSignal, clientSignal]) : timeoutSignal;
  const r = await proxyFetch(
    url,
    { ...init, signal },
    platform,
    modality,
    timeoutMs,
  );
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

/** Adapter request flavor for a generative media row, read from meta_json.
 *  One platform can host several deployment styles: Cloudflare takes a JSON
 *  body for most image models but multipart/form-data for the FLUX.2 family.
 *  Absent meta = the platform's default style, so old rows are untouched. */
function mediaRequestStyle(row: MediaModelRow): string | null {
  if (!row.meta_json) return null;
  try {
    const parsed = JSON.parse(row.meta_json) as { requestStyle?: unknown };
    return typeof parsed?.requestStyle === 'string' ? parsed.requestStyle : null;
  } catch {
    return null;
  }
}

interface VideoMeta {
  /** Provider-native deployment id. Hugging Face model ids are mapped to fal
   *  queue ids in the catalog so runtime calls need no mutable discovery step. */
  providerModelId?: string;
}

function videoMeta(row: MediaModelRow): VideoMeta {
  if (!row.meta_json) return {};
  try {
    const parsed = JSON.parse(row.meta_json) as VideoMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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
      const r = await mediaFetch(`${credential.baseUrl}/images/generations`, 'custom', 'image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key ?? 'no-key'}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { data?: { b64_json?: string; url?: string }[] };
      return (j.data ?? []).map(i => ({ b64_json: i.b64_json, url: i.url }));
    }
    case 'nvidia': {
      // NVIDIA NIM image models live at ai.api.nvidia.com/v1/genai/{model};
      // response is { artifacts: [{ base64 }] }. The hosted FLUX deployments
      // do not share one request schema: FLUX.1 Dev rejects the four-step
      // defaults used by Schnell, while FLUX.2 Klein rejects `mode` and
      // guidance fields entirely.
      let body: Record<string, unknown>;
      switch (row.model_id) {
        case 'black-forest-labs/flux.1-dev':
          body = {
            prompt: p.prompt,
            mode: 'base',
            steps: 28,
            width: 1024,
            height: 1024,
            cfg_scale: 3.5,
          };
          break;
        case 'black-forest-labs/flux.2-klein-4b':
          body = { prompt: p.prompt, steps: 4, width: 1024, height: 1024 };
          break;
        default:
          body = { prompt: p.prompt, mode: 'base', steps: 4, width: w, height: h };
      }
      const r = await mediaFetch(`https://ai.api.nvidia.com/v1/genai/${row.model_id}`, 'nvidia', 'image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { artifacts?: { base64?: string }[] };
      return (j.artifacts ?? []).map(a => ({ b64_json: a.base64 }));
    }
    case 'pollinations': {
      // Keyless GET image endpoint returns raw image bytes.
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(p.prompt)}?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(row.model_id)}`;
      const r = await mediaFetch(url, 'pollinations', 'image', { method: 'GET' });
      const buf = Buffer.from(await r.arrayBuffer());
      return [{ b64_json: buf.toString('base64') }];
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`;
      // Most CF image models take a JSON body. The FLUX.2 family declares a
      // multipart input schema and rejects JSON outright ("required properties
      // at '/' are 'multipart'"), so those rows opt in through catalog meta.
      let init: RequestInit;
      if (mediaRequestStyle(row) === 'multipart') {
        // Never set Content-Type by hand — FormData supplies the boundary.
        const form = new FormData();
        form.append('prompt', p.prompt);
        form.append('width', String(w));
        form.append('height', String(h));
        init = { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form };
      } else {
        // Cloudflare's FLUX.1 Schnell schema is prompt-only; dimensions that
        // the other JSON image models accept are rejected as extra fields.
        const body = row.model_id === '@cf/black-forest-labs/flux-1-schnell'
          ? { prompt: p.prompt }
          : { prompt: p.prompt, width: w, height: h };
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        };
      }
      const r = await mediaFetch(url, 'cloudflare', 'image', init);
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
      const r = await mediaFetch('https://api.siliconflow.com/v1/images/generations', 'siliconflow', 'image', {
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

async function callHuggingFaceVideo(
  row: MediaModelRow,
  key: string | null,
  p: VideoParams,
  clientSignal?: AbortSignal,
): Promise<{ video: Buffer; contentType: string }> {
  if (!key) throw new MediaError('huggingface key required', 401);
  const providerModelId = videoMeta(row).providerModelId;
  if (!providerModelId) {
    throw new MediaError(`huggingface video model '${row.model_id}' is missing providerModelId metadata`, 500);
  }

  const deadline = Date.now() + VIDEO_FETCH_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  const query = '?_subdomain=queue';
  const queueUrl = `https://router.huggingface.co/fal-ai/${providerModelId}${query}`;
  const submitted = await mediaFetch(queueUrl, 'huggingface', 'video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      prompt: p.prompt,
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
    }),
  }, remaining(), clientSignal);
  const queue = (await submitted.json()) as {
    request_id?: string;
    status?: string;
    response_url?: string;
  };
  if (!queue.request_id || !queue.response_url) {
    throw new MediaError('huggingface returned no video job id', 502);
  }

  // Hugging Face's fal router returns a fal queue response URL. Only reuse its
  // path; all polling stays on router.huggingface.co so the HF token is never
  // sent to an arbitrary host supplied in an upstream JSON body.
  let responsePath: string;
  try {
    responsePath = new URL(queue.response_url, 'https://queue.fal.run').pathname;
  } catch {
    throw new MediaError('huggingface returned an invalid video job URL', 502);
  }
  const routedJobUrl = `https://router.huggingface.co/fal-ai${responsePath}`;
  let status = queue.status ?? 'IN_QUEUE';
  while (status !== 'COMPLETED') {
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new MediaError(`huggingface video job ${status.toLowerCase()}`, 502);
    }
    if (remaining() <= 1) throw new MediaError('huggingface video generation timed out', 504);
    throwIfClientGone(clientSignal);
    await new Promise(resolve => setTimeout(resolve, 500));
    const polled = await mediaFetch(`${routedJobUrl}/status${query}`, 'huggingface', 'video', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    }, remaining(), clientSignal);
    const state = (await polled.json()) as { status?: string; error?: string };
    if (!state.status) throw new MediaError('huggingface returned an invalid video job status', 502);
    status = state.status;
  }

  const completed = await mediaFetch(`${routedJobUrl}${query}`, 'huggingface', 'video', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  }, remaining(), clientSignal);
  const result = (await completed.json()) as { video?: { url?: string; content_type?: string } };
  const videoUrl = result.video?.url;
  if (!videoUrl) throw new MediaError('huggingface returned no video URL', 502);
  // Every other URL this adapter contacts is built from constants; this one
  // comes out of an upstream JSON body, which is exactly the shape #440's
  // guard exists for. Refuse anything that is not plain http(s) on a routable
  // address before spending a request on it — a result URL pointing at cloud
  // metadata or a link-local address would otherwise be fetched and streamed
  // straight back to the caller.
  const verdict = await assessProviderUrl(videoUrl);
  if (!verdict.allowed) {
    throw new MediaError(`huggingface returned an unusable video URL: ${verdict.reason}`, 502);
  }
  const downloaded = await mediaFetch(videoUrl, 'huggingface', 'video', { method: 'GET' }, remaining(), clientSignal);
  const video = Buffer.from(await downloaded.arrayBuffer());
  return {
    video,
    contentType: downloaded.headers.get('content-type') ?? result.video?.content_type ?? 'video/mp4',
  };
}

async function callVideoProvider(
  row: MediaModelRow,
  credential: ProviderCredential,
  p: VideoParams,
  clientSignal?: AbortSignal,
): Promise<{ video: Buffer; contentType: string }> {
  const key = credential.key;
  switch (row.platform) {
    case 'pollinations': {
      if (!key) throw new MediaError('pollinations key required', 401);
      // Every Pollinations video model advertises its own allowed durations
      // (nova-reel 6-120 in steps of 6, veo 4/6/8, minimax-h3 exactly 5,
      // wan 5/10/15, seedance-2.5 exactly 4...). There is no length that is
      // valid everywhere, so an omitted `duration` is left off the query and
      // the provider applies the model's own default instead of a guess that
      // would 400 on most of the roster.
      const duration = p.duration;
      if (duration !== undefined && row.model_id === 'nova-reel'
          && (duration < 6 || duration > 120 || duration % 6 !== 0)) {
        throw new MediaError('nova-reel duration must be a multiple of 6 between 6 and 120 seconds', 400);
      }
      const params = new URLSearchParams({ model: row.model_id });
      if (duration !== undefined) params.set('duration', String(duration));
      if (p.aspectRatio) params.set('aspectRatio', p.aspectRatio);
      if (p.image) params.set('image', p.image);
      if (p.seed !== undefined) params.set('seed', String(p.seed));
      if (p.audio !== undefined) params.set('audio', String(p.audio));
      const r = await mediaFetch(
        `https://gen.pollinations.ai/video/${encodeURIComponent(p.prompt)}?${params}`,
        'pollinations',
        'video',
        { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
        VIDEO_FETCH_TIMEOUT_MS,
        clientSignal,
      );
      return {
        video: Buffer.from(await r.arrayBuffer()),
        contentType: r.headers.get('content-type') ?? 'video/mp4',
      };
    }
    case 'huggingface':
      return callHuggingFaceVideo(row, key, p, clientSignal);
    default:
      throw new MediaError(`no video adapter for platform '${row.platform}'`, 500);
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
      const r = await mediaFetch(`${credential.baseUrl}/audio/speech`, 'custom', 'audio', {
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
      const r = await mediaFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${row.model_id}`, 'cloudflare', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // MeloTTS has a language selector, not a voice selector. In particular,
        // OpenAI's default `alloy` must never be sent as `lang`.
        body: JSON.stringify({ prompt: p.input, lang: 'en' }),
      });
      const j = (await r.json()) as { result?: { audio?: string } };
      const b64 = j.result?.audio;
      if (!b64) throw new MediaError('cloudflare returned no audio', 502);
      return { audio: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
    }
    case 'siliconflow': {
      const fmt = p.format ?? 'mp3';
      const r = await mediaFetch('https://api.siliconflow.com/v1/audio/speech', 'siliconflow', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model_id,
          input: p.input,
          voice: siliconFlowVoice(row.model_id, p.voice),
          response_format: fmt,
        }),
      });
      return { audio: Buffer.from(await r.arrayBuffer()), contentType: contentTypeFor(fmt) };
    }
    case 'pollinations': {
      // OpenAI-shaped chat-completions with the audio modality returns b64 audio.
      // The anonymous tier needs no key; only send one when it's a real sk_ token.
      const realKey = key && key.startsWith('sk_') ? key : null;
      const r = await mediaFetch('https://gen.pollinations.ai/v1/chat/completions', 'pollinations', 'audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(realKey ? { Authorization: `Bearer ${realKey}` } : {}) },
        body: JSON.stringify({
          model: row.model_id,
          modalities: ['text', 'audio'],
          audio: { voice: pollinationsVoice(p.voice), format: p.format ?? 'mp3' },
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
        `https://generativelanguage.googleapis.com/v1beta/models/${row.model_id}:generateContent`,
        'google',
        'audio',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key ?? '' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: p.input }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiVoice(p.voice) } } },
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

function logMedia(row: Pick<MediaModelRow, 'platform' | 'model_id' | 'modality'>, keyId: number | null, status: 'success' | 'error', latencyMs: number, error: string | null): void {
  try {
    const client = getClientContext();
    getDb()
      .prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
                VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`)
      .run(row.platform, row.model_id, keyId, status, latencyMs, error, row.modality, client.ip, client.userAgent, client.agent);
  } catch (e) {
    console.error('Failed to log media request:', e);
  }
}

function chainError(modality: MediaModality, lastError: MediaError | null): MediaError {
  // Only statuses the CALLER can act on are passed through. 400 (bad prompt,
  // duration the model does not accept) and 413 (upload too large) describe
  // the caller's own request, and 429 is the long-standing rate-limit signal.
  // An upstream 401 is deliberately NOT among them: it means the operator's
  // provider key was rejected, and forwarding it would tell an OpenAI client
  // its own gateway key is bad — which sends SDKs into a credential error
  // instead of the retryable upstream failure this actually is.
  const status = lastError && [400, 413, 429].includes(lastError.status)
    ? lastError.status
    : 502;
  return new MediaError(
    `All ${modality} providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    status,
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

/** Generate a video, failing over across catalogued text-to-video providers.
 *  `clientSignal` is the API caller's connection: when it aborts, the in-flight
 *  upstream request is dropped and no further provider is tried. */
export async function runVideoGeneration(
  model: string | undefined,
  params: VideoParams,
  clientSignal?: AbortSignal,
): Promise<VideoResult> {
  const chain = resolveMediaChain(model, 'video');
  let lastError: MediaError | null = null;
  for (const row of chain) {
    throwIfClientGone(clientSignal);
    const credential = getProviderCredential(row);
    if (!credential) continue;
    if (credential.id != null && isOnCooldown(row.platform, row.model_id, credential.id)) continue;
    const started = Date.now();
    try {
      const out = await callVideoProvider(row, credential, params, clientSignal);
      if (!out.video.length) throw new MediaError('upstream returned no video', 502);
      logMedia(row, credential.id, 'success', Date.now() - started, null);
      return { platform: row.platform, modelId: row.model_id, ...out };
    } catch (err: any) {
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(row, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      if (e.status === 429 && credential.id != null) setCooldown(row.platform, row.model_id, credential.id);
      lastError = e;
      // A caller that hung up gets no second generation charged to its account.
      throwIfClientGone(clientSignal);
    }
  }
  throw chainError('video', lastError);
}

// ---------------------------------------------------------------------------
// Speech-to-text (/v1/audio/transcriptions)
//
// STT models live in media_models with modality='transcription', maintained
// by the published catalog's `transcriptionModels` array (see catalog-sync)
// — never hardcoded here, never seeded by migrations. A user can also
// register their own OpenAI-compatible STT endpoint (platform 'custom') from
// the Keys page; those rows are keyed to an api_keys row and are never touched
// by catalog-sync. The per-platform
// adapters below are pure transport; everything model-specific (native
// subtitle support, upload ceiling, request flavor) rides on the catalog
// entry and lands in the row's meta_json. On an install that has never
// synced a catalog listing transcription models, the endpoint returns an
// OpenAI-shaped 503 with code 'no_transcription_models' until the first
// sync lands. Key selection, failover, cooldowns, and request logging reuse
// the exact same machinery as the other media modalities above.

/** Per-model adapter metadata carried on the catalog entry (meta_json). */
export interface TranscriptionMeta {
  /** Subtitle formats the provider returns natively (e.g. ['vtt']). Formats
   *  not produced natively by the chain are refused with 400 at the route. */
  subtitleFormats?: string[];
  /** Provider upload ceiling in bytes; absent = MAX_TRANSCRIPTION_BYTES. */
  maxBytes?: number | null;
  /** Adapter request flavor where one platform hosts more than one deployment
   *  style. Cloudflare: 'json' = JSON body with base64 audio (large-v3-turbo),
   *  'binary' = raw bytes (plain whisper, the default). */
  requestStyle?: string | null;
}

/** Global upload ceiling enforced by the route (multer) so it can reject
 *  early with a clean OpenAI-shaped 413 instead of buffering an upload no
 *  provider can accept. Per-model catalog `maxBytes` may only lower this. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/** A transcription candidate: a media_models row with its meta decoded. */
interface SttCandidate {
  platform: string;
  modelId: string;
  /** The api_keys row this model is bound to, or null to pick any healthy key
   *  for the platform. Custom endpoints ALWAYS carry one: getProviderCredential
   *  refuses to guess a key for platform 'custom', so dropping this here would
   *  silently skip every custom STT row. */
  keyId: number | null;
  nativeSubtitles: Set<string>;
  maxBytes: number;
  requestStyle: string | null;
}

function parseTranscriptionMeta(raw: string | null): TranscriptionMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TranscriptionMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toSttCandidate(row: MediaModelRow): SttCandidate {
  const meta = parseTranscriptionMeta(row.meta_json);
  const maxBytes =
    typeof meta.maxBytes === 'number' && meta.maxBytes > 0
      ? Math.min(meta.maxBytes, MAX_TRANSCRIPTION_BYTES)
      : MAX_TRANSCRIPTION_BYTES;
  return {
    platform: row.platform,
    modelId: row.model_id,
    keyId: row.key_id,
    nativeSubtitles: new Set(Array.isArray(meta.subtitleFormats) ? meta.subtitleFormats : []),
    maxBytes,
    requestStyle: typeof meta.requestStyle === 'string' ? meta.requestStyle : null,
  };
}

/** Model ids that mean "let the router decide". `whisper-1` is what stock
 *  OpenAI clients send by default, so it must route rather than 400. */
const TRANSCRIPTION_AUTO_IDS = new Set(['auto', 'whisper-1']);

export interface TranscriptionParams {
  file: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
  /** 'json' | 'text' | 'verbose_json' | 'vtt' (srt is rejected at the route). */
  responseFormat: string;
}

export interface TranscriptionResult {
  platform: string;
  modelId: string;
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  vtt?: string;
}

function resolveTranscriptionChain(model: string | undefined, responseFormat: string): SttCandidate[] {
  let chain = listMediaModels('transcription').map(toSttCandidate);
  if (chain.length === 0) {
    // Never-synced install (or the catalog retired every STT model): the
    // registry only ever arrives via catalog-sync, so tell the caller to wait
    // for / trigger a sync rather than pretending the model id is wrong.
    throw new MediaError(
      'No transcription models are configured yet. The registry arrives via catalog sync; ' +
      'wait for the next sync (or trigger one from the dashboard) and retry, ' +
      'or register your own OpenAI-compatible endpoint from the Keys page.',
      503,
      'no_transcription_models',
    );
  }
  if (model && !TRANSCRIPTION_AUTO_IDS.has(model.toLowerCase())) {
    chain = chain.filter(m => m.modelId === model);
    if (chain.length === 0) {
      throw new MediaError(
        `Unknown transcription model '${model}'. Use 'auto', 'whisper-1', or a provider model id.`,
        400,
      );
    }
  }
  if (responseFormat === 'vtt') {
    chain = chain.filter(m => m.nativeSubtitles.has('vtt'));
    if (chain.length === 0) {
      throw new MediaError(
        "response_format 'vtt' is only served by providers that produce it natively; " +
        'the requested model does not.',
        400,
      );
    }
  }
  return chain;
}

async function callTranscriptionProvider(
  m: SttCandidate,
  credential: ProviderCredential,
  p: TranscriptionParams,
): Promise<Omit<TranscriptionResult, 'platform' | 'modelId'>> {
  const key = credential.key;
  switch (m.platform) {
    case 'custom': {
      // Any OpenAI-compatible STT server (faster-whisper-server, LocalAI,
      // whisper.cpp's server, vLLM…). Same multipart shape as groq below;
      // only the base URL and the optional key differ.
      if (!credential.baseUrl) throw new MediaError('custom transcription provider is missing base_url', 500);
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      if (p.language) form.append('language', p.language);
      if (p.prompt) form.append('prompt', p.prompt);
      if (p.temperature !== undefined) form.append('temperature', String(p.temperature));
      // 'text' is derived locally from the json shape so failover output stays
      // uniform; 'vtt' never reaches here (no native subtitle support is
      // declared for custom rows, so resolveTranscriptionChain filters them).
      form.append('response_format', p.responseFormat === 'verbose_json' ? 'verbose_json' : 'json');
      // Never set Content-Type by hand — FormData supplies the boundary.
      const r = await mediaFetch(`${credential.baseUrl}/audio/transcriptions`, 'custom', 'transcription', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key ?? 'no-key'}` },
        body: form,
      });
      const j = (await r.json()) as { text?: string; language?: string; duration?: number; segments?: unknown[] };
      if (typeof j.text !== 'string') throw new MediaError('custom endpoint returned no transcription text', 502);
      return { text: j.text, language: j.language, duration: j.duration, segments: j.segments };
    }
    case 'groq': {
      // Groq's OpenAI-compatible audio endpoint takes multipart form data.
      // Never set Content-Type by hand — FormData supplies the boundary.
      const form = new FormData();
      form.append('file', new Blob([p.file], { type: p.mimeType || 'application/octet-stream' }), p.filename);
      form.append('model', m.modelId);
      if (p.language) form.append('language', p.language);
      if (p.prompt) form.append('prompt', p.prompt);
      if (p.temperature !== undefined) form.append('temperature', String(p.temperature));
      // Groq supports json/verbose_json/text natively; text is derived locally
      // from the json shape so failover output stays uniform.
      form.append('response_format', p.responseFormat === 'verbose_json' ? 'verbose_json' : 'json');
      const r = await mediaFetch('https://api.groq.com/openai/v1/audio/transcriptions', 'groq', 'transcription', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const j = (await r.json()) as { text?: string; language?: string; duration?: number; segments?: unknown[] };
      if (typeof j.text !== 'string') throw new MediaError('groq returned no transcription text', 502);
      return { text: j.text, language: j.language, duration: j.duration, segments: j.segments };
    }
    case 'cloudflare': {
      const { accountId, token } = parseCfKey(key);
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${m.modelId}`;
      const init: RequestInit = m.requestStyle === 'json'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              audio: p.file.toString('base64'),
              ...(p.language ? { language: p.language } : {}),
              ...(p.prompt ? { initial_prompt: p.prompt } : {}),
            }),
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
            body: p.file,
          };
      const r = await mediaFetch(url, 'cloudflare', 'transcription', init);
      const j = (await r.json()) as {
        result?: {
          text?: string;
          vtt?: string;
          segments?: unknown[];
          transcription_info?: { language?: string; duration?: number };
        };
      };
      const result = j.result;
      if (!result || typeof result.text !== 'string') {
        throw new MediaError('cloudflare returned no transcription text', 502);
      }
      return {
        text: result.text,
        language: result.transcription_info?.language,
        duration: result.transcription_info?.duration,
        segments: result.segments,
        vtt: typeof result.vtt === 'string' ? result.vtt : undefined,
      };
    }
    default:
      throw new MediaError(`no transcription adapter for platform '${m.platform}'`, 500);
  }
}

/** Transcribe audio, failing over across STT providers. 429s bench the
 *  (platform, model, key) triple through the standard cooldown machinery so a
 *  rate-limited key is skipped on subsequent requests, exactly like chat. */
export async function runTranscription(model: string | undefined, p: TranscriptionParams): Promise<TranscriptionResult> {
  const chain = resolveTranscriptionChain(model, p.responseFormat);
  const usable = chain.filter(m => p.file.length <= m.maxBytes);
  if (usable.length === 0) {
    const maxMb = Math.max(...chain.map(m => m.maxBytes)) / (1024 * 1024);
    throw new MediaError(`Audio file exceeds the ${maxMb} MB provider upload limit.`, 413);
  }
  let lastError: MediaError | null = null;
  for (const m of usable) {
    const credential = getProviderCredential({ platform: m.platform, key_id: m.keyId });
    if (!credential) continue; // no usable key for this provider — try the next
    if (credential.id != null && isOnCooldown(m.platform, m.modelId, credential.id)) continue;
    const logRow = { platform: m.platform, model_id: m.modelId, modality: 'transcription' as const };
    const started = Date.now();
    try {
      const out = await callTranscriptionProvider(m, credential, p);
      if (p.responseFormat === 'vtt' && !out.vtt) {
        throw new MediaError('upstream returned no vtt subtitles', 502);
      }
      logMedia(logRow, credential.id, 'success', Date.now() - started, null);
      return { platform: m.platform, modelId: m.modelId, ...out };
    } catch (err: any) {
      const e = err instanceof MediaError ? err : new MediaError(String(err?.message ?? err), 502);
      logMedia(logRow, credential.id, 'error', Date.now() - started, e.message.slice(0, 300));
      if (e.status === 429 && credential.id != null) {
        setCooldown(m.platform, m.modelId, credential.id);
      }
      lastError = e;
    }
  }
  throw chainError('transcription', lastError);
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
