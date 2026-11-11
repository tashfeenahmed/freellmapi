import { proxyFetch, openProviderWebSocket } from '../lib/proxy.js';
import { parseRetryAfterMs } from '../providers/base.js';
import type { SpeechParams, TranscriptionParams } from './media.js';

export class RimeMediaError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAfterMs?: number) { super(message); }
}

const VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
const TTS_HOSTS: Record<string, string> = { coda: 'https://coda.api.rime.ai/', mistv3: 'https://mist.api.rime.ai/' };

/** WAV is the tested native format. Do not mislabel WAV as the caller's MP3. */
export async function rimeSpeech(model: string, key: string | null, p: SpeechParams): Promise<{ audio: Buffer; contentType: string }> {
  if (!key) throw new RimeMediaError('Rime API key required', 401);
  const url = TTS_HOSTS[model];
  if (!url) throw new RimeMediaError('Unknown Rime speech model', 400);
  if (p.format && p.format !== 'wav') throw new RimeMediaError('Rime speech currently supports wav output through this adapter', 400);
  if (!p.input.trim() || p.input.length > 1000) throw new RimeMediaError('Rime speech requires 1–1000 characters per request', 400);
  const speaker = !p.voice || VOICES.has(p.voice.toLowerCase()) ? (model === 'coda' ? 'celeste' : 'cove') : p.voice;
  const response = await proxyFetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'audio/wav' },
    body: JSON.stringify({ text: p.input, speaker, lang: 'en', samplingRate: 24000 }),
  }, 'rime', 'audio', 60_000);
  if (!response.ok) {
    await response.body?.cancel();
    throw new RimeMediaError(`Rime speech failed (${response.status})`, response.status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
  }
  // Bound a streamed response rather than trusting Content-Length.
  const max = 20 * 1024 * 1024;
  if (!response.body || Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel(); throw new RimeMediaError('Rime speech output is missing or too large', 502);
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > max) { await reader.cancel(); throw new RimeMediaError('Rime speech output is too large', 502); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const audio = Buffer.concat(chunks);
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new RimeMediaError('Rime returned no recognized WAV audio', 502);
  return { audio, contentType: 'audio/wav' };
}

/** Decode PCM16 WAV without an external ffmpeg dependency on desktop/Docker.
 * Reject compressed or malformed input before opening a paid-capable socket.
 * Stereo is downmixed and common sample rates resampled to native 16k mono. */
export function rimePcm(file: Buffer): Buffer {
  const invalid = () => new RimeMediaError('Rime transcription requires a PCM16 WAV file (mono/stereo, 8–48 kHz)', 400);
  if (file.length < 44 || file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  let fmt: Buffer | undefined, data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= file.length;) {
    const size = file.readUInt32LE(offset + 4), end = offset + 8 + size;
    const id = file.toString('ascii', offset, offset + 4);
    // Native streaming WAV uses unknown lengths (0xffffffff) until EOF.
    // Only a terminal data chunk may use that sentinel.
    if (id === 'data' && size === 0xffffffff) { data = file.subarray(offset + 8); break; }
    if (end > file.length) throw invalid();
    if (id === 'fmt ') fmt = file.subarray(offset + 8, end);
    if (id === 'data') data = file.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data?.length || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw invalid();
  const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), align = fmt.readUInt16LE(12);
  if (![1, 2].includes(channels) || rate < 8000 || rate > 48000 || align !== channels * 2 || data.length % align) throw invalid();
  const frames = data.length / align, outputFrames = Math.floor(frames * 16000 / rate);
  if (outputFrames < 1 || outputFrames * 2 > 16 * 1024 * 1024) throw new RimeMediaError('Rime transcription exceeds the 16 MiB decoded-audio limit', 413);
  const output = Buffer.alloc(outputFrames * 2);
  const sample = (index: number) => {
    const start = Math.min(index, frames - 1) * align;
    return channels === 1 ? data.readInt16LE(start) : (data.readInt16LE(start) + data.readInt16LE(start + 2)) / 2;
  };
  for (let i = 0; i < outputFrames; i++) {
    const position = i * rate / 16000, left = Math.floor(position), fraction = position - left;
    output.writeInt16LE(Math.round(sample(left) * (1 - fraction) + sample(left + 1) * fraction), i * 2);
  }
  return output;
}

export async function rimeTranscription(model: string, key: string | null, p: TranscriptionParams): Promise<{ text: string; language: string; duration: number }> {
  if (!key) throw new RimeMediaError('Rime API key required', 401);
  if (model !== 'rime-stt') throw new RimeMediaError('Unknown Rime transcription model', 400);
  const language = p.language ?? 'en';
  if (!['en', 'es'].includes(language)) throw new RimeMediaError('Rime transcription supports en and es languages', 400);
  if (p.prompt || (p.temperature != null && p.temperature !== 0) || p.responseFormat === 'vtt') throw new RimeMediaError('Rime transcription does not support prompt, temperature or subtitles through this adapter', 400);
  const pcm = rimePcm(p.file);
  // Fixed host, authentication in the upgrade header only, never URL/query.
  const socket = await openProviderWebSocket('wss://stt.api.rime.ai/ws', 'rime', { protocols: ['rime.v1.json'], headers: { Authorization: `Bearer ${key}` } });
  return new Promise((resolve, reject) => {
    let settled = false, started = false;
    let pump: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: RimeMediaError, text = '') => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(pump);
      // No second utterance or background work survives success/failure.
      socket.close();
      if (error) reject(error); else resolve({ text, language, duration: pcm.length / 32000 });
    };
    const timer = setTimeout(() => finish(new RimeMediaError('Rime transcription timed out', 504)), 115_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ start: { language, outputContract: 'STREAMING_OUTPUT_CONTRACT_APPEND_FRAGMENTS' } })));
    socket.addEventListener('error', () => finish(new RimeMediaError('Rime transcription connection or authentication failed', 502)));
    socket.addEventListener('close', () => finish(new RimeMediaError('Rime closed before a final transcript', 502)));
    socket.addEventListener('message', event => {
      if (settled) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw new Error('invalid frame');
        const message = JSON.parse(event.data);
        if (message.started) {
          if (started) throw new Error('duplicate start');
          started = true;
          let offset = 0;
          const send = () => {
            if (settled) return;
            try {
              // Native message ceiling is 64 KiB decoded. Yield to handle
              // terminal events and respect backpressure during a long upload.
              if (socket.bufferedAmount < 128 * 1024) {
                if (offset >= pcm.length) { socket.send(JSON.stringify({ end: {} })); return; }
                const chunk = pcm.subarray(offset, offset + 32 * 1024); offset += chunk.length;
                socket.send(JSON.stringify({ audio: chunk.toString('base64') }));
              }
              pump = setTimeout(send, socket.bufferedAmount >= 128 * 1024 ? 10 : 0);
            } catch { finish(new RimeMediaError('Rime transcription upload failed', 502)); }
          };
          send();
        } else if (message.done) {
          if (!started || (message.done.text != null && typeof message.done.text !== 'string') || message.done.language?.tag !== language) throw new Error('invalid completion');
          // No speech is a valid empty final transcript. Partial hypotheses
          // alone are never accepted as completed transcriptions.
          finish(undefined, message.done.text ?? '');
        } else if (message.error) {
          const statuses: Record<string, number> = { invalid_input: 400, resource_exhausted: 429, timeout: 504, unavailable: 503, cancelled: 502, internal: 502 };
          finish(new RimeMediaError(`Rime transcription failed (${String(message.error.kind).slice(0, 40)})`, statuses[message.error.kind] ?? 502));
        } else if (message.cancelled) finish(new RimeMediaError('Rime transcription was cancelled', 502));
      } catch { finish(new RimeMediaError('Rime returned an invalid transcription response', 502)); }
    });
  });
}
