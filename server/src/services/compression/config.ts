import { z } from 'zod';
import { getSetting, setSetting } from '../../db/index.js';
import {
  COMPRESSION_MODES,
  type CompressionConfig,
  type CompressionEngineConfig,
  type CompressionMode,
} from './types.js';

export const COMPRESSION_SETTING = 'compression';

const enabledSchema = z.object({ enabled: z.boolean() }).passthrough();

const engineDefaults: Record<string, CompressionEngineConfig> = {
  dedup: { enabled: true, minBlockChars: 80, minBlockLines: 3 },
  lite: { enabled: true },
  'read-lifecycle': { enabled: true },
  toolfilter: {
    enabled: true,
    intensity: 'standard',
    maxLinesPerResult: 120,
    maxCharsPerResult: 12_000,
    disabledFilters: [],
  },
  jsoncompact: { enabled: true, minRows: 8 },
  relevance: { enabled: true, maxChars: 18_000 },
  aging: { enabled: true, liveTurns: 3, condenseAfterTurns: 8 },
  'hard-budget': { enabled: true },
};

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  mode: 'off',
  engines: engineDefaults,
  trustProjectFilters: false,
  prefixFreeze: true,
};

const storedConfigSchema = z.object({
  mode: z.enum(COMPRESSION_MODES).default('off'),
  engines: z.record(z.string(), enabledSchema).default({}),
  autoTriggerEstTokens: z.number().int().positive().optional(),
  targetTokens: z.number().int().positive().optional(),
  trustProjectFilters: z.boolean().default(false),
  prefixFreeze: z.boolean().default(true),
});

export const compressionUpdateSchema = z.object({
  mode: z.enum(COMPRESSION_MODES).optional(),
  engines: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  autoTriggerEstTokens: z.number().int().positive().nullable().optional(),
  targetTokens: z.number().int().positive().nullable().optional(),
  trustProjectFilters: z.boolean().optional(),
  prefixFreeze: z.boolean().optional(),
}).strict();

function safeSetting(): string | undefined {
  try {
    return getSetting(COMPRESSION_SETTING);
  } catch {
    return undefined;
  }
}

function envMode(): CompressionMode {
  const raw = process.env.FREELLMAPI_COMPRESSION?.trim().toLowerCase();
  return (COMPRESSION_MODES as readonly string[]).includes(raw ?? '')
    ? raw as CompressionMode
    : 'off';
}

function mergeDefaults(value: Partial<CompressionConfig>): CompressionConfig {
  const engines: Record<string, CompressionEngineConfig> = {};
  for (const [id, fallback] of Object.entries(engineDefaults)) {
    engines[id] = { ...fallback, ...(value.engines?.[id] ?? {}) };
  }
  for (const [id, config] of Object.entries(value.engines ?? {})) {
    if (!engines[id]) engines[id] = { ...config, enabled: config.enabled ?? true };
  }
  return {
    mode: value.mode ?? envMode(),
    engines,
    ...(value.autoTriggerEstTokens ? { autoTriggerEstTokens: value.autoTriggerEstTokens } : {}),
    ...(value.targetTokens ? { targetTokens: value.targetTokens } : {}),
    trustProjectFilters: value.trustProjectFilters ?? false,
    prefixFreeze: value.prefixFreeze ?? true,
  };
}

export function getCompressionConfig(): CompressionConfig {
  const raw = safeSetting();
  if (!raw) return mergeDefaults({ mode: envMode() });
  try {
    const parsed = storedConfigSchema.parse(JSON.parse(raw));
    return mergeDefaults(parsed);
  } catch {
    return mergeDefaults({ mode: envMode() });
  }
}

export function setCompressionConfig(update: z.infer<typeof compressionUpdateSchema>): CompressionConfig {
  const parsed = compressionUpdateSchema.parse(update);
  const current = getCompressionConfig();
  const engines = { ...current.engines };
  for (const [id, patch] of Object.entries(parsed.engines ?? {})) {
    engines[id] = {
      ...(engines[id] ?? { enabled: true }),
      ...patch,
      enabled: typeof patch.enabled === 'boolean'
        ? patch.enabled
        : (engines[id]?.enabled ?? true),
    };
  }
  const next: CompressionConfig = {
    ...current,
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    engines,
    trustProjectFilters: parsed.trustProjectFilters ?? current.trustProjectFilters,
    prefixFreeze: parsed.prefixFreeze ?? current.prefixFreeze,
  };
  if (parsed.autoTriggerEstTokens === null) delete next.autoTriggerEstTokens;
  else if (parsed.autoTriggerEstTokens !== undefined) next.autoTriggerEstTokens = parsed.autoTriggerEstTokens;
  if (parsed.targetTokens === null) delete next.targetTokens;
  else if (parsed.targetTokens !== undefined) next.targetTokens = parsed.targetTokens;
  setSetting(COMPRESSION_SETTING, JSON.stringify(next));
  return getCompressionConfig();
}

export type CompressionDirective = 'default' | 'off' | 'on' | Exclude<CompressionMode, 'off'>;

export function parseCompressionDirective(header: string | string[] | undefined): CompressionDirective {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (!raw) return 'default';
  if (/^(off|no|0|false|bypass|skip)$/.test(raw)) return 'off';
  if (/^(on|yes|1|true)$/.test(raw)) return 'on';
  if (raw === 'lossless' || raw === 'standard' || raw === 'aggressive') return raw;
  return 'default';
}

const modeRank: Record<CompressionMode, number> = {
  off: 0,
  lossless: 1,
  standard: 2,
  aggressive: 3,
};

export function resolveCompressionMode(
  config: CompressionConfig,
  directive: CompressionDirective,
): CompressionMode {
  // `off` is an operator master switch. A request can always reduce work, but
  // can never turn on (or raise) a mode the operator did not permit.
  if (config.mode === 'off' || directive === 'off') return 'off';
  if (directive === 'default' || directive === 'on') return config.mode;
  return modeRank[directive] < modeRank[config.mode] ? directive : config.mode;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sorted(child)]),
  );
}

export function compressionConfigFingerprint(config: CompressionConfig, mode: CompressionMode): string {
  return JSON.stringify(sorted({ version: 1, mode, config }));
}
