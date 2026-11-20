import { afterEach, describe, expect, it, vi } from 'vitest';
import * as proxy from '../../lib/proxy.js';
import { cartesiaTranscription, CARTESIA_VERSION } from '../../services/media-voice-gateways.js';

function wav() {
  const file = Buffer.alloc(3244); file.write('RIFF'); file.writeUInt32LE(file.length - 8, 4); file.write('WAVEfmt ', 8); file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22); file.writeUInt32LE(16000, 24); file.writeUInt32LE(32000, 28); file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34);
  file.write('data', 36); file.writeUInt32LE(3200, 40); return file;
}
class Socket extends EventTarget {
  bufferedAmount = 0; sent: (string | Buffer)[] = []; close = vi.fn();
  transcript: unknown = { type: 'transcript', text: 'Hello', is_final: true };
  finalize = true;
  send(data: string | Buffer) {
    this.sent.push(data);
    if (data === 'finalize' && this.finalize) setTimeout(() => {
      if (this.transcript) this.emit(this.transcript); this.emit({ type: 'flush_done' });
    }, 0);
    if (data === 'close') setTimeout(() => this.emit({ type: 'done' }), 0);
  }
  emit(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
function connection() {
  const socket = new Socket(); const mock = vi.spyOn(proxy, 'openProviderWebSocket').mockImplementation(async () => {
    setTimeout(() => socket.dispatchEvent(new Event('open')), 0); return socket as unknown as Awaited<ReturnType<typeof proxy.openProviderWebSocket>>;
  }); return { socket, mock };
}
const params = { file: wav(), filename: 'speech.wav', responseFormat: 'json' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Cartesia Ink 2 uploaded WAV bridge', () => {
  it('sends PCM binary, finalize and close through the proxy-aware authenticated socket', async () => {
    const { socket, mock } = connection();
    await expect(cartesiaTranscription('ink-2', 'synthetic-key', params)).resolves.toEqual({ text: 'Hello', language: 'en', duration: 0.1 });
    const [url, platform, options] = mock.mock.calls[0];
    const parsed = new URL(url); expect(parsed.origin).toBe('wss://api.cartesia.ai'); expect(parsed.pathname).toBe('/stt/websocket');
    expect(parsed.searchParams.get('model')).toBe('ink-2'); expect(parsed.searchParams.get('cartesia_version')).toBe(CARTESIA_VERSION);
    expect(url).not.toContain('synthetic-key'); expect(platform).toBe('cartesia'); expect(options?.headers).toEqual({ 'X-API-Key': 'synthetic-key' });
    expect(socket.sent).toEqual([wav().subarray(44), 'finalize', 'close']); expect(socket.close).toHaveBeenCalledOnce();
  });
  it.each([{ file: Buffer.from('ID3') }, { language: 'de' }, { prompt: 'hint' }, { responseFormat: 'vtt' }])('rejects unsupported input before using quota %j', async overrides => {
    const { mock } = connection(); await expect(cartesiaTranscription('ink-2', 'key', { ...params, ...overrides })).rejects.toMatchObject({ status: 400 }); expect(mock).not.toHaveBeenCalled();
  });
  it('accepts silence only after a complete flush and done handshake', async () => {
    const { socket } = connection(); socket.transcript = null;
    await expect(cartesiaTranscription('ink-2', 'key', params)).resolves.toMatchObject({ text: '' });
  });
  it('does not count a partial hypothesis as recognized final text', async () => {
    const { socket } = connection(); socket.transcript = { type: 'transcript', text: 'partial', is_final: false };
    await expect(cartesiaTranscription('ink-2', 'key', params)).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ type: 'done' }, { type: 'error', message: 'echoed-secret' }, { type: 'transcript', is_final: true, text: 5 }, { type: 'transcript', is_final: true, text: 'Hi', model: 'wrong' }])('fails closed on invalid native messages %j', async event => {
    const { socket } = connection(); socket.finalize = false;
    const result = expect(cartesiaTranscription('ink-2', 'key', params)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('echoed-secret') });
    setTimeout(() => socket.emit(event), 10); await result; expect(socket.close).toHaveBeenCalledOnce();
  });
  it('cleans up on connection failure, premature close and timeout', async () => {
    vi.useFakeTimers(); const { socket } = connection(); socket.finalize = false;
    const result = expect(cartesiaTranscription('ink-2', 'key', params)).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(115001); await result; expect(socket.close).toHaveBeenCalledOnce();
    const sent = socket.sent.length; await vi.advanceTimersByTimeAsync(120000); expect(socket.sent).toHaveLength(sent);
  });
});
