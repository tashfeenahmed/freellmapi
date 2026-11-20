import { describe,it,expect,vi,afterEach } from 'vitest';
import {createApp} from '../../app.js';
import {initDb,getDb,getUnifiedApiKey} from '../../db/index.js';
import {applyCatalog} from '../../services/catalog-sync.js';
import {autoRegistrable} from '../../services/builtin-model-discovery.js';
import {listSpecialists} from '../../services/specialist-text.js';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

describe('explicit OVH text specialists',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('isolates tasks from chat and discovery, forwards language fields and revokes access on downgrade',async()=>{
    process.env.ENCRYPTION_KEY='0'.repeat(64);initDb(':memory:');
    const ids=['Olala-v1.0-translate','Olala-v1.0-summarise'], tasks=['translation','summarization'];
    const cat={version:'2099.01.01',generatedAt:new Date().toISOString(),tier:'live' as const,models:[],quirks:[]};
    const specialists=ids.map((modelId,i)=>({platform:'ovh',modelId,displayName:modelId,enabled:true,task:tasks[i]}));
    applyCatalog(getDb(),{...cat,specialistTextModels:specialists});
    expect(listSpecialists()).toHaveLength(2);
    expect(getDb().prepare("SELECT id FROM models WHERE platform='ovh' AND model_id IN (?,?)").all(...ids)).toHaveLength(0);
    expect(autoRegistrable(ids.map(id=>({id,ownedBy:null})),'ovh').accepted).toEqual([]);
    const app=createApp().listen(0,'127.0.0.1');await once(app,'listening');
    const root='http://127.0.0.1:'+(app.address() as AddressInfo).port+'/v1/text/',real=globalThis.fetch;
    const http=(p:string,data?:unknown,key=getUnifiedApiKey())=>real(root+p,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const upstream=vi.fn(async(_url:unknown,req:RequestInit)=>{
      const b=JSON.parse(String(req.body));
      return b.stream?new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json({model:b.model,choices:[{message:{content:'La lune.'}}]});
    });vi.stubGlobal('fetch',upstream);
    try{
      expect((await http('models',undefined,'wrong')).status).toBe(401);
      expect((await (await http('models')).json()).data).toHaveLength(2);
      const data={model:ids[0],input:'The moon.',source_language:'en',target_language:'fr'};
      expect((await http('translate',{model:ids[0],input:'Hi'})).status).toBe(400);
      expect((await http('summarize',{model:ids[0],input:'Hi'})).status).toBe(404);
      expect((await http('summarize',{model:ids[1],input:'Hi',target_language:'fr'})).status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      expect((await (await http('translate',data)).json()).output).toBe('La lune.');
      const [url,req]=upstream.mock.calls[0];expect(url).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions');
      expect(JSON.parse(String(req.body))).toMatchObject({model:ids[0],source_language:'en',target_language:'fr'});
      expect(req.headers).not.toHaveProperty('Authorization');
      expect(await (await http('summarize',{model:ids[1],input:'Hi',stream:true})).text()).toContain('[DONE]');
      expect(JSON.parse(String(upstream.mock.calls[1][1].body)).messages).toEqual([
        {role:'system',content:expect.stringMatching(/Summarize the supplied text/)},{role:'user',content:'Hi'}
      ]);
      expect(JSON.parse(String(req.body)).messages).toEqual([{role:'user',content:'The moon.'}]);
      getDb().prepare('UPDATE media_models SET enabled=0 WHERE model_id=?').run(ids[0]);
      applyCatalog(getDb(),{...cat,specialistTextModels:specialists});
      expect((await http('translate',data)).status).toBe(404);
      applyCatalog(getDb(),{...cat,tier:'monthly'});expect(listSpecialists()).toHaveLength(0);
    }finally{app.close();getDb().close();}
  });
});
