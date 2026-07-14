// Provider-aware request throttler.
//
// Runs AFTER routeRequest() resolves the actual model, so it sees the real
// platform, modelId, and keyId — not a guess based on the client-sent model name.
// Called from the dispatch function in each route handler, right before the
// upstream provider call.

import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { getRateLimitStatus } from './ratelimit.js';
import { getPlatformDelayThreshold } from './provider-limits.js';

export interface ThrottleContext {
  platform: string;
  modelId: string;
  modelDbId: number;
  keyId: number;
  requestId?: string;
}

export function calculateDelay(
  rpmLimit: number | null,
  tpmLimit: number | null,
  rpmUsed: number | undefined,
  tpmUsed: number | undefined,
  threshold: number,
): number {
  let rpmDelay = 0;
  if (rpmLimit !== null && rpmUsed !== undefined) {
    const rpmRatio = rpmUsed / rpmLimit;
    if (rpmRatio >= threshold) {
      const overThreshold = rpmRatio - threshold;
      rpmDelay = Math.max(100, Math.floor(overThreshold * 60 * 1000));
    }
  }

  let tpmDelay = 0;
  if (tpmLimit !== null && tpmUsed !== undefined) {
    const tpmRatio = tpmUsed / tpmLimit;
    if (tpmRatio >= threshold) {
      const overThreshold = tpmRatio - threshold;
      tpmDelay = Math.max(100, Math.floor(overThreshold * 60 * 1000));
    }
  }

  return Math.max(rpmDelay, tpmDelay);
}

/**
 * Returns the rate-limit columns from the models table for the given model.
 * Returns null if the model is not found or has no non-null limit columns.
 */
export function getModelRateLimits(modelDbId: number): {
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
} | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit
     FROM models WHERE id = ?`
  ).get(modelDbId) as {
    rpm_limit: number | null;
    rpd_limit: number | null;
    tpm_limit: number | null;
    tpd_limit: number | null;
  } | undefined;

  if (!row) return null;
  return {
    rpm: row.rpm_limit,
    rpd: row.rpd_limit,
    tpm: row.tpm_limit,
    tpd: row.tpd_limit,
  };
}

/**
 * Check if we should throttle a request based on the resolved model's rate limits.
 * Returns the delay in milliseconds if throttling is needed, 0 otherwise.
 * Logs the decision to stdout.
 */
export function checkThrottle(ctx: ThrottleContext): number {
  const limits = getModelRateLimits(ctx.modelDbId);
  if (!limits) return 0;

  const threshold = getPlatformDelayThreshold(ctx.platform);
  const status = getRateLimitStatus(ctx.platform, ctx.modelId, ctx.keyId, limits);

  const rpmLimit = limits.rpm;
  const tpmLimit = limits.tpm;
  const rpmUsed = status.rpm.used;
  const tpmUsed = status.tpm.used;

  const delayMs = calculateDelay(rpmLimit, tpmLimit, rpmUsed, tpmUsed, threshold);

  const rpmRatio = rpmLimit !== null && rpmUsed !== undefined
    ? Math.round((rpmUsed / rpmLimit) * 100) : null;
  const tpmRatio = tpmLimit !== null && tpmUsed !== undefined
    ? Math.round((tpmUsed / tpmLimit) * 100) : null;
  const requestId = ctx.requestId ?? crypto.randomBytes(3).toString('hex');

  if (delayMs > 0) {
    console.log(
      `[Throttler] ${new Date().toISOString().slice(11, 19)} ` +
      `delay ${requestId} ${ctx.platform} ${ctx.modelId} ` +
      `rpm=${rpmUsed}/${rpmLimit}(${rpmRatio}%) ` +
      `tpm=${tpmUsed}/${tpmLimit}(${tpmRatio}%) ` +
      `thresh=${Math.round(threshold * 100)}% delay=${delayMs}ms`
    );
  } else {
    console.log(
      `[Throttler] ${new Date().toISOString().slice(11, 19)} ` +
      `pass ${requestId} ${ctx.platform} ${ctx.modelId} ` +
      `rpm=${rpmUsed}/${rpmLimit}(${rpmRatio}%) ` +
      `tpm=${tpmUsed}/${tpmLimit}(${tpmRatio}%) ` +
      `thresh=${Math.round(threshold * 100)}%`
    );
  }

  return delayMs;
}

/**
 * Apply throttle delay if needed. Call this from the dispatch function right
 * before making the upstream provider call.
 *
 * Usage in dispatch:
 *   await applyThrottle({ platform: route.platform, modelId: route.modelId, modelDbId: route.modelDbId, keyId: route.keyId, requestId });
 */
export async function applyThrottle(ctx: ThrottleContext): Promise<void> {
  const delayMs = checkThrottle(ctx);
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}