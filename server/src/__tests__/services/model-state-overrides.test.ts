import { beforeEach, it, expect } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { upsertModelOverrides, applyModelOverrides, getModelOverrides } from '../../services/model-state.js';

const model = {
  platform: 'groq', modelId: 'override-test', displayName: 'Catalog name', intelligenceRank: 1,
  speedRank: 1, sizeLabel: 'Small', limits: {rpm:30,rpd:null,tpm:null,tpd:null},
  monthlyTokenBudget: '', contextWindow: 8000, enabled:true, supportsVision:false, supportsTools:true,
};
const catalog = (displayName = model.displayName) => ({version:'2099.01.01',generatedAt:new Date().toISOString(),tier:'live' as const,models:[{...model,displayName}],quirks:[]});
const row = () => getDb().prepare("SELECT * FROM models WHERE model_id = 'override-test'").get() as Record<string,unknown>;
const stored = () => getDb().prepare("SELECT * FROM model_overrides WHERE model_id = 'override-test'").get();
function legacyOverride() {
  getDb().prepare("INSERT INTO model_overrides(platform,model_id,overrides_json) VALUES ('groq','override-test',?)").run(JSON.stringify({displayName:'Legacy custom name'}));
  applyModelOverrides(getDb(),'groq','override-test');
}
beforeEach(() => {process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); applyCatalog(getDb(),catalog());});

it('clears a legacy override using the cached catalog instead of the effective row', () => {
  setSetting('catalog_applied_json',JSON.stringify(catalog())); legacyOverride();
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName},{baselineRow:row()});
  expect(stored()).toBeUndefined();
});
it('does not erase an unknown legacy override merely because it matches the effective row', () => {
  legacyOverride();
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Legacy custom name'},{baselineRow:row()});
  expect(getModelOverrides(getDb(),'groq','override-test').displayName).toBe('Legacy custom name');
  // The next catalog refresh recovers the authoritative baseline offline too.
  applyCatalog(getDb(),catalog());
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName},{baselineRow:row()});
  expect(stored()).toBeUndefined();
});
it('refreshes the undo baseline when a newer catalog changes the default', () => {
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name'},{baselineRow:row()});
  applyModelOverrides(getDb(),'groq','override-test');
  applyCatalog(getDb(),catalog('New catalog name'));
  expect(row().display_name).toBe('Local name');
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:'New catalog name'},{baselineRow:row()});
  expect(stored()).toBeUndefined();
});
it('preserves explicit declarative pins even when they match a known baseline', () => {
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name'},{baselineRow:row()});
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName});
  applyCatalog(getDb(),catalog('Next default'));
  expect(row().display_name).toBe(model.displayName);
});
it('drops restored boolean and null fields while keeping unrelated edits', () => {
  const baselineRow = row();
  upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name',supportsVision:true,rpdLimit:50},{baselineRow});
  applyModelOverrides(getDb(),'groq','override-test');
  upsertModelOverrides(getDb(),'groq','override-test',{supportsVision:false,rpdLimit:null},{baselineRow:row()});
  const overrides = getModelOverrides(getDb(),'groq','override-test');
  expect(overrides.displayName).toBe('Local name');
  expect(overrides.supportsVision).toBeUndefined();
  expect(overrides.rpdLimit).toBeUndefined();
});
