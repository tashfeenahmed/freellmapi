import type { Platform } from '@freellmapi/shared/types.js';

export interface QuotaObservationContext {
  platform: Platform;
  keyId: number;
  modelId: string;
  quotaPoolKey: string;
  endpoint: string;
  origin: 'proxy' | 'responses';
}

export function inferQuotaPoolKey(platform: Platform, modelId: string): string {
  return `${platform}:${modelId}`;
}
