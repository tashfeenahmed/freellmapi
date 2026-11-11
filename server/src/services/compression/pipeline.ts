import crypto from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import './engines/index.js';
import {
  compressionConfigFingerprint,
  getCompressionConfig,
  parseCompressionDirective,
  resolveCompressionMode,
} from './config.js';
import { checkFidelity } from './fidelity-gate.js';
import {
  buildToolCallOrigins,
  estimateTokensFromChars,
  messageChars,
  textContent,
} from './helpers.js';
import { getRegisteredEngines } from './registry.js';
import { recordCompressionStats } from './stats.js';
import type {
  CompressRequestOptions,
  CompressionEngineConfig,
  CompressionMode,
  CompressionRequestStats,
  CompressionResult,
  CompressionStageStats,
} from './types.js';

const MODE_ENGINES: Record<CompressionMode, Set<string>> = {
  off: new Set(),
  lossless: new Set(['dedup', 'lite', 'jsoncompact']),
  standard: new Set(['dedup', 'lite', 'read-lifecycle', 'toolfilter', 'jsoncompact']),
  aggressive: new Set([
    'dedup',
    'lite',
    'read-lifecycle',
    'toolfilter',
    'jsoncompact',
    'relevance',
    'aging',
    'hard-budget',
  ]),
};

const prefixOccurrences = new Map<string, number>();
const MAX_PREFIXES = 5_000;

function stablePrefixIndexes(messages: ChatMessage[], enabled: boolean): Set<number> {
  const frozen = new Set<number>();
  if (!enabled) return frozen;
  const indexesByHash = new Map<string, number[]>();

  messages.forEach((message, index) => {
    if (message.role !== 'system') return;
    const content = textContent(message);
    if (!content) return;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const indexes = indexesByHash.get(hash) ?? [];
    indexes.push(index);
    indexesByHash.set(hash, indexes);
  });

  for (const [hash, indexes] of indexesByHash) {
    const count = (prefixOccurrences.get(hash) ?? 0) + 1;
    prefixOccurrences.delete(hash);
    prefixOccurrences.set(hash, count);
    if (count >= 3) {
      for (const index of indexes) frozen.add(index);
    }
  }

  while (prefixOccurrences.size > MAX_PREFIXES) {
    const oldest = prefixOccurrences.keys().next().value as string | undefined;
    if (!oldest) break;
    prefixOccurrences.delete(oldest);
  }
  return frozen;
}

function emptyStats(chars: number, started: number): CompressionRequestStats {
  const tokens = estimateTokensFromChars(chars);
  return {
    originalChars: chars,
    compressedChars: chars,
    estOriginalTokens: tokens,
    estCompressedTokens: tokens,
    estSavedTokens: 0,
    enginesApplied: [],
    discardedByGate: [],
    durationMs: performance.now() - started,
    stages: [],
  };
}

export function compressRequest(
  messages: ChatMessage[],
  options: CompressRequestOptions = {},
): CompressionResult {
  const started = performance.now();
  const config = options.config ?? getCompressionConfig();
  const directive = parseCompressionDirective(options.header);
  const originalChars = messageChars(messages);
  const originalEstimate = estimateTokensFromChars(originalChars);
  let mode = options.previewMode ?? resolveCompressionMode(config, directive);
  const autoTriggered = options.previewMode === undefined
    && mode !== 'off'
    && (directive === 'default' || directive === 'on')
    && config.autoTriggerEstTokens !== undefined
    && originalEstimate >= config.autoTriggerEstTokens;
  if (autoTriggered) mode = 'aggressive';
  if (mode === 'off') {
    const stats = emptyStats(originalChars, started);
    if (options.recordStats !== false) recordCompressionStats(mode, stats);
    return {
      messages,
      mode,
      cacheKey: compressionConfigFingerprint(config, mode),
      stats,
    };
  }

  const stableFrozen = stablePrefixIndexes(messages, config.prefixFreeze);
  const cacheFrozen = new Set<number>();
  const cachePrefixLength = Math.max(0, Math.min(messages.length, options.cacheControlPrefixLength ?? 0));
  for (let index = 0; index < cachePrefixLength; index += 1) cacheFrozen.add(index);

  const targetTokens = options.targetTokens
    ?? config.targetTokens
    ?? (
      autoTriggered
        ? Math.max(1, Math.floor(config.autoTriggerEstTokens! * 0.9))
        : undefined
    );
  let current = messages;
  const stages: CompressionStageStats[] = [];
  const enginesApplied: string[] = [];
  const discardedByGate: string[] = [];

  for (const engine of getRegisteredEngines()) {
    if (!MODE_ENGINES[mode].has(engine.id)) continue;
    // Adaptive requests stop as soon as the requested ceiling is met. Manual
    // modes without a target still run their complete engine set.
    if (targetTokens && messageChars(current) <= targetTokens * 4) break;
    const engineConfig = config.engines[engine.id] ?? { enabled: true };
    if (!engineConfig.enabled) {
      stages.push({
        engine: engine.id,
        inputChars: messageChars(current),
        outputChars: messageChars(current),
        savedChars: 0,
        applied: false,
        discarded: 'disabled',
      });
      continue;
    }

    const inputChars = messageChars(current);
    try {
      const validated = engine.configSchema.safeParse({
        ...engineConfig,
        trustProjectFilters: config.trustProjectFilters,
      });
      if (!validated.success) throw new Error(`Invalid ${engine.id} configuration`);
      const frozenMessageIndexes = engine.lossless
        ? stableFrozen
        : new Set([...stableFrozen, ...cacheFrozen]);
      const result = engine.apply({
        messages: current,
        config: validated.data as CompressionEngineConfig,
        context: {
          mode,
          tools: options.tools,
          targetTokens,
          frozenMessageIndexes,
          toolCallOrigins: buildToolCallOrigins(current),
        },
      });
      const outputChars = messageChars(result.messages);
      if (outputChars === inputChars) {
        stages.push({
          engine: engine.id,
          inputChars,
          outputChars,
          savedChars: 0,
          applied: false,
          discarded: 'unchanged',
          details: result.details,
        });
        continue;
      }
      const fidelity = checkFidelity(current, result.messages);
      if (!fidelity.accepted) {
        const discarded = fidelity.reason === 'inflation' ? 'inflation' : 'fidelity';
        if (discarded === 'fidelity') discardedByGate.push(engine.id);
        stages.push({
          engine: engine.id,
          inputChars,
          outputChars,
          savedChars: 0,
          applied: false,
          discarded,
          fidelity: {
            protectedTokenSurvival: fidelity.protectedTokenSurvival,
            numericLiteralsPreserved: fidelity.numericLiteralsPreserved,
            jsonKeySurvival: fidelity.jsonKeySurvival,
            diffHunksPreserved: fidelity.diffHunksPreserved,
            criticalLinesPreserved: fidelity.criticalLinesPreserved,
          },
          details: result.details,
        });
        continue;
      }
      current = result.messages;
      enginesApplied.push(engine.id);
      stages.push({
        engine: engine.id,
        inputChars,
        outputChars,
        savedChars: inputChars - outputChars,
        applied: true,
        fidelity: {
          protectedTokenSurvival: fidelity.protectedTokenSurvival,
          numericLiteralsPreserved: fidelity.numericLiteralsPreserved,
          jsonKeySurvival: fidelity.jsonKeySurvival,
          diffHunksPreserved: fidelity.diffHunksPreserved,
          criticalLinesPreserved: fidelity.criticalLinesPreserved,
        },
        details: result.details,
      });
    } catch {
      discardedByGate.push(engine.id);
      stages.push({
        engine: engine.id,
        inputChars,
        outputChars: inputChars,
        savedChars: 0,
        applied: false,
        discarded: 'exception',
      });
    }
  }

  const compressedChars = messageChars(current);
  const stats: CompressionRequestStats = {
    originalChars,
    compressedChars,
    estOriginalTokens: estimateTokensFromChars(originalChars),
    estCompressedTokens: estimateTokensFromChars(compressedChars),
    estSavedTokens: Math.max(0, Math.floor((originalChars - compressedChars) / 4)),
    enginesApplied,
    discardedByGate,
    durationMs: performance.now() - started,
    stages,
  };
  if (options.recordStats !== false) recordCompressionStats(mode, stats);
  return {
    messages: current,
    mode,
    cacheKey: compressionConfigFingerprint(config, mode),
    stats,
  };
}

export function formatCompressionHeader(result: CompressionResult): string {
  return `${result.mode}; saved~=${result.stats.estSavedTokens}`;
}

export function _clearPrefixFreezeForTesting(): void {
  prefixOccurrences.clear();
}
