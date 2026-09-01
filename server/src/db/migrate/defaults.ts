import type { Db } from '../types.js';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';
import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';
import * as catalogModelState from '../migrations/20260627_000002_catalog_model_state.js';
import * as requestAggregates from '../migrations/20260628_120000_request_aggregates.js';
import * as githubGpt41Context from '../migrations/20260630_000001_github_gpt41_context.js';
import * as requestClientInfo from '../migrations/20260706_000001_request_client_info.js';
import * as customModelToolSupport from '../migrations/20260706_000002_custom_model_tool_support.js';
import * as profileChainBackfill from '../migrations/20260714_000001_profile_chain_backfill.js';
import * as keyHealthError from '../migrations/20260720_000001_key_health_error.js';
import * as cooldownProbeProvenance from '../migrations/20260726_000001_cooldown_probe_provenance.js';
import * as requestAttempts from '../migrations/20260726_000002_request_attempts.js';
import * as modelSourceProvenance from '../migrations/20260726_000003_model_source_provenance.js';
import * as mediaModelMeta from '../migrations/20260726_000004_media_model_meta.js';
import * as requestServedModel from '../migrations/20260726_000005_request_served_model.js';
import * as attemptErrorSummary from '../migrations/20260726_000006_attempt_error_summary.js';
import * as agentCompatibility from '../migrations/20260727_000001_agent_compatibility.js';
import * as tombstoneProvenance from '../migrations/20260728_000001_tombstone_provenance.js';
import * as customModelEndpointIdentity from '../migrations/20260729_000001_custom_model_endpoint_identity.js';
import * as customEndpointHostLabels from '../migrations/20260802_000001_custom_endpoint_host_labels.js';
import * as keyModelScope from '../migrations/20260805_000001_key_model_scope.js';
import * as clientProfiles from '../migrations/20260805_000002_client_profiles.js';
import * as apiKeyProxy from '../migrations/20260810_000001_api_key_proxy.js';
import * as playgroundConversations from '../migrations/20260820_000001_playground_conversations.js';
import * as customModelTombstones from '../migrations/20260819_000001_custom_model_tombstones.js';
import * as serverLogs from '../migrations/20260823_000001_server_logs.js';
import * as backupsTable from '../migrations/20260823_000002_backups_table.js';
import * as attemptKeyLabel from '../migrations/20260823_000003_attempt_key_label.js';
import * as profileAutoInclude from '../migrations/20260823_000004_profile_auto_include.js';
import * as idempotencyClaims from '../migrations/20260901_000001_idempotency_claims.js';

export interface MigrationModule {
  up(db: Db): void;
  down(db: Db): void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
export const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
export const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
export const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
export const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
export const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
export const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
export const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
export const KEY_HEALTH_ERROR_FILENAME = '20260720_000001_key_health_error.ts';
export const COOLDOWN_PROBE_PROVENANCE_FILENAME = '20260726_000001_cooldown_probe_provenance.ts';
export const REQUEST_ATTEMPTS_FILENAME = '20260726_000002_request_attempts.ts';
export const MODEL_SOURCE_PROVENANCE_FILENAME = '20260726_000003_model_source_provenance.ts';
export const MEDIA_MODEL_META_FILENAME = '20260726_000004_media_model_meta.ts';
export const REQUEST_SERVED_MODEL_FILENAME = '20260726_000005_request_served_model.ts';
export const ATTEMPT_ERROR_SUMMARY_FILENAME = '20260726_000006_attempt_error_summary.ts';
export const AGENT_COMPATIBILITY_FILENAME = '20260727_000001_agent_compatibility.ts';
export const TOMBSTONE_PROVENANCE_FILENAME = '20260728_000001_tombstone_provenance.ts';
export const CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME = '20260729_000001_custom_model_endpoint_identity.ts';
export const CUSTOM_ENDPOINT_HOST_LABELS_FILENAME = '20260802_000001_custom_endpoint_host_labels.ts';
export const KEY_MODEL_SCOPE_FILENAME = '20260805_000001_key_model_scope.ts';
export const CLIENT_PROFILES_FILENAME = '20260805_000002_client_profiles.ts';
export const API_KEY_PROXY_FILENAME = '20260810_000001_api_key_proxy.ts';
export const PLAYGROUND_CONVERSATIONS_FILENAME = '20260820_000001_playground_conversations.ts';
export const CUSTOM_MODEL_TOMBSTONES_FILENAME = '20260819_000001_custom_model_tombstones.ts';
export const SERVER_LOGS_FILENAME = '20260823_000001_server_logs.ts';
export const BACKUPS_TABLE_FILENAME = '20260823_000002_backups_table.ts';
export const ATTEMPT_KEY_LABEL_FILENAME = '20260823_000003_attempt_key_label.ts';
export const PROFILE_AUTO_INCLUDE_FILENAME = '20260823_000004_profile_auto_include.ts';
export const IDEMPOTENCY_CLAIMS_FILENAME = '20260901_000001_idempotency_claims.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
  { filename: CATALOG_MODEL_STATE_FILENAME, module: catalogModelState },
  { filename: REQUEST_AGGREGATES_FILENAME, module: requestAggregates },
  { filename: GITHUB_GPT41_CONTEXT_FILENAME, module: githubGpt41Context },
  { filename: REQUEST_CLIENT_INFO_FILENAME, module: requestClientInfo },
  { filename: CUSTOM_MODEL_TOOL_SUPPORT_FILENAME, module: customModelToolSupport },
  { filename: PROFILE_CHAIN_BACKFILL_FILENAME, module: profileChainBackfill },
  { filename: KEY_HEALTH_ERROR_FILENAME, module: keyHealthError },
  { filename: COOLDOWN_PROBE_PROVENANCE_FILENAME, module: cooldownProbeProvenance },
  { filename: REQUEST_ATTEMPTS_FILENAME, module: requestAttempts },
  { filename: MODEL_SOURCE_PROVENANCE_FILENAME, module: modelSourceProvenance },
  { filename: MEDIA_MODEL_META_FILENAME, module: mediaModelMeta },
  { filename: REQUEST_SERVED_MODEL_FILENAME, module: requestServedModel },
  { filename: ATTEMPT_ERROR_SUMMARY_FILENAME, module: attemptErrorSummary },
  { filename: AGENT_COMPATIBILITY_FILENAME, module: agentCompatibility },
  { filename: TOMBSTONE_PROVENANCE_FILENAME, module: tombstoneProvenance },
  { filename: CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME, module: customModelEndpointIdentity },
  { filename: CUSTOM_ENDPOINT_HOST_LABELS_FILENAME, module: customEndpointHostLabels },
  { filename: KEY_MODEL_SCOPE_FILENAME, module: keyModelScope },
  { filename: CLIENT_PROFILES_FILENAME, module: clientProfiles },
  { filename: API_KEY_PROXY_FILENAME, module: apiKeyProxy },
  { filename: CUSTOM_MODEL_TOMBSTONES_FILENAME, module: customModelTombstones },
  { filename: PLAYGROUND_CONVERSATIONS_FILENAME, module: playgroundConversations },
  { filename: SERVER_LOGS_FILENAME, module: serverLogs },
  { filename: BACKUPS_TABLE_FILENAME, module: backupsTable },
  { filename: ATTEMPT_KEY_LABEL_FILENAME, module: attemptKeyLabel },
  { filename: PROFILE_AUTO_INCLUDE_FILENAME, module: profileAutoInclude },
  { filename: IDEMPOTENCY_CLAIMS_FILENAME, module: idempotencyClaims },
];
