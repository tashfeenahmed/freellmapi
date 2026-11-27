import { getDb } from '../db/index.js';
import { reserveProviderCredential } from './provider-credential.js';
import { meterCloudflare, roughTokens } from './cloudflare-neurons.js';
import { proxyFetch } from '../lib/proxy.js';
import { tanodTranslate, tanodStatus } from '../providers/tanod.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const targets: Record<string,Record<string,string>>={
  tanod:{'argos-translate':'translation'},
  ovh:{'Olala-v1.0-translate':'translation','Olala-v1.0-summarise':'summarization'},
  cloudflare:{'@cf/meta/m2m100-1.2b':'translation','@cf/ai4bharat/indictrans2-en-indic-1B':'translation'},
  xkiro:{'cohere/command-a-translate':'translation','cohere/north-small-translate':'translation'}
};
export const specialistTask=(id:string,platform='ovh')=>Object.hasOwn(targets,platform)&&Object.hasOwn(targets[platform],id)?targets[platform][id]:undefined;
export interface SpecialistRow { platform: string; modelId: string; task: string; displayName: string; enabled: boolean; quotaLabel?: string }
export function listSpecialists() {
  return getDb().prepare("SELECT model_id AS id, platform, modality AS task FROM media_models WHERE platform IN ('ovh','cloudflare','xkiro','tanod') AND modality IN ('translation','summarization') AND enabled=1 ORDER BY model_id").all() as {id:string;platform:string;task:string}[];
}
const language = z.string().regex(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/).max(35);
const base = z.object({model:z.string().min(1), input:z.string().trim().min(1).max(32000), stream:z.boolean().optional()}).strict();
const translate = base.extend({source_language:language,target_language:language});
export async function serveSpecialist(task:'translation'|'summarization',req:Request,res:Response):Promise<void> {
  const parsed=(task==='translation'?translate:base).safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:{message:'Provide model, input and, for translation, source_language and target_language.'}});return;}
  const {model,input,stream=false}=parsed.data;
  const row=listSpecialists().find(r=>r.id===model&&r.task===task&&specialistTask(model,r.platform)===task);
  if(!row){res.status(404).json({error:{message:'No enabled specialist matching this model and task.'}});return;}
  const controller=new AbortController(),abort=()=>{if(!res.writableFinished)controller.abort();};res.on('close',abort);
  try {
    if(row.platform!=='ovh'&&'target_language' in parsed.data&&'source_language' in parsed.data){
      // The specialized endpoint returns validated text, not general-purpose chat.
      if(stream){res.status(400).json({error:{message:'Use stream:false for this translation route.'}});return;}
      const {credential,budgetBlocked}=reserveProviderCredential({platform:row.platform,key_id:null,model_id:model},roughTokens(input));
      if(!credential){res.status(budgetBlocked?429:503).json({error:{message:'No usable translation credential.'}});return;}
      try {
        if(row.platform==='tanod'){
          try { const output=await tanodTranslate(input,String(parsed.data.source_language),String(parsed.data.target_language),controller.signal);res.json({model,task,output}); }
          catch(e){res.status(tanodStatus(e)).json({error:{message:'Tanod free translation unavailable or unsupported.'}});}
          return;
        }
        const cf=row.platform==='cloudflare', indic=model.includes('indictrans2');
        const source=String(parsed.data.source_language),target=String(parsed.data.target_language);
        if(indic&&!['en','eng_Latn'].includes(source)){res.status(400).json({error:{message:'This model translates from English only.'}});return;}
        const split=credential.key.indexOf(':');
        if(cf&&split<1)throw Error('Invalid Cloudflare credential');
        const url=cf?'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(credential.key.slice(0,split))+'/ai/run/'+model:'https://api.xkiro.com/v1/chat/completions';
        const payload=cf?(indic?{text:input,target_language:target}:{text:input,source_lang:source,target_lang:target}):{model,stream:false,messages:[{role:'user',content:'Translate from '+source+' to '+target+'. Return only the translation:\\n'+input}]};
        const request=async()=>{
          const r=await proxyFetch(url,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+(cf?credential.key.slice(split+1):credential.key),'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])},row.platform,'chat',90000);
          if(!r.ok){await r.body?.cancel();throw Error('Translation unavailable');}
          return r.json() as Promise<{success?:boolean;result?:{translations?:string[];translated_text?:string};model?:string;choices?:{message?:{content?:string}}[]}>;
        };
        const j=cf?await meterCloudflare(credential.key,model,{inputTokens:roughTokens(input)},request,()=>({inputTokens:roughTokens(input)}),e=>e):await request();
        const output=cf?(j?.success&&(indic?j.result?.translations?.[0]:j.result?.translated_text)):(j?.model===model&&j.choices?.[0]?.message?.content);
        if(typeof output!=='string'||!output.trim())throw Error('Invalid translation');
        res.json({model,task,output});return;
      }finally{credential.release();}
    }
    const upstream=await fetch('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]),
      body:JSON.stringify({model,messages:[...(task==='summarization'?[{role:'system',content:'Summarize the supplied text concisely in its original language. Return only the summary, with no greeting, commentary, or follow-up.'}]:[]),{role:'user',content:input}],stream,...('source_language' in parsed.data&&'target_language' in parsed.data?{source_language:parsed.data.source_language,target_language:parsed.data.target_language}:{})})});
    if(!upstream.ok){await upstream.body?.cancel();res.status(upstream.status===429?429:502).json({error:{message:'OVH specialist returned HTTP '+upstream.status}});return;}
    if(stream){
      if(!upstream.body||!upstream.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Invalid event stream');
      res.type('text/event-stream').set('Cache-Control','no-cache');
      await pipeline(Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>),res);return;
    }
    const data=await upstream.json() as {model?:string;choices?:{message?:{content?:string}}[]};
    if(data.model!==model||typeof data.choices?.[0]?.message?.content!=='string'||!data.choices[0].message.content.trim())throw new Error('Invalid completion');
    res.json({model,task,output:data.choices[0].message.content});
  } catch { if(!res.headersSent&&!res.destroyed)res.status(502).json({error:{message:'Specialist request failed.'}});else if(!res.destroyed)res.destroy();}
  finally {res.off('close',abort);}
}
