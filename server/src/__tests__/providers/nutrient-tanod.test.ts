import { afterEach, describe, expect, it, vi } from 'vitest';
import { NutrientProvider } from '../../providers/nutrient.js';
import { tanodEmbed, tanodLabels, tanodTranslate } from '../../providers/tanod.js';
import { keylessPlatformsInCatalog } from '../../services/keyless-defaults.js';

describe('Nutrient and Tanod catalog support', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('rejects paid and non-chat Nutrient aliases before sending a request', async () => {
    const fetch=vi.fn(); vi.stubGlobal('fetch',fetch);
    const provider=new NutrientProvider();
    for(const id of ['nutrient-l','nutrient-embedding','nutrient-systemone']){
      await expect(provider.chatCompletion('dummy',[],id)).rejects.toMatchObject({status:400});
      await expect(provider.streamChatCompletion('dummy',[],id).next()).rejects.toMatchObject({status:400});
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('pins the Nutrient endpoint and rejects substituted chat completions', async () => {
    const fetch=vi.fn(async()=>Response.json({model:'nutrient-m',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'wrong route'}}]}));
    vi.stubGlobal('fetch',fetch);
    await expect(new NutrientProvider().chatCompletion('dummy',[],'nutrient-s',{max_tokens:16})).rejects.toThrow(/unexpected model/);
    expect(fetch).toHaveBeenCalledWith('https://api.nutrient.io/ai/v1/chat/completions',expect.objectContaining({redirect:'error',body:expect.stringContaining('"max_completion_tokens":16')}));
  });
  it('treats a payment challenge as exhausted quota; sends no key, signature or second request', async () => {
    const fetch=vi.fn(async()=>new Response('Payment required',{status:402}));vi.stubGlobal('fetch',fetch);
    await expect(tanodEmbed('small-en',['hello'],384)).rejects.toMatchObject({status:429});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://tanod.dev/v1/embed',expect.objectContaining({redirect:'error',headers:{'Content-Type':'application/json','X-Tanod-Free':'1'}}));
  });
  it('rejects incompatible vectors, translations and duplicate labels',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({model:{source:'wrong'},data:[],engine:'other',text:'hello'})));
    await expect(tanodEmbed('multilingual',['a'],384)).rejects.toThrow(/Unexpected/);
    await expect(tanodTranslate('chat','fr','en')).rejects.toThrow(/Invalid/);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({model:{source:'cross-encoder/nli-deberta-v3-xsmall'},labels:[{label:'red',score:1},{label:'red',score:0}]})));
    await expect(tanodLabels('flag',['red','blue'],'')).rejects.toThrow(/Malformed/);
  });
  it('only suggests keyless setup when the applied feed exposes Tanod',()=>{
    expect(keylessPlatformsInCatalog({})).not.toContain('tanod');
    expect(keylessPlatformsInCatalog({specialistTextModels:[{platform:'tanod',enabled:false}]})).not.toContain('tanod');
    expect(keylessPlatformsInCatalog({specialistTextModels:[{platform:'tanod',enabled:true}]})).toContain('tanod');
  });
});
