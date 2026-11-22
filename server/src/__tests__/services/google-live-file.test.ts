import {afterEach,describe,expect,it,vi} from 'vitest';
import * as proxy from '../../lib/proxy.js';
import {googleLiveTranscription} from '../../services/media-google-live.js';

const file=Buffer.alloc(364);file.write('RIFF');file.writeUInt32LE(356,4);file.write('WAVEfmt ',8);
file.writeUInt32LE(16,16);file.writeUInt16LE(1,20);file.writeUInt16LE(1,22);file.writeUInt32LE(16000,24);
file.writeUInt32LE(32000,28);file.writeUInt16LE(2,32);file.writeUInt16LE(16,34);file.write('data',36);file.writeUInt32LE(320,40);
const params={file,filename:'test.wav',mimeType:'audio/wav',responseFormat:'json'};
afterEach(()=>vi.restoreAllMocks());
describe('file transcription over Google Live',()=>{
  it.each([true,false])('never promotes interim text to a final transcript (final=%s)',async(final)=>{
    const events=new EventTarget(),sent:Record<string,any>[]=[];
    const frame=(m:unknown)=>events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(m)}));
    const socket=Object.assign(events,{close:vi.fn(),send:(raw:string)=>{
      const m=JSON.parse(raw);sent.push(m);
      if(m.setup)queueMicrotask(()=>frame({setupComplete:{}}));
      if(m.realtimeInput?.activityEnd)queueMicrotask(()=>{
        frame({serverContent:{interimInputTranscription:{text:'discard me'}}});
        if(final)frame({serverContent:{inputTranscription:{text:'verified'},generationComplete:true}});
        else events.dispatchEvent(new Event('error'));
      });
    }});
    vi.spyOn(proxy,'openProviderWebSocket').mockImplementation(async()=>{
      setTimeout(()=>events.dispatchEvent(new Event('open')),0);
      return socket as unknown as Awaited<ReturnType<typeof proxy.openProviderWebSocket>>;
    });
    const req=googleLiveTranscription('test',params);
    if(final)await expect(req).resolves.toMatchObject({text:'verified'});else await expect(req).rejects.toThrow('Incomplete');
    expect(sent[0].setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
    expect(sent[1].realtimeInput).toHaveProperty('activityStart');expect(sent.at(-1)?.realtimeInput).toHaveProperty('activityEnd');
    expect(sent.slice(2,-1).every(x=>x.realtimeInput.audio.mimeType==='audio/pcm;rate=16000')).toBe(true);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
