import { openProviderWebSocket } from '../lib/proxy.js';
import { rimePcm, RimeMediaError as AudioError } from './media-rime.js';
import type { TranscriptionParams } from './media.js';

export async function googleLiveTranscription(key:string|null,p:TranscriptionParams){
  if(!key)throw new AudioError('Google key required',401);
  if(!['json','text','verbose_json'].includes(p.responseFormat)||p.prompt||p.temperature)throw new AudioError('Google Live supports plain WAV transcription only',400);
  const lang=p.language??'en-US';
  if(!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(lang))throw new AudioError('Invalid transcription language',400);
  const audio=rimePcm(p.file,'Google Live'), duration=audio.length/32000;
  // File input has an exact end: do not rely on silence detection to flush it.
  const pcm=Buffer.concat([audio,Buffer.alloc(9600)]);
  const socket=await openProviderWebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key='+encodeURIComponent(key),'google')
    .catch(()=>{throw new AudioError('Google transcription socket unavailable',502);});
  socket.binaryType='arraybuffer';
  return new Promise<{text:string;language:string;duration:number}>((resolve,reject)=>{
    let complete=false,ready=false,ended=false,interimPending=false,offset=0,text='',pump:ReturnType<typeof setTimeout>|undefined,quiet:ReturnType<typeof setTimeout>|undefined;
    const finish=(ok=false)=>{if(complete)return;complete=true;clearTimeout(timeout);clearTimeout(pump);clearTimeout(quiet);socket.close();
      if(ok&&ended&&!interimPending&&text.trim())resolve({text:text.trim(),language:lang,duration});else reject(new AudioError('Incomplete Google transcription',502));};
    const timeout=setTimeout(()=>finish(),duration*1000+35000);
    const settle=()=>{clearTimeout(quiet);if(ended&&!interimPending&&text.trim())quiet=setTimeout(()=>finish(true),4000);};
    const send=()=>{if(complete)return;try{
      if(offset>=pcm.length){ended=true;socket.send(JSON.stringify({realtimeInput:{activityEnd:{}}}));settle();return;}
      const chunk=pcm.subarray(offset,offset+3200);offset+=chunk.length;
      socket.send(JSON.stringify({realtimeInput:{audio:{mimeType:'audio/pcm;rate=16000',data:chunk.toString('base64')}}}));pump=setTimeout(send,chunk.length/32);
    }catch{finish();}};
    socket.addEventListener('open',()=>socket.send(JSON.stringify({setup:{model:'models/gemini-3.5-transcribe-live',generationConfig:{responseModalities:['TEXT']},realtimeInputConfig:{automaticActivityDetection:{disabled:true}},inputAudioTranscription:{languageCodes:[lang],mode:'VERBATIM'}}})),{once:true});
    socket.addEventListener('error',()=>finish());
    socket.addEventListener('close',e=>finish(e.code===1000));
    socket.addEventListener('message',e=>{if(complete)return;try{
      const frame=typeof e.data==='string'?e.data:Buffer.from(e.data as ArrayBuffer).toString();
      if(frame.length>1024*1024)throw Error();
      const m=JSON.parse(frame);if(m.error)throw Error();
      if(m.setupComplete&&!ready){ready=true;socket.send(JSON.stringify({realtimeInput:{activityStart:{}}}));send();}
      if(m.serverContent?.interimInputTranscription?.text){interimPending=true;clearTimeout(quiet);}
      const part=m.serverContent?.inputTranscription?.text;
      if(typeof part==='string'&&part){interimPending=false;text+=part;if(text.length>1024*1024)throw Error();settle();}
      if(ended&&(m.serverContent?.generationComplete||m.serverContent?.turnComplete)&&text.trim())finish(true);
    }catch{finish();}});
  });
}
