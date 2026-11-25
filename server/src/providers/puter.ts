import { randomUUID } from 'node:crypto';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';

// Wire IDs only. No route is discovered or enabled without the signed catalog.
const pinned: Record<string,string> = {
  "deepseek-v4-flash-0731": "alibaba:deepseek/deepseek-v4-flash-0731",
  "qwen3.8-omni-flash": "alibaba:qwen/qwen3.8-omni-flash",
  "kimi-k2.6": "moonshotai:moonshotai/kimi-k2.6",
  "gemini-4-hydrogen": "google:google/gemini-4-hydrogen",
  "qwen4-max": "alibaba:qwen/qwen4-max",
  "qwen3.8-max": "alibaba:qwen/qwen3.8-max",
  "qwen3.7-max": "alibaba:qwen/qwen3.7-max",
  "qwen3.7-flash": "alibaba:qwen/qwen3.7-flash",
  "qwen3.6-flash": "alibaba:qwen/qwen3.6-flash",
  "qwen3.6-plus": "alibaba:qwen/qwen3.6-plus",
  "qwen3.5-plus": "alibaba:qwen/qwen3.5-plus",
  "qwen3.5-122b-a10b": "alibaba:qwen/qwen3.5-122b-a10b",
  "qwen3.5-397b-a17b": "alibaba:qwen/qwen3.5-397b-a17b",
  "qwen-flash": "alibaba:qwen/qwen-flash",
  "gemini-3.7-flash": "google:google/gemini-3.7-flash",
  "gpt-4o-mini": "openai:openai/gpt-4o-mini",
  "qwen3.5-flash": "alibaba:qwen/qwen3.5-flash",
  "qwen3.5-27b": "alibaba:qwen/qwen3.5-27b",
  "qwen3.5-35b-a3b": "alibaba:qwen/qwen3.5-35b-a3b",
  "gemini-3.8-flash": "google:google/gemini-3.8-flash",
  "gpt-5.4-nano": "azure:openai/gpt-5.4-nano",
  "qwen3.8-flash": "alibaba:qwen/qwen3.8-flash",
  "glm-5.3-flash": "z-ai:z-ai/glm-5.3-flash",
  "deepseek-v4.1-flash": "alibaba:deepseek/deepseek-v4.1-flash",
  "kimi-k3": "moonshotai:moonshotai/kimi-k3",
  "minimax-m3": "minimax:minimax/minimax-m3",
  "mistral-small-2603": "mistralai:mistralai/mistral-small-2603",
  "gpt-4.1-mini": "openai:openai/gpt-4.1-mini",
  "gemini-3.5-flash-lite": "google:google/gemini-3.5-flash-lite",
  "qwen3.8-27b": "alibaba:qwen/qwen3.8-27b",
  "glm-5.2": "z-ai:z-ai/glm-5.2",
  "gpt-5-mini": "azure:openai/gpt-5-mini",
  "ministral-8b-2512": "mistralai:mistralai/ministral-8b-2512",
  "gemini-3.6-flash": "google:google/gemini-3.6-flash",
  "qwen3.7-plus": "alibaba:qwen/qwen3.7-plus",
  "deepseek-v4-pro": "deepseek:deepseek/deepseek-v4-pro",
  "qwen3-coder-flash": "alibaba:qwen/qwen3-coder-flash",
  "gpt-5.4-mini": "azure:openai/gpt-5.4-mini",
  "ministral-3b-2512": "mistralai:mistralai/ministral-3b-2512",
  "qwen3.6-35b-a3b": "alibaba:qwen/qwen3.6-35b-a3b",
  "kimi-k2.7-code": "moonshotai:moonshotai/kimi-k2.7-code",
  "gemini-2.5-flash-lite": "google:google/gemini-2.5-flash-lite",
  "ministral-14b-2512": "mistralai:mistralai/ministral-14b-2512",
  "gpt-5-nano": "azure:openai/gpt-5-nano",
  "qwen3.6-27b": "alibaba:qwen/qwen3.6-27b",
  "mistral-medium-2604": "mistralai:mistralai/mistral-medium-2604",
  "glm-5-turbo": "z-ai:z-ai/glm-5-turbo"
};
const origin = 'https://api.puter.com';
interface NativeResult {error?:unknown;usageDetails?:{fallbackModel?:unknown};message?:{content?:string|{text?:string}[]};finish_reason?:string;usage?:{prompt_tokens?:number;completion_tokens?:number}}
function usage(raw?: {prompt_tokens?:number; completion_tokens?:number}) {
  const count=(v:unknown)=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : 0;
  const p=count(raw?.prompt_tokens), c=count(raw?.completion_tokens);
  return {prompt_tokens:p,completion_tokens:c,total_tokens:p+c};
}
export class PuterProvider extends BaseProvider {
  readonly platform='puter' as const;
  readonly name='Puter';
  async validateKey(key:string) {
    if(!key.trim())return false;
    const r=await this.fetchWithTimeout(origin+'/metering/usage',{headers:{Authorization:'Bearer '+key},redirect:'error'},15000,{timeoutBounds:'request'});
    if(r.status===401||r.status===403){await r.body?.cancel();return false;}
    if(!r.ok){await r.body?.cancel();throw providerHttpError(r,'Puter metering unavailable');}
    return Number.isFinite((await r.json() as {allowanceInfo?:{monthUsageAllowance?:number}}).allowanceInfo?.monthUsageAllowance);
  }
  private async call(key:string,messages:ChatMessage[],model:string,opts:CompletionOptions={},stream:boolean){
    if(!Object.hasOwn(pinned,model))throw new Error('Unsupported Puter model');
    if(opts.tools?.length || opts.tool_choice)throw new Error('Puter tool calls are not supported');
    const r=await this.fetchWithTimeout(origin+'/drivers/call',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({interface:'puter-chat-completion',driver:'ai-chat',method:'complete',args:{model:pinned[model],messages,stream,normalize:true,refusalFallback:false,
        max_tokens:opts.max_tokens,temperature:opts.temperature,top_p:opts.top_p,stop:opts.stop}})},opts.timeoutMs??90000,{signal:opts.signal,timeoutBounds:'request'});
    if(!r.ok){await r.body?.cancel();throw providerHttpError(r,'Puter native request returned HTTP '+r.status);}
    return r;
  }
  async chatCompletion(key:string,messages:ChatMessage[],model:string,opts?:CompletionOptions):Promise<ChatCompletionResponse>{
    const j=await (await this.call(key,messages,model,opts,false)).json() as NativeResult & {result?:NativeResult},v=j.result??j;
    if(j.error||v.error||v.usageDetails?.fallbackModel)throw new Error('Puter returned an error or substituted completion');
    const raw=v.message?.content;
    const content=Array.isArray(raw)?raw.map(x=>typeof x?.text==='string'?x.text:'').join(''):raw;
    if(typeof content!=='string'||!content.trim())throw new Error('Empty Puter completion');
    return {id:randomUUID(),created:Math.floor(Date.now()/1000),object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content},finish_reason:v.finish_reason??'stop'}],usage:usage(v.usage)};
  }
  async *streamChatCompletion(key:string,messages:ChatMessage[],model:string,opts?:CompletionOptions):AsyncGenerator<ChatCompletionChunk>{
    const r=await this.call(key,messages,model,opts,true);
    if(!r.body)throw new Error('Missing Puter stream');
    const reader=r.body.getReader(),decoder=new TextDecoder(),id=randomUUID(),created=Math.floor(Date.now()/1000);
    let buf='',finished=false,sawText=false;
    try{
      for(;;){
        const {done,value}=await reader.read();buf+=decoder.decode(value,{stream:!done});
        const lines=buf.split('\n');buf=done?'':lines.pop()!;
        if(buf.length>2_000_000)throw new Error('Oversized Puter stream frame');
        for(const raw of lines){
          const line=raw.trim();if(!line)continue;
          const e=JSON.parse(line);
          if(e.error||e.type==='error'||e.type==='refusal_fallback'||e.usageDetails?.fallbackModel)throw new Error('Puter returned an error or substituted stream');
          if(e.type==='text'&&typeof e.text==='string' && e.text){sawText=true;yield {id,created,object:'chat.completion.chunk',model,choices:[{index:0,delta:{content:e.text},finish_reason:null}]};}
          else if(e.type==='reasoning'&&typeof e.text==='string'){yield {id,created,object:'chat.completion.chunk',model,choices:[{index:0,delta:{reasoning_content:e.text},finish_reason:null}]};}
          else if(e.type==='usage'&&sawText&&!finished){finished=true;yield {id,created,object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:e.finish_reason??'stop'}],...(opts?.stream_options?.include_usage?{usage:usage(e.usage)}:{})};}
        }
        if(done)break;
      }
      if(!finished)throw new Error('Incomplete Puter stream');
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}
