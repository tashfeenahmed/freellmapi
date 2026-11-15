import { proxyFetch, openProviderWebSocket } from '../lib/proxy.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { rimePcm, RimeMediaError } from './media-rime.js';
import type { SpeechParams, TranscriptionParams } from './media.js';

export class VoiceGatewayMediaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAfterMs?: number) { super(message); }
}
export const CARTESIA_VERSION = '2026-08-14';
const TYPECAST_MODELS = new Set(['ssfm-v31', 'ssfm-v30', 'ssfm-v21']);
const CARTESIA_MODELS = new Set(['sonic-3.6', 'sonic-3.5', 'sonic-3']);
const STANDARD_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel(); throw new VoiceGatewayMediaError('Speech response is missing or too large', 502);
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new VoiceGatewayMediaError('Speech response is too large', 502); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Check actual PCM chunks rather than trusting MIME, an ID3 tag or RIFF alone. */
function validWave(audio: Buffer): boolean {
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return false;
  let format: Buffer | undefined, data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4), size = audio.readUInt32LE(offset + 4);
    if (id === 'data' && size === 0xffffffff) { data = audio.subarray(offset + 8); break; }
    const end = offset + 8 + size; if (end > audio.length) return false;
    if (id === 'fmt ') format = audio.subarray(offset + 8, end);
    if (id === 'data') data = audio.subarray(offset + 8, end);
    offset = end + size % 2;
  }
  return !!format && format.length >= 16 && format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 1
    && format.readUInt32LE(4) === 44100 && format.readUInt16LE(14) === 16 && format.readUInt16LE(12) === 2
    && !!data && data.length > 0 && data.length % 2 === 0;
}

async function request(platform: 'typecast' | 'cartesia', url: string, init: RequestInit, maximum: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(60_000);
  try {
    const response = await proxyFetch(url, { ...init, redirect: 'error', signal }, platform, 'audio', 60_000);
    if (!response.ok) {
      await response.body?.cancel();
      // Do not include provider error bodies: they can echo submitted keys/text.
      throw new VoiceGatewayMediaError(`${platform} speech request failed (${response.status})`, response.status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
    }
    return await boundedBody(response, maximum);
  } catch (error) {
    if (signal.aborted) throw new VoiceGatewayMediaError(`${platform} speech request timed out`, 504);
    throw error;
  }
}

/** Defaults are the same voices that passed the live tests on all three model
 * versions. No cloning, voice discovery or synthetic quota-spending key probe. */
export async function voiceGatewaySpeech(platform: 'typecast' | 'cartesia', model: string, key: string | null, p: SpeechParams): Promise<{ audio: Buffer; contentType: string }> {
  if (!key?.trim()) throw new VoiceGatewayMediaError(`${platform} API key required`, 401);
  if (!(platform === 'typecast' ? TYPECAST_MODELS : CARTESIA_MODELS).has(model)) throw new VoiceGatewayMediaError('Unknown speech model', 400);
  if (!p.input.trim() || platform === 'typecast' && [...p.input].length > 2000) throw new VoiceGatewayMediaError('Speech input is empty or exceeds the native model input limit', 400);
  if (p.format && p.format !== 'wav') throw new VoiceGatewayMediaError(`${platform} currently supports wav output through this adapter`, 400);
  const supplied = p.voice?.trim(), useDefault = !supplied || STANDARD_VOICES.has(supplied.toLowerCase());
  const voice = useDefault ? (platform === 'typecast' ? 'tc_672c5f5ce59fac2a48faeaee' : 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4') : supplied;
  if (!(platform === 'typecast' ? /^(?:tc|uc)_[a-f0-9]{24}$/i : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i).test(voice)) {
    throw new VoiceGatewayMediaError(`${platform} requires a native voice ID`, 400);
  }
  const headers: Record<string, string> = platform === 'typecast' ? { 'X-API-KEY': key } : { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION };
  const body = platform === 'typecast'
    ? { model, voice_id: voice, text: p.input, prompt: { emotion_type: 'preset', emotion_preset: 'normal' }, output: { audio_format: 'wav' } }
    : { model_id: model, voice, transcript: p.input, language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 } };
  const audio = await request(platform, platform === 'typecast' ? 'https://api.typecast.ai/v1/text-to-speech' : 'https://api.cartesia.ai/tts/bytes', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'audio/wav' }, body: JSON.stringify(body),
  }, 20 * 1024 * 1024);
  if (!validWave(audio)) throw new VoiceGatewayMediaError(`${platform} returned no valid PCM WAV audio`, 502);
  return { audio, contentType: 'audio/wav' };
}

export async function cartesiaTranscription(model: string, key: string | null, p: TranscriptionParams): Promise<{ text: string; language?: string; duration?: number }> {
  if (!key?.trim()) throw new VoiceGatewayMediaError('Cartesia API key required', 401);
  if (!['ink-whisper', 'ink-2'].includes(model)) throw new VoiceGatewayMediaError('Unknown Cartesia transcription model', 400);
  if (!p.file.length || p.file.length > 25 * 1024 * 1024) throw new VoiceGatewayMediaError('Cartesia transcription requires a nonempty file up to 25 MiB', 400);
  if (p.prompt || p.temperature != null && p.temperature !== 0 || !['json', 'text', 'verbose_json'].includes(p.responseFormat)) {
    throw new VoiceGatewayMediaError('Cartesia transcription does not support prompts, temperature or subtitles through this adapter', 400);
  }
  if (p.language && !/^[a-z]{2}$/i.test(p.language)) throw new VoiceGatewayMediaError('Cartesia requires a two-letter language code', 400);
  if (model === 'ink-2') return cartesiaInk2(key, p);
  const form = new FormData();
  form.append('model', model);
  if (p.language) form.append('language', p.language);
  form.append('file', new Blob([new Uint8Array(p.file)], { type: p.mimeType ?? 'application/octet-stream' }), p.filename.replace(/[^a-z0-9._-]/gi, '_').slice(0, 128) || 'audio.wav');
  const bytes = await request('cartesia', 'https://api.cartesia.ai/stt', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION }, body: form,
  }, 1024 * 1024);
  let result: { text?: unknown; language?: unknown; duration?: unknown; model?: unknown; error?: unknown } | null;
  try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new VoiceGatewayMediaError('Cartesia returned invalid transcription JSON', 502); }
  if (!result || result.error || typeof result.text !== 'string' || result.model != null && result.model !== model
    || result.language != null && typeof result.language !== 'string'
    || result.duration != null && (typeof result.duration !== 'number' || !Number.isFinite(result.duration) || result.duration < 0)) {
    throw new VoiceGatewayMediaError('Cartesia returned invalid or substituted transcription metadata', 502);
  }
  return { text: result.text, ...(typeof result.language === 'string' ? { language: result.language } : {}), ...(typeof result.duration === 'number' ? { duration: result.duration } : {}) };
}

/** Bridge uploaded PCM16 WAV to Ink 2's manual-finalization socket. Reuse the
 * desktop-safe WAV downmix/resampler; never require a system ffmpeg binary.
 * The socket inherits the same per-key proxy policy as other native media. */
async function cartesiaInk2(key: string, p: TranscriptionParams): Promise<{ text: string; language: string; duration: number }> {
  const language = (p.language ?? 'en').toLowerCase();
  if (!['en', 'fr', 'hi', 'ja', 'es'].includes(language)) throw new VoiceGatewayMediaError('Ink 2 supports en, fr, hi, ja and es', 400);
  let pcm: Buffer;
  try { pcm = rimePcm(p.file); }
  catch (error) {
    if (error instanceof RimeMediaError) throw new VoiceGatewayMediaError(error.message.replaceAll('Rime', 'Cartesia Ink 2'), error.status);
    throw error;
  }
  const url = new URL('wss://api.cartesia.ai/stt/websocket');
  url.search = new URLSearchParams({ model: 'ink-2', encoding: 'pcm_s16le', sample_rate: '16000', cartesia_version: CARTESIA_VERSION, language }).toString();
  const socket = await openProviderWebSocket(url.href, 'cartesia', { headers: { 'X-API-Key': key } });
  return new Promise((resolve, reject) => {
    let settled = false, finalized = false, flushed = false, pendingPartial = false, offset = 0, characters = 0;
    let pump: ReturnType<typeof setTimeout> | undefined;
    const transcript: string[] = [];
    const finish = (error?: VoiceGatewayMediaError) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(pump); socket.close();
      if (error) reject(error); else resolve({ text: transcript.join(' ').trim(), language, duration: pcm.length / 32000 });
    };
    // Bound connection/finalization as well as upload; no background pump or
    // partial hypothesis can survive a failed request.
    const timer = setTimeout(() => finish(new VoiceGatewayMediaError('Cartesia Ink 2 transcription timed out', 504)), Math.max(115_000, Math.ceil(pcm.length / 32) + 30_000));
    const send = () => {
      if (settled) return;
      try {
        if (socket.bufferedAmount < 128 * 1024) {
          if (offset >= pcm.length) { finalized = true; socket.send('finalize'); return; }
          const chunk = pcm.subarray(offset, offset + 3200); offset += chunk.length; socket.send(chunk);
        }
        pump = setTimeout(send, 100);
      } catch { finish(new VoiceGatewayMediaError('Cartesia Ink 2 upload failed', 502)); }
    };
    socket.addEventListener('open', send);
    socket.addEventListener('error', () => finish(new VoiceGatewayMediaError('Cartesia Ink 2 connection or authentication failed', 502)));
    socket.addEventListener('close', () => finish(new VoiceGatewayMediaError('Cartesia Ink 2 closed before completion', 502)));
    socket.addEventListener('message', event => {
      if (settled) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('invalid frame');
        const message = JSON.parse(event.data);
        if (!message || typeof message !== 'object' || message.model !== undefined && message.model !== 'ink-2') throw new Error('invalid identity');
        if (message.type === 'transcript') {
          if (flushed || typeof message.text !== 'string' || typeof message.is_final !== 'boolean') throw new Error('invalid transcript');
          if (message.is_final) {
            pendingPartial = false;
            characters += message.text.length;
            if (characters > 1024 * 1024) throw new Error('oversized transcript');
            transcript.push(message.text);
          } else pendingPartial = message.text.trim().length > 0;
        } else if (message.type === 'flush_done') {
          if (!finalized || flushed || pendingPartial) throw new Error('unexpected or incomplete flush');
          flushed = true; socket.send('close');
        } else if (message.type === 'done') {
          if (!flushed) throw new Error('incomplete transcript');
          finish();
        } else if (message.type === 'error') {
          // Provider details may echo submitted text or auth; keep them out of logs.
          finish(new VoiceGatewayMediaError('Cartesia Ink 2 transcription failed', 502));
        } else throw new Error('unknown message');
      } catch { finish(new VoiceGatewayMediaError('Cartesia Ink 2 returned an invalid transcription response', 502)); }
    });
  });
}
