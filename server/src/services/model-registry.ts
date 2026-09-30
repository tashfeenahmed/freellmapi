// ── Model registry: one entry point for the `models` table ──────────────────
//
// New here? Start with this file, not the ten modules behind it. Model rows
// live in ONE table but are touched from five directions; this barrel gathers
// the public surface so callers import from a single documented place:
//
//   register  — add models against a custom endpoint (custom-model-register.ts)
//   sync      — scheduled "add only" pass over custom endpoints
//               (custom-model-sync.ts)
//   seed      — starting routing ranks for models with no catalog metadata
//               (custom-model-seed.ts)
//   tombstone — "keep it deleted" markers, custom and catalog flavors
//               (custom-model-tombstone.ts, model-state.ts)
//   override  — operator field edits layered over catalog rows (model-state.ts)
//
// Which registration entry point? `registerCustomModels` resolves (or creates)
// the endpoint key itself and owns the transaction — the default for routes.
// `registerCustomChatModels` is ONLY for callers that already resolved the key
// and own a wider transaction (the bulk key importer, #382). Picking the wrong
// one double-resolves the key or nests transactions.
//
// Which tombstone? Custom rows are keyed by (endpoint_scope, model_id);
// catalog rows by (kind, platform, model_id) with a 'user' | 'upstream_eol'
// source. They are different tables with different contracts — do not mix
// them. See GLOSSARY.md ("Tombstone / override / retirement").
//
// This file re-exports only; all behavior lives in the modules above. Adding a
// new model-table operation? Export it here and document which group it joins.

// ── register ──
export type {
  CustomModelEntry,
  RegisteredCustomModel,
  RegisterCustomModelsResult,
} from './custom-model-register.js';
export {
  registerCustomModels,
  registerCustomChatModels,
} from './custom-model-register.js';

// ── sync ──
export type { CustomModelSyncResult } from './custom-model-sync.js';
export {
  customModelSyncIntervalMs,
  customModelSyncFreePatterns,
  runCustomModelSync,
  startCustomModelSync,
} from './custom-model-sync.js';

// ── seed ──
export type { CustomModelSeed } from './custom-model-seed.js';
export { FALLBACK_CUSTOM_SEED, customModelSeed } from './custom-model-seed.js';

// ── tombstone ──
export {
  recordCustomModelTombstone,
  isCustomModelTombstoned,
  clearCustomModelTombstone,
} from './custom-model-tombstone.js';

// ── override + catalog tombstone (model-state.ts) ──
export type {
  CatalogModelKind,
  ModelOverridePatch,
  CatalogTombstoneSource,
  CatalogModelTombstone,
  DeleteChatModelResult,
} from './model-state.js';
export {
  overriddenFieldNames,
  isCatalogManagedModel,
  getCatalogModelTombstone,
  isCatalogModelTombstoned,
  recordCatalogModelTombstone,
  retireCatalogModelUpstream,
  reinstateUpstreamRetiredCatalogModel,
  clearCatalogModelTombstone,
  upsertModelOverrides,
  getModelOverrides,
  modelsWithOverriddenField,
  applyModelOverrides,
  applyAllModelOverrides,
  deleteTombstonedCatalogModels,
  routableContextWindow,
  refreshModelOverrideBaselines,
  deleteChatModel,
} from './model-state.js';
