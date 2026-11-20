import { afterEach, describe, expect, it, vi } from 'vitest';
import * as proxy from '../../lib/proxy.js';
import { getProvider } from '../../providers/index.js';
import { solariaTranscription } from '../../services/media-solaria.js';

const meld = getProvider('meldport'), route = 'gpt-6-luna:free', messages = [{ role: 'user' as const, content: 'Hello' }];
const payload = (model = 'gpt-6-luna') => ({ model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }] });
const headers = { 'x-meldport-funding': 'promo' };
afterEach(() => vi.restoreAllMocks());
describe('Meldport promo-only chat', () => {
  it('uses the free alias, rejects redirects and requires promo confirmation', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload(), { headers }));
    expect((await meld.chatCompletion('test', messages, route)).choices[0].message.content).toBe('Hi');
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe('https://api.meldport.com/v1/chat/completions');
    expect(new Headers(init?.headers).get('x-meldport-funding')).toBe('promo');
    expect(init?.redirect).toBe('error'); expect(JSON.parse(String(init?.body)).model).toBe(route);
  });
  it.each(['wallet', ''])('does not accept funding %j', async funding => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload(), { headers: { 'x-meldport-funding': funding } }));
    await expect(meld.chatCompletion('test', messages, route)).rejects.toThrow('funding');
  });
  it('never dispatches held or paid aliases and rejects substituted models', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload('other'), { headers }));
    for (const id of ['glm-5.3-flash:free', 'gpt-6-luna']) await expect(meld.chatCompletion('test', messages, id)).rejects.toThrow('Unsupported');
    expect(f).not.toHaveBeenCalled(); await expect(meld.chatCompletion('test', messages, route)).rejects.toThrow('unexpected model');
  });
  it.each(['stop', null])('requires a completed streaming response: %s', async finish => {
    const c = { model: 'gpt-6-luna', choices: [{ delta: { content: 'Hi' }, index: 0, finish_reason: finish }] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: '+ JSON.stringify(c) +'\n\ndata: [DONE]\n\n', { headers }));
    const collect = async () => { const out = []; for await (const event of meld.streamChatCompletion('test', messages, route)) out.push(event); return out; };
    if (finish) expect(await collect()).toHaveLength(1); else await expect(collect()).rejects.toThrow('Incomplete');
  });
});
const host = 'oai.endpoints.kepler.ai.cloud.ovh.net';
const file = Buffer.alloc(364); file.write('RIFF'); file.writeUInt32LE(356, 4); file.write('WAVEfmt ', 8); file.writeUInt32LE(16, 16);
file.writeUInt16LE(1,20); file.writeUInt16LE(1,22); file.writeUInt32LE(16000,24); file.writeUInt32LE(32000,28); file.writeUInt16LE(2,32);
file.writeUInt16LE(16,34); file.write('data',36); file.writeUInt32LE(320,40);
const params = { file, filename: 'test.wav', responseFormat: 'json' };
describe('Solaria live transcription', () => {
  it.each(['wss://other.invalid/listen','https://' + host, 'wss://user@' + host])('rejects unsafe session destinations', async url => {
    vi.spyOn(proxy, 'proxyFetch').mockResolvedValue(Response.json({ id:'id', url })); const open = vi.spyOn(proxy, 'openProviderWebSocket');
    await expect(solariaTranscription(params)).rejects.toThrow('invalid transcription session'); expect(open).not.toHaveBeenCalled();
  });
  it.each([true,false])('accepts only finalized output: complete=%s', async complete => {
    const url = 'wss://' + host + '/session/test';
    const f = vi.spyOn(proxy, 'proxyFetch').mockResolvedValue(Response.json({ id:'id', url }));
    const socket = Object.assign(new EventTarget(), { bufferedAmount: 0, close: vi.fn(), send: vi.fn((frame: unknown) => {
      if (typeof frame !== 'string') return;
      expect(JSON.parse(frame)).toEqual({type:'stop_recording'});
      const event = (obj: unknown) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
      event({ type:'transcript', data:{is_final:false,utterance:{text:'wrong'}} });
      if (complete) { event({ type:'transcript', data:{is_final:true,utterance:{text:'Hello'}} }); event({type:'post_session_end'}); }
      else socket.dispatchEvent(Object.assign(new Event('close'), {code:1006}));
    }) });
    vi.spyOn(proxy, 'openProviderWebSocket').mockImplementation(async () => {
      setTimeout(() => socket.dispatchEvent(new Event('open')),0);
      return socket as unknown as Awaited<ReturnType<typeof proxy.openProviderWebSocket>>;
    });
    if (complete) expect(await solariaTranscription(params)).toMatchObject({text:'Hello',language:'en'});
    else await expect(solariaTranscription(params)).rejects.toThrow('Incomplete');
    const [endpoint, init] = f.mock.calls[0]; expect(endpoint).toBe('https://' + host + '/gladia/v2/live?region=eu-west');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false); expect(JSON.parse(String(init?.body))).toMatchObject({ model:'solaria-3', sample_rate:16000 });
    expect(socket.send.mock.calls[0][0]).toEqual(Buffer.alloc(320)); expect(socket.close).toHaveBeenCalled();
  });
  it('rejects unsupported input before opening a session', async () => {
    const f = vi.spyOn(proxy,'proxyFetch'); await expect(solariaTranscription({...params, responseFormat:'vtt'})).rejects.toMatchObject({status:400});
    await expect(solariaTranscription({...params, file:Buffer.from('ID3')})).rejects.toThrow('Solaria'); expect(f).not.toHaveBeenCalled();
  });
});
