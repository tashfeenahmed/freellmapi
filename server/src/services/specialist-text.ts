import { getDb } from '../db/index.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const targets = new Map([['Olala-v1.0-translate', 'translation'], ['Olala-v1.0-summarise', 'summarization']]);
export const specialistTask = (id: string) => targets.get(id);
export interface SpecialistRow { platform: string; modelId: string; task: string; displayName: string; enabled: boolean; quotaLabel?: string }
export function listSpecialists() {
  return getDb().prepare("SELECT model_id AS id, platform, modality AS task FROM media_models WHERE platform='ovh' AND modality IN ('translation','summarization') AND enabled=1 ORDER BY model_id").all() as {id:string;platform:string;task:string}[];
}
const language = z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).max(35);
const base = z.object({model:z.string().min(1), input:z.string().trim().min(1).max(32000), stream:z.boolean().optional()}).strict();
const translate = base.extend({source_language:language,target_language:language});
export async function serveSpecialist(task:'translation'|'summarization',req:Request,res:Response):Promise<void> {
  const parsed=(task==='translation'?translate:base).safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:{message:'Provide model, input and, for translation, source_language and target_language.'}});return;}
  const {model,input,stream=false}=parsed.data;
  if(specialistTask(model)!==task||!listSpecialists().some(r=>r.id===model&&r.task===task)){res.status(404).json({error:{message:'No enabled specialist matching this model and task.'}});return;}
  const controller=new AbortController(),abort=()=>{if(!res.writableFinished)controller.abort();};res.on('close',abort);
  try {
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
  } catch { if(!res.headersSent&&!res.destroyed)res.status(502).json({error:{message:'OVH specialist request failed.'}});else if(!res.destroyed)res.destroy();}
  finally {res.off('close',abort);}
}
