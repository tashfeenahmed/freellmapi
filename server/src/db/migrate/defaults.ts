import pg from 'pg';
import * as initialSchema from '../migrations/001_initial_schema.js';
import * as seedProvidersModels from '../migrations/002_seed_providers_models.js';
import * as addHealthColumns from '../migrations/003_add_health_columns_to_credentials.js';
import * as fixSettingsUpdatedAt from '../migrations/004_fix_settings_updated_at.js';
import * as addMissingModelColumns from '../migrations/005_add_missing_model_columns.js';
import * as compatTables from '../migrations/006_compat_tables.js';

export interface MigrationModule {
  up(client: pg.PoolClient | pg.Pool): Promise<void> | void;
  down(client: pg.PoolClient | pg.Pool): Promise<void> | void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const INITIAL_SCHEMA_FILENAME = '001_initial_schema.ts';
export const SEED_PROVIDERS_MODELS_FILENAME = '002_seed_providers_models.ts';
export const ADD_HEALTH_COLUMNS_FILENAME = '003_add_health_columns_to_credentials.ts';
export const FIX_SETTINGS_UPDATED_AT_FILENAME = '004_fix_settings_updated_at.ts';
export const ADD_MISSING_MODEL_COLUMNS_FILENAME = '005_add_missing_model_columns.ts';
export const COMPAT_TABLES_FILENAME = '006_compat_tables.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: INITIAL_SCHEMA_FILENAME, module: initialSchema },
  { filename: SEED_PROVIDERS_MODELS_FILENAME, module: seedProvidersModels },
  { filename: ADD_HEALTH_COLUMNS_FILENAME, module: addHealthColumns },
  { filename: FIX_SETTINGS_UPDATED_AT_FILENAME, module: fixSettingsUpdatedAt },
  { filename: ADD_MISSING_MODEL_COLUMNS_FILENAME, module: addMissingModelColumns },
  { filename: COMPAT_TABLES_FILENAME, module: compatTables },
];
