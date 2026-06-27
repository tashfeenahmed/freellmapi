import type Database from 'better-sqlite3';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';
import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';

export interface MigrationModule {
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
export const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
];
