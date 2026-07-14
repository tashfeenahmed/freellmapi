// Provider-specific delay thresholds for the throttler.
//
// The throttler reads actual rate-limit values from the models table;
// this module only supplies the delayThreshold — the utilization ratio
// at which delays start being applied.

import path from 'path';
import { readFileSync } from 'fs';

interface ProviderEntry {
  rpm: number;
  tpm: number;
  delayThreshold: number;
}

interface ProviderConfig {
  providers: Record<string, ProviderEntry>;
}

const DEFAULT_DELAY_THRESHOLD = 0.5; // 50% utilization triggers delay

let config: ProviderConfig | null = null;

function loadConfig(): ProviderConfig {
  if (config) return config;

  try {
    const configPath = path.join(process.cwd(), 'server', 'config', 'provider-limits.json');
    const content = readFileSync(configPath, 'utf-8');
    config = JSON.parse(content) as ProviderConfig;
    return config;
  } catch {
    return { providers: {} };
  }
}

/** Return the utilization ratio (0–1) at which delays start for the given platform. */
export function getPlatformDelayThreshold(platform: string): number {
  const cfg = loadConfig();
  const provider = cfg.providers[platform];
  return provider?.delayThreshold ?? DEFAULT_DELAY_THRESHOLD;
}