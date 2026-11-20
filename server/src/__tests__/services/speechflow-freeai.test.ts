import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runTranscription, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { runEmbeddings, EMBEDDING_PLATFORMS } from '../../services/embeddings.js';
import { resolveProvider } from '../../providers/index.js';
import { speechFlowCredentials } from '../../providers/speechflow.js';

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
function key(platform: string, value: string) {
  const e = encrypt(value);
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'fixture',?,?,?,'unknown',1)").run(platform,e.encrypted,e.iv,e.authTag);
}
const model = 'speechflow-asr';
const clip = { file: Buffer.from('audio'), filename: 'sample.wav', responseFormat: 'json' };
function speech(value = 'exampleId:exampleSecret') {
  key('speechflow', value);
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('speechflow',?,?,'transcription',1,1)").run(model,model);
}
it('uses the transcription registry, uploads once, and reads the finished plain transcript', async () => {
  speech(); expect(TRANSCRIPTION_PLATFORMS.has('speechflow')).toBe(true);
  expect(resolveProvider('speechflow')).toMatchObject({ supportsChat: false, supportsKeyValidation: false });
  const f = vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({code:10000,taskId:'abc-1'}))
    .mockResolvedValueOnce(Response.json({code:11001})).mockResolvedValueOnce(Response.json({code:11000,result:'Bonjour'}));
  expect(await runTranscription(model,{...clip,language:'fr'})).toMatchObject({ text:'Bonjour',language:'fr',platform:'speechflow' });
  expect(f.mock.calls.map(c=>c[0])).toEqual(['https://api.speechflow.io/asr/file/v1/create?lang=fr', ...Array(2).fill('https://api.speechflow.io/asr/file/v1/query?taskId=abc-1&resultType=4')]);
  for(const [,init] of f.mock.calls) {
    expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('keySecret')).toBe('exampleSecret'); expect(new Headers(init?.headers).get('keyId')).toBe('exampleId');
  }
  expect((f.mock.calls[0][1]?.body as FormData).get('file')).toBeTruthy();
});
it('rejects malformed credentials before sending the audio',async()=>{
  for(const v of ['a', ':a', 'a:b:c', 'a:b\r\nx:y']) expect(speechFlowCredentials(v)).toBeNull();
  speech('broken'); const f=vi.spyOn(global,'fetch'); await expect(runTranscription(model,clip)).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
});
it.each([{code:999,result:'not success'},{code:11000,result:42}])('does not treat an unfinished or malformed result as success', async state=>{
  speech(); vi.spyOn(global,'fetch').mockResolvedValueOnce(Response.json({code:10000,taskId:'abc'})).mockResolvedValueOnce(Response.json(state));
  await expect(runTranscription(model,clip)).rejects.toThrow();
});
function embedRow(id:string,dimensions:number) {
  key('freeai','synthetic'); getDb().prepare("INSERT INTO embedding_models (platform,model_id,display_name,family,dimensions,priority,enabled,quota_label) VALUES ('freeai',?,?,'fixture',?,1,1,'daily')").run(id,id,dimensions);
}
it.each([['bge-m3',1024],['embeddinggemma-2',768]] as const)('preserves native Free.ai batch order for %s',async(id,dim)=>{
  embedRow(id,dim); expect(EMBEDDING_PLATFORMS.has('freeai')).toBe(true);
  const f=vi.spyOn(global,'fetch').mockResolvedValue(Response.json({model:id,count:2,dimensions:dim,tokens_used:5,embeddings:[Array(dim).fill(.2),Array(dim).fill(.1)]}));
  const out=await runEmbeddings('fixture',['a','b']); expect(out.vectors.map(v=>v[0])).toEqual([.2,.1]); expect(out.inputTokens).toBe(5);
  expect(f.mock.calls[0][0]).toBe('https://api.free.ai/v1/embeddings/'); expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({model:id,input:['a','b']});
});
it.each([{model:'other'},{count:2},{dimensions:768},{embeddings:[[.2]]},{embeddings:[Array(1024).fill(0)]}])('rejects invalid Free.ai output',async override=>{
  embedRow('bge-m3',1024); vi.spyOn(global,'fetch').mockResolvedValue(Response.json({model:'bge-m3',count:1,dimensions:1024,embeddings:[Array(1024).fill(.1)],...override}));
  await expect(runEmbeddings('fixture',['a'])).rejects.toThrow();
});
