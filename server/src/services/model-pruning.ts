import { getDb } from '../db/index.js';
import { pruneUpstreamRetiredModels } from './model-state.js';
import type { Scheduler } from '../lib/scheduler.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PRUNE_INTERVAL_JITTER = 0.2; // ±20% (48–72 minutes)

function nextPruneDelayMs(jitter: () => number = Math.random): number {
  return Math.round(PRUNE_INTERVAL_MS * (1 + (jitter() * 2 - 1) * PRUNE_INTERVAL_JITTER));
}

let cancelPrune: (() => void) | null = null;
let prunerRunning = false;

/**
 * Run one model-pruning pass: disable models that have upstream_eol tombstones
 * but are still enabled=1 in the models table.
 */
export async function runModelPruningPass(): Promise<number> {
  const db = getDb();
  const pruned = pruneUpstreamRetiredModels(db);
  if (pruned > 0) {
    console.log(`[ModelPruning] Pruned ${pruned} upstream-retired model(s)`);
  }
  return pruned;
}

/**
 * Start the periodic model pruning job.
 * Runs once at startup, then every ~1 hour with jitter.
 */
export function startModelPruning(scheduler: Scheduler): void {
  if (prunerRunning) return;
  prunerRunning = true;
  console.log(
    `[ModelPruning] Starting model pruning (every ~${PRUNE_INTERVAL_MS / 1000 / 60}min ±${PRUNE_INTERVAL_JITTER * 100}%)`,
  );

  const scheduleNext = (): void => {
    cancelPrune = scheduler.after(nextPruneDelayMs(), async () => {
      try {
        await runModelPruningPass();
      } catch (err) {
        console.error('[ModelPruning] Prune pass failed:', err);
      }
      if (prunerRunning) scheduleNext();
    });
  };

  // Run once at startup
  runModelPruningPass().catch((err) => {
    console.error('[ModelPruning] Initial prune pass failed:', err);
  });

  // Schedule recurring
  scheduleNext();
}

export function stopModelPruning(): void {
  prunerRunning = false;
  if (cancelPrune) {
    cancelPrune();
    cancelPrune = null;
  }
}