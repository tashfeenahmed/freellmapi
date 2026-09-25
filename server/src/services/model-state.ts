import { getPostgresPool } from '../db/postgres.js';

export type CatalogModelKind = 'chat' | 'media';

export interface ModelOverridePatch {
  displayName?: string;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  monthlyTokenBudget?: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
}

type StoredOverrides = Partial<ModelOverridePatch>;

const OVERRIDE_COLUMNS: Record<keyof ModelOverridePatch, string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
  enabled: 'enabled',
};

function parseOverrides(raw: string | undefined): StoredOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoredOverrides) : {};
  } catch {
    return {};
  }
}

export function overriddenFieldNames(overridesJson: string | null | undefined): Array<keyof ModelOverridePatch> {
  const stored = parseOverrides(overridesJson ?? undefined);
  return (Object.keys(stored) as Array<keyof ModelOverridePatch>).filter(key => key in OVERRIDE_COLUMNS);
}

export function isCatalogManagedModel(row: { platform: string; key_id?: number | null; source?: string }): boolean {
  if (row.source === 'user') return false;
  return row.platform !== 'custom' && row.key_id == null;
}

export type CatalogTombstoneSource = 'user' | 'upstream_eol';

export interface CatalogModelTombstone {
  source: CatalogTombstoneSource;
  reason: string | null;
  createdAt: string;
}

export function getCatalogModelTombstone(
  _db: any,
  _kind: CatalogModelKind,
  _platform: string,
  _modelId: string
): CatalogModelTombstone | undefined {
  return undefined;
}

export function isCatalogModelTombstoned(
  _db: any,
  _kind: CatalogModelKind,
  _platform: string,
  _modelId: string
): boolean {
  return false;
}

export function recordCatalogModelTombstone(
  _db: any,
  _kind: CatalogModelKind,
  _platform: string,
  _modelId: string,
  _options: { source?: CatalogTombstoneSource; reason?: string | null } = {}
): void {
  // PostgreSQL handles model enabled state directly on models table
}

export function retireCatalogModelUpstream(
  _db: any,
  modelDbId: number,
  _platform: string,
  _modelId: string,
  _reason: string
): boolean {
  try {
    const pool = getPostgresPool();
    void pool.query('UPDATE models SET enabled = false WHERE id = $1', [modelDbId]);
    return true;
  } catch {
    return false;
  }
}

export function reinstateUpstreamRetiredCatalogModel(
  _db: any,
  _platform: string,
  _modelId: string
): boolean {
  return false;
}

export function clearCatalogModelTombstone(
  _db: any,
  _kind: CatalogModelKind,
  _platform: string,
  _modelId: string
): void {}

export function upsertModelOverrides(
  _db: any,
  _platform: string,
  _modelId: string,
  _patch: ModelOverridePatch
): StoredOverrides {
  return {};
}

export function getModelOverrides(
  _db: any,
  _platform: string,
  _modelId: string
): StoredOverrides {
  return {};
}

export function modelsWithOverriddenField(
  _db: any,
  _field: keyof ModelOverridePatch
): Set<string> {
  return new Set();
}

export function applyModelOverrides(
  _db: any,
  _platform: string,
  _modelId: string
): boolean {
  return false;
}

export function applyAllModelOverrides(_db: any): number {
  return 0;
}

export function deleteTombstonedCatalogModels(_db: any): number {
  return 0;
}
