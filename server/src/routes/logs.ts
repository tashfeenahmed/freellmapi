import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  LOG_LEVELS,
  clearLogs,
  currentMaxId,
  levelCounts,
  queryLogs,
  type ServerLogEntry,
  type ServerLogLevel,
} from '../lib/server-logs.js';

// The dashboard's server-log viewer. Mounted under /api/logs behind the
// dashboard session gate like every other admin route — the unified /v1 key
// opens the inference surface, never this one: these lines name providers,
// models, key ids and failure reasons.
//
// The endpoint is polled, so its contract is built around a cursor rather than
// pagination: the client keeps the `nextId` it was last handed and sends it
// back as `sinceId`, and a caller that is already caught up gets an empty
// `entries` for the cost of one comparison. `nextId` is the store's highest id
// rather than the highest id RETURNED, so a poll whose matches were all
// filtered out still advances the cursor instead of re-scanning the same tail
// forever.

export const logsRouter = Router();

const KNOWN_LEVELS = new Set<string>(LOG_LEVELS);

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message } });
}

/** First value only — Express hands back an array for a repeated param, and a
 *  repeated cursor is a client bug, not two cursors. */
function firstParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function toJson(entry: ServerLogEntry) {
  return {
    id: entry.id,
    ts: new Date(entry.tsMs).toISOString(),
    level: entry.level,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.event ? { event: entry.event } : {}),
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    message: entry.message,
  };
}

logsRouter.get('/', (req: Request, res: Response) => {
  const rawLevels = firstParam(req.query.levels);
  let levels: ServerLogLevel[] | undefined;
  if (rawLevels !== undefined && rawLevels.trim() !== '') {
    const parts = rawLevels.split(',').map(part => part.trim()).filter(part => part !== '');
    // An unknown level is rejected rather than ignored: silently dropping it
    // would show the user a filtered view that does not match the filter they
    // asked for, which is worse than an error.
    const unknown = parts.find(part => !KNOWN_LEVELS.has(part));
    if (unknown !== undefined) {
      badRequest(res, `Unknown log level '${unknown}'. Known levels: ${LOG_LEVELS.join(', ')}`);
      return;
    }
    levels = parts as ServerLogLevel[];
  }

  const rawSinceId = firstParam(req.query.sinceId);
  let sinceId: number | undefined;
  if (rawSinceId !== undefined && rawSinceId.trim() !== '') {
    const parsed = Number(rawSinceId);
    if (!Number.isInteger(parsed) || parsed < 0) {
      badRequest(res, 'sinceId must be a non-negative integer');
      return;
    }
    sinceId = parsed;
  }

  // Deliberately lenient, unlike the two above: a limit is a preference, and
  // clamping an out-of-range one to the ceiling is what the caller wanted.
  const rawLimit = firstParam(req.query.limit);
  const limit = rawLimit !== undefined && rawLimit.trim() !== '' ? Number(rawLimit) : undefined;

  const entries = queryLogs({
    levels,
    q: firstParam(req.query.q),
    provider: firstParam(req.query.provider),
    sinceId,
    limit,
  });

  res.json({
    entries: entries.map(toJson),
    nextId: currentMaxId(),
    counts: levelCounts(),
  });
});

logsRouter.post('/clear', (_req: Request, res: Response) => {
  clearLogs();
  res.json({ ok: true });
});
