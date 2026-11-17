import { openProviderWebSocket, proxyFetch } from '../lib/proxy.js';
import { parseRetryAfterMs } from '../providers/base.js';
import type { TranscriptionParams } from './media.js';
import { rimePcm, RimeMediaError as AudioError } from './media-rime.js';

const host = 'oai.endpoints.kepler.ai.cloud.ovh.net';
/** OVH exposes Solaria through Gladia Live, not the Whisper file endpoint. */
export async function solariaTranscription(p: TranscriptionParams) {
  if ((p.language && p.language !== 'en') || p.prompt || (p.temperature != null && p.temperature !== 0) || !['json', 'verbose_json', 'text'].includes(p.responseFormat)) {
    throw new AudioError('Solaria supports English WAV transcription without prompts or subtitles', 400);
  }
  const pcm = rimePcm(p.file, 'Solaria'), duration = pcm.length / 32000;
  const response = await proxyFetch('https://' + host + '/gladia/v2/live?region=eu-west', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model: 'solaria-3', encoding: 'wav/pcm', sample_rate: 16000, bit_depth: 16, channels: 1,
      language_config: { languages: ['en'] }, messages_config: { receive_partial_transcripts: false, receive_final_transcripts: true } }),
  }, 'ovh', 'transcription', 20_000);
  if (!response.ok) {
    await response.body?.cancel();
    throw new AudioError('OVH could not open the transcription session (' + response.status + ')', response.status, undefined, parseRetryAfterMs(response.headers.get('retry-after')));
  }
  let target: URL;
  try {
    const session = await response.json() as { url?: unknown; id?: unknown };
    if (typeof session?.url !== 'string' || typeof session.id !== 'string' || !session.id) throw Error();
    target = new URL(session.url);
    if (target.protocol !== 'wss:' || target.host !== host || target.username || target.password || target.hash) throw Error();
  } catch { throw new AudioError('OVH returned an invalid transcription session', 502); }
  // Session URLs contain ephemeral credentials. Never report them on errors.
  const socket = await openProviderWebSocket(target.href, 'ovh').catch(() => { throw new AudioError('OVH transcription socket unavailable', 502); });
  return new Promise<{ text: string; language: string; duration: number }>((resolve, reject) => {
    let done = false, ended = false, offset = 0, chars = 0, pump: ReturnType<typeof setTimeout> | undefined;
    const parts: string[] = [];
    const finish = (error?: AudioError) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(pump); socket.close();
      if (error) reject(error); else resolve({ text: parts.join(' ').trim(), language: 'en', duration });
    };
    const fail = () => finish(new AudioError('Incomplete OVH transcription session', 502));
    const timer = setTimeout(() => finish(new AudioError('OVH transcription timed out', 504)), duration * 1000 + 30_000);
    const send = () => {
      if (done) return;
      try {
        if (socket.bufferedAmount >= 128 * 1024) { pump = setTimeout(send, 50); return; }
        if (offset === pcm.length) { ended = true; socket.send(JSON.stringify({ type: 'stop_recording' })); return; }
        const chunk = pcm.subarray(offset, offset + 3200); offset += chunk.length; socket.send(chunk);
        pump = setTimeout(send, chunk.length / 32);
      } catch { fail(); }
    };
    socket.addEventListener('open', send, { once: true });
    socket.addEventListener('error', fail);
    socket.addEventListener('close', e => { if (ended && e.code === 1000 && parts.length) finish(); else fail(); });
    socket.addEventListener('message', e => {
      if (done) return;
      try {
        if (typeof e.data !== 'string' || e.data.length > 1024 * 1024) throw Error();
        const m = JSON.parse(e.data);
        if (m.error || m.type === 'error') { fail(); return; }
        if (m.type === 'transcript' && m.data?.is_final === true) {
          const text = m.data.utterance?.text;
          if (typeof text !== 'string' || (chars += text.length) > 1024 * 1024 || parts.length >= 10000) throw Error();
          parts.push(text);
        } else if (m.type === 'post_final_transcript' || m.type === 'post_session_end') {
          if (ended) finish(); else fail();
        }
      } catch { fail(); }
    });
  });
}
