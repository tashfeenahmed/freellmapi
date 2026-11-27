import {afterEach,describe,expect,it,vi} from 'vitest';
import {PuterProvider} from '../../providers/puter.js';
import {autoRegistrable} from '../../services/builtin-model-discovery.js';
import {specialistTask} from '../../services/specialist-text.js';
import {isClairic} from '../../services/decision.js';

const model='gemini-3.8-flash', messages=[{role:'user' as const,content:'Hi'}];
describe('native Puter wire protocol',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it.each([
    ['qwen-max', 'alibaba:qwen/qwen-max'],
    ['qwen3-omni-flash', 'alibaba:qwen/qwen3-omni-flash'],
    ['qwen3.5-omni-plus', 'alibaba:qwen/qwen3.5-omni-plus'],
    ['qwen-plus-2025-12-01', 'alibaba:qwen/qwen-plus-2025-12-01'],
    ['glm-5.2-fast-preview', 'alibaba:zhipu/glm-5.2-fast-preview'],
    ['glm-4.6', 'z-ai:z-ai/glm-4.6'],
    ['glm-4.7', 'z-ai:z-ai/glm-4.7'],
    ['glm-5', 'z-ai:z-ai/glm-5'],
    ['glm-5.1', 'z-ai:z-ai/glm-5.1'],
    ['glm-5.3', 'z-ai:z-ai/glm-5.3'],
    ['gemini-2.5-flash', 'google:google/gemini-2.5-flash'],
    ['gemini-3-flash-preview', 'google:google/gemini-3-flash-preview'],
    ['mistral-large-4', 'mistralai:mistralai/mistral-large-4'],
    ['mistral-large-2512', 'mistralai:mistralai/mistral-large-2512'],
    ['codestral-2508', 'mistralai:mistralai/codestral-2508'],
    ['qwen-plus-2025-01-25', 'alibaba:qwen/qwen-plus-2025-01-25'],
    ['qwen-plus-2025-04-28', 'alibaba:qwen/qwen-plus-2025-04-28'],
    ['qwen3.5-plus-2026-02-15', 'alibaba:qwen/qwen3.5-plus-2026-02-15'],
    ['qwen3.5-plus-2026-04-20', 'alibaba:qwen/qwen3.5-plus-2026-04-20'],
    ['gpt-6-luna', 'openai:openai/gpt-6-luna'],
    ['gpt-4.1', 'openai:openai/gpt-4.1'],
    ['gemini-4-neon', 'google:google/gemini-4-neon'],
    ['gpt-4o-2024-11-20', 'openai:openai/gpt-4o-2024-11-20'],
    ['qwen3-vl-plus', 'alibaba:qwen/qwen3-vl-plus'],
    ['glm-5.3-flashx', 'z-ai:z-ai/glm-5.3-flashx'],
    ['qwen-plus', 'alibaba:qwen/qwen-plus'],
    ['gemini-3.1-flash-lite', 'google:google/gemini-3.1-flash-lite'],
    ['deepseek-v4-pro-0813', 'alibaba:deepseek/deepseek-v4-pro-0813'],
    ['minimax-m3.1-flash', 'minimax:minimax/minimax-m3.1-flash'],
    ['qwen3.5-omni-flash', 'alibaba:qwen/qwen3.5-omni-flash'],
    ['gemini-3.5-flash', 'google:google/gemini-3.5-flash'],
    ['deepseek-v4-flash-0731', 'alibaba:deepseek/deepseek-v4-flash-0731'],
    ['qwen3.8-omni-flash', 'alibaba:qwen/qwen3.8-omni-flash'],
    ['kimi-k2.6', 'moonshotai:moonshotai/kimi-k2.6'],
    ['gemini-4-hydrogen', 'google:google/gemini-4-hydrogen'],
    ['qwen4-max', 'alibaba:qwen/qwen4-max'],
    ['qwen3.8-max', 'alibaba:qwen/qwen3.8-max'],
    ['qwen3.7-max', 'alibaba:qwen/qwen3.7-max'],
    ['qwen3.7-flash', 'alibaba:qwen/qwen3.7-flash'],
    ['qwen3.6-flash', 'alibaba:qwen/qwen3.6-flash'],
    ['qwen3.6-plus', 'alibaba:qwen/qwen3.6-plus'],
    ['qwen3.5-plus', 'alibaba:qwen/qwen3.5-plus'],
    ['qwen3.5-122b-a10b', 'alibaba:qwen/qwen3.5-122b-a10b'],
    ['qwen3.5-397b-a17b', 'alibaba:qwen/qwen3.5-397b-a17b'],
    ['qwen-flash', 'alibaba:qwen/qwen-flash'],
    ['gemini-3.7-flash', 'google:google/gemini-3.7-flash'],
    ['gpt-4o-mini', 'openai:openai/gpt-4o-mini'],
    ['qwen3.5-flash', 'alibaba:qwen/qwen3.5-flash'],
    ['qwen3.5-27b', 'alibaba:qwen/qwen3.5-27b'],
    ['qwen3.5-35b-a3b', 'alibaba:qwen/qwen3.5-35b-a3b'],
  ])('pins %s for both ordinary and streamed chat',async(id,nativeId)=>{
    const f=vi.fn()
      .mockResolvedValueOnce(Response.json({result:{message:{content:'Hi'}}}))
      .mockResolvedValueOnce(new Response('{"type":"text","text":"Hi"}\n{"type":"usage","finish_reason":"stop"}\n'));
    vi.stubGlobal('fetch',f);
    const p=new PuterProvider();
    expect((await p.chatCompletion('test',messages,id)).model).toBe(id);
    const chunks=[];for await(const chunk of p.streamChatCompletion('test',messages,id)) chunks.push(chunk);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop');
    expect(f.mock.calls.map(([,init])=>JSON.parse(init.body).args)).toEqual([
      expect.objectContaining({model:nativeId,stream:false,refusalFallback:false}),
      expect.objectContaining({model:nativeId,stream:true,refusalFallback:false}),
    ]);
  });
  it('pins issuer, native ID and refusal behavior; preserves returned usage',async()=>{
    const f=vi.fn().mockResolvedValue(Response.json({result:{message:{content:[{text:'Hi'}]},usage:{prompt_tokens:2,completion_tokens:1}}}));
    vi.stubGlobal('fetch',f);
    const r=await new PuterProvider().chatCompletion('unit-test',messages,model);
    expect(r.choices[0].message.content).toBe('Hi');expect(r.usage.total_tokens).toBe(3);
    expect(f.mock.calls[0][0]).toBe('https://api.puter.com/drivers/call');
    expect(JSON.parse(f.mock.calls[0][1].body).args).toMatchObject({model:'google:google/gemini-3.8-flash',refusalFallback:false,stream:false});
  });
  it('does not accept substituted or unknown models',async()=>{
    const f=vi.fn().mockResolvedValue(Response.json({result:{usageDetails:{fallbackModel:'other'},message:{content:'valid-looking'}}}));
    vi.stubGlobal('fetch',f);const p=new PuterProvider();
    await expect(p.chatCompletion('test',messages,model)).rejects.toThrow('substituted');
    await expect(p.chatCompletion('test',messages,'constructor')).rejects.toThrow('Unsupported');expect(f).toHaveBeenCalledTimes(1);
  });
  it('decodes split native NDJSON and rejects a truncated or fallback stream',async()=>{
    const p=new PuterProvider();
    for(const [suffix,valid] of [['{"type":"usage","finish_reason":"stop"}',true],['',false],['{"type":"refusal_fallback"}',false]] as const){
      const data=['{"type":"te','xt","text":"Hi"}\n',suffix];
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){data.forEach(x=>c.enqueue(new TextEncoder().encode(x)));c.close();}}))));
      const read=async()=>{const out=[];for await(const c of p.streamChatCompletion('test',messages,model))out.push(c);return out;};
      if(valid)expect((await read()).at(-1)?.choices[0].finish_reason).toBe('stop');else await expect(read()).rejects.toThrow();
    }
  });
  it('rejects an oversized frame even when its newline arrives in the same chunk',async()=>{
    const frame=JSON.stringify({type:'text',text:'x'.repeat(2_000_001)})+'\n';
    const stream=frame+'{"type":"usage","finish_reason":"stop"}\n';
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(stream)));
    const read=async()=>{const chunks=[];for await(const chunk of new PuterProvider().streamChatCompletion('test',messages,model))chunks.push(chunk);return chunks;};
    await expect(read()).rejects.toThrow('Oversized Puter stream frame');
  });
  it('keeps translation and extraction routes out of chat and routing policy',()=>{
    for(const [platform,id] of [['xkiro','cohere/command-a-translate'],['cloudflare','@cf/meta/m2m100-1.2b']] as const){
      expect(specialistTask(id,platform)).toBe('translation');expect(specialistTask(id,'ovh')).toBeUndefined();
      expect(autoRegistrable([{id,ownedBy:null}],platform).accepted).toHaveLength(0);
    }
    expect(isClairic('@cf/cloudflare/clairic-flash')).toBe(true);expect(isClairic('other')).toBe(false);
  });
});
