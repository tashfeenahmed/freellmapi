import { proxyFetch } from '../lib/proxy.js';
import { parseRetryAfterMs } from '../providers/base.js';
import type { SpeechParams } from './media.js';

export class FreeTtsMediaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAfterMs?: number) { super(message); }
}

const BASE = 'https://freetts.org';
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel(); throw new FreeTtsMediaError('FreeTTS response is missing or too large', 502);
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > maximum) { await reader.cancel(); throw new FreeTtsMediaError('FreeTTS response is too large', 502); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Validate complete consecutive Layer III frames, not just an ID3 tag or MIME
 * header. No external codec executable is required in desktop or Docker. */
function isMp3(audio: Buffer): boolean {
  let offset = 0;
  if (audio.toString('ascii', 0, 3) === 'ID3') {
    if (audio.length < 10 || ![2, 3, 4].includes(audio[3]) || audio.subarray(6, 10).some(byte => byte > 127)) return false;
    offset = 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]);
    if (audio[3] === 4 && (audio[5] & 0x10)) offset += 10;
  }
  for (let frame = 0; frame < 2; frame++) {
    if (offset + 4 > audio.length || audio[offset] !== 255 || (audio[offset + 1] & 0xe0) !== 0xe0) return false;
    const version = (audio[offset + 1] >> 3) & 3, layer = (audio[offset + 1] >> 1) & 3;
    const bitrateIndex = audio[offset + 2] >> 4, sampleIndex = (audio[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return false;
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * rates[bitrateIndex] * 1000 / sampleRate) + ((audio[offset + 2] >> 1) & 1);
    if (offset + length > audio.length) return false;
    offset += length;
  }
  return true;
}

/** Single logical TTS engine; voice names are parameters, not model rows.
 * Preserve the provider's spoken watermark and do not request paid formats. */
export async function freeTtsSpeech(model: string, key: string | null, p: SpeechParams): Promise<{ audio: Buffer; contentType: string }> {
  if (!key?.trim()) throw new FreeTtsMediaError('FreeTTS API key required', 401);
  if (model !== 'neural-tts') throw new FreeTtsMediaError('Unknown FreeTTS speech model', 400);
  if (!p.input.trim() || [...p.input].length > 1000 || /<\/?speak\b/i.test(p.input)) throw new FreeTtsMediaError('FreeTTS requires 1–1000 plain-text characters per request', 400);
  if (p.format && p.format !== 'mp3') throw new FreeTtsMediaError('FreeTTS Free supports mp3 output through this adapter', 400);
  const supplied = p.voice?.trim();
  const voice = !supplied || OPENAI_VOICES.has(supplied.toLowerCase()) ? 'en-US-JennyNeural' : supplied;
  if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice)) throw new FreeTtsMediaError('FreeTTS requires a native neural voice name', 400);
  const signal = AbortSignal.timeout(60_000), headers = { 'x-api-key': key };
  try {
    const response = await proxyFetch(`${BASE}/api/v1/tts`, {
      method: 'POST', redirect: 'error', signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: p.input, voice, rate: '+0%', pitch: '+0Hz', output_format: 'mp3' }),
    }, 'freetts', 'audio', 60_000);
    if (!response.ok) {
      await response.body?.cancel();
      throw new FreeTtsMediaError(`FreeTTS generation failed (${response.status})`, response.status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
    }
    const body = await boundedBody(response, 64 * 1024);
    let result: { file_id?: unknown; voice?: unknown; downgraded?: unknown; format?: unknown; error?: unknown };
    try { result = JSON.parse(body.toString('utf8')); } catch { throw new FreeTtsMediaError('FreeTTS returned invalid generation metadata', 502); }
    if (!result || typeof result.file_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.file_id)
      || result.error || result.voice !== voice || result.downgraded === true || result.format !== 'mp3') {
      throw new FreeTtsMediaError('FreeTTS returned invalid or substituted speech metadata', 502);
    }
    // Ignore audio_url entirely: never send this key to a provider-controlled
    // URL, another host, a redirect, or a file path outside the fixed API.
    const download = await proxyFetch(`${BASE}/api/audio/${result.file_id}`, { method: 'GET', headers, redirect: 'error', signal }, 'freetts', 'audio', 60_000);
    if (!download.ok) {
      await download.body?.cancel();
      throw new FreeTtsMediaError(`FreeTTS audio download failed (${download.status})`, download.status, undefined, parseRetryAfterMs(download.headers.get('retry-after')));
    }
    const audio = await boundedBody(download, 20 * 1024 * 1024);
    if (!isMp3(audio)) throw new FreeTtsMediaError('FreeTTS returned no valid MP3 audio', 502);
    return { audio, contentType: 'audio/mpeg' };
  } catch (error) {
    if (signal.aborted) throw new FreeTtsMediaError('FreeTTS speech request timed out', 504);
    throw error;
  }
}
