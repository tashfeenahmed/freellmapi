/**
 * The dashboard's server-log store.
 *
 * Operators debugging a routing decision, a benched key or a retired model have
 * had exactly one place to look: the terminal the process was started from. On
 * a desktop install, a container, or a systemd unit that is either awkward or
 * gone entirely. This module keeps the same lines the server already prints and
 * makes them readable from the dashboard.
 *
 * Two tiers, ONE id space:
 *   - a ring buffer (RING_CAPACITY entries, every level) backs the live view
 *     and is the only thing the polling endpoint reads;
 *   - warn/error rows are ALSO written to the `server_logs` table, so the
 *     lines that matter survive a restart.
 *
 * Ids are assigned here, not by SQLite, because the client polls with a
 * `sinceId` cursor and that cursor has to mean the same thing for a line that
 * only ever lived in memory and for one that came back from the table. The
 * counter is seeded from MAX(id) at init, so ids keep increasing across
 * restarts and a cursor held by an open dashboard tab never goes backwards.
 *
 * Capture is a TAP inside lib/log-redaction.ts rather than a second console
 * wrapper: there is exactly one console patch in this process, it redacts
 * first, and this store only ever sees the redacted form.
 */

import { inspect } from 'node:util';
import { getDb } from '../db/index.js';
import { redactSecrets } from './log-redaction.js';
import type { Db } from '../db/types.js';

/** Levels the store understands. console.log maps to 'info'; debug and trace
 *  keep their own identity so a noisy trace can be filtered out on its own. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type ServerLogLevel = (typeof LOG_LEVELS)[number];

/** Levels durable enough to be worth a row. Mirrors the migration's CHECK. */
const PERSISTED_LEVELS = new Set<ServerLogLevel>(['warn', 'error']);

/** Live-view depth. A thousand lines is a few minutes of a busy gateway and
 *  costs well under a megabyte at the message cap below. */
export const RING_CAPACITY = 1000;

/** How much persisted history is pulled back into the ring at init, so the
 *  dashboard shows the warnings that preceded the restart instead of an empty
 *  panel that fills up only if something goes wrong again. */
export const PRELOAD_LIMIT = 200;

/** A single log line is a diagnostic, not a document. Long provider bodies and
 *  multi-frame stacks are truncated rather than dropped — the head is where the
 *  information is. */
export const MAX_MESSAGE_LENGTH = 6000;

const TRUNCATION_SUFFIX = '… [truncated]';

/**
 * The viewer polls GET /api/logs every couple of seconds. If the deployment in
 * front of us emits access-log lines, those polls would be the loudest thing in
 * the buffer and every poll would manufacture the content of the next one.
 *
 * NOTE (verified in this tree): this server installs NO access-log middleware —
 * there is no morgan/pino/winston dependency and no request-logging middleware
 * in app.ts or src/middleware/. So today nothing matches this filter. It stays
 * because the cost is one regex test at ingest and the failure mode it prevents
 * (a self-feeding buffer) is one an operator cannot work around; a reverse
 * proxy, a future middleware, or a debug line added during triage all produce
 * exactly these lines.
 */
const NOISE_RE = /\b(?:GET|HEAD)\s+\/api\/(?:logs|ping)\b/i;

export interface ServerLogMeta {
  provider?: string;
  model?: string;
  event?: string;
  requestId?: string;
}

export interface ServerLogEntry extends ServerLogMeta {
  id: number;
  tsMs: number;
  level: ServerLogLevel;
  /** The `[Tag]` a line opens with, when it has one ('Health', 'CooldownProbe'…). */
  source?: string;
  message: string;
}

// ── State ────────────────────────────────────────────────────────────────────

let ring: ServerLogEntry[] = [];
let lastId = 0;
let seeded = false;

/**
 * Set while providerLog() mirrors its message to stdout. The console it calls
 * is the WRAPPED one (that is the point — the redaction wrapper must still see
 * it), and the wrapper taps back into this module, so without this flag every
 * structured event would land in the ring twice.
 */
let mirroring = false;

/**
 * Set while a persist is in flight. The DB layer can log — a busy-timeout
 * warning, a permissions warning from db/index.ts — and that log would come
 * straight back here and try to insert again. The ring still accepts the line;
 * only the write is skipped.
 */
let persisting = false;

/** Reentrancy guard for the boot seed, for the same reason as `persisting`. */
let seeding = false;

// ── Formatting ───────────────────────────────────────────────────────────────

/** One console argument, rendered the way it reaches stdout: strings verbatim,
 *  Errors with their stack, everything else inspected at bounded depth. */
function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'object') {
    try {
      return inspect(arg, { depth: 2, breakLength: Infinity, maxStringLength: 1000 });
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

export function formatLogArgs(args: readonly unknown[]): string {
  return args.map(formatArg).join(' ');
}

function truncate(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return message.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/** The subsystem tag the codebase already prefixes its lines with. Deriving it
 *  instead of asking every call site for one is what makes the `source` column
 *  useful for lines nobody edited. */
const SOURCE_RE = /^\s*\[([A-Za-z][\w .:/-]{0,39})\]/;

function deriveSource(message: string): string | undefined {
  return SOURCE_RE.exec(message)?.[1];
}

// ── Ingest ───────────────────────────────────────────────────────────────────

function trimField(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 200);
}

export interface RecordLogOptions extends ServerLogMeta {
  level: ServerLogLevel;
  message: string;
  source?: string;
  tsMs?: number;
}

/**
 * The single ingest point. Everything — the console tap, providerLog, the boot
 * preload's live siblings — arrives here, which is what makes the noise filter,
 * the length cap and the id counter impossible to bypass.
 *
 * Returns the stored entry, or null when the line was filtered out.
 */
export function recordLogEntry(options: RecordLogOptions): ServerLogEntry | null {
  const message = truncate(options.message);
  if (message.trim() === '') return null;
  if (NOISE_RE.test(message)) return null;

  ensureSeeded();

  const entry: ServerLogEntry = {
    id: ++lastId,
    tsMs: options.tsMs ?? Date.now(),
    level: options.level,
    message,
  };
  const source = trimField(options.source) ?? deriveSource(message);
  if (source) entry.source = source;
  const provider = trimField(options.provider);
  if (provider) entry.provider = provider;
  const model = trimField(options.model);
  if (model) entry.model = model;
  const event = trimField(options.event);
  if (event) entry.event = event;
  const requestId = trimField(options.requestId);
  if (requestId) entry.requestId = requestId;

  push(entry);
  if (PERSISTED_LEVELS.has(entry.level)) persist(entry);
  return entry;
}

function push(entry: ServerLogEntry): void {
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
}

/**
 * Called by the console wrapper in lib/log-redaction.ts, AFTER redaction. Never
 * throws: a log line must not be able to fail the call that emitted it.
 */
export function recordConsoleLine(level: ServerLogLevel, args: readonly unknown[]): void {
  if (mirroring) return;
  try {
    recordLogEntry({ level, message: formatLogArgs(args) });
  } catch {
    // Swallowed on purpose — see above.
  }
}

/**
 * Emit a structured operational event: recorded with its provider/model/event
 * metadata for the dashboard AND mirrored to stdout, so nothing an operator
 * needs exists only behind a login.
 *
 * The message is passed through redactSecrets() here because the recording
 * bypasses the console wrapper; the stdout mirror goes through the wrapped
 * console (already-redacted text is idempotent under a second pass) so that a
 * restored console — tests, an embedder — still sees the line.
 */
export function providerLog(
  level: ServerLogLevel,
  message: string,
  meta: ServerLogMeta = {},
): void {
  const redacted = redactSecrets(message);
  try {
    recordLogEntry({ level, message: redacted, ...meta });
  } catch {
    // Never let the store break the caller's control flow.
  }

  mirroring = true;
  try {
    const write =
      level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
      : level === 'trace' ? console.trace
      : console.log;
    write(redacted);
  } catch {
    // A console that throws is not this module's problem to solve.
  } finally {
    mirroring = false;
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

interface ServerLogRow {
  id: number;
  level: string;
  source: string | null;
  provider: string | null;
  model: string | null;
  event: string | null;
  request_id: string | null;
  message: string;
  created_at_ms: number;
}

function tryDb(): Db | null {
  try {
    return getDb();
  } catch {
    // Pre-initDb boot lines, and tests that never open a database.
    return null;
  }
}

function hasTable(db: Db): boolean {
  try {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_logs'")
      .get();
  } catch {
    return false;
  }
}

function persist(entry: ServerLogEntry): void {
  if (persisting) return;
  persisting = true;
  try {
    const db = tryDb();
    if (!db) return;
    db.prepare(`
      INSERT INTO server_logs (id, level, source, provider, model, event, request_id, message, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.level,
      entry.source ?? null,
      entry.provider ?? null,
      entry.model ?? null,
      entry.event ?? null,
      entry.requestId ?? null,
      entry.message,
      entry.tsMs,
    );
  } catch {
    // Best effort by design: the table may not exist yet (a boot line racing
    // the migration), the DB may be locked, the disk may be full. None of that
    // is worth losing the live line — or crashing the caller — over.
  } finally {
    persisting = false;
  }
}

function rowToEntry(row: ServerLogRow): ServerLogEntry {
  const entry: ServerLogEntry = {
    id: row.id,
    tsMs: row.created_at_ms,
    level: (LOG_LEVELS as readonly string[]).includes(row.level)
      ? (row.level as ServerLogLevel)
      : 'error',
    message: row.message,
  };
  if (row.source) entry.source = row.source;
  if (row.provider) entry.provider = row.provider;
  if (row.model) entry.model = row.model;
  if (row.event) entry.event = row.event;
  if (row.request_id) entry.requestId = row.request_id;
  return entry;
}

/**
 * Seed the id counter and preload recent history. Idempotent, and safe to call
 * before the database exists — it simply stays unseeded and tries again on the
 * next line, which is what covers the handful of boot logs emitted between
 * installLogRedaction() and initDb().
 *
 * Lines already buffered when the database appears keep their order but are
 * re-stamped ABOVE the persisted maximum, because ids have to be unique across
 * both tiers and a pre-DB line was numbered from a counter that started at zero.
 */
function ensureSeeded(): void {
  if (seeded || seeding) return;
  // Same reasoning as `persisting`: the two probes below touch the DB layer,
  // which can log, and that log comes straight back into recordLogEntry.
  seeding = true;
  try {
    seedNow();
  } finally {
    seeding = false;
  }
}

function seedNow(): void {
  const db = tryDb();
  if (!db || !hasTable(db)) return;
  seeded = true;

  try {
    const pending = ring.splice(0, ring.length);
    const max = db.prepare('SELECT MAX(id) AS maxId FROM server_logs').get() as
      | { maxId: number | null }
      | undefined;
    lastId = Math.max(lastId, max?.maxId ?? 0);

    const rows = db.prepare(`
      SELECT id, level, source, provider, model, event, request_id, message, created_at_ms
        FROM server_logs
       ORDER BY created_at_ms DESC, id DESC
       LIMIT ?
    `).all(PRELOAD_LIMIT) as ServerLogRow[];
    // Read newest-first so LIMIT keeps the recent end; the ring is oldest-first.
    for (const row of rows.reverse()) push(rowToEntry(row));

    for (const entry of pending) {
      entry.id = ++lastId;
      push(entry);
      if (PERSISTED_LEVELS.has(entry.level)) persist(entry);
    }
  } catch {
    // A seed that fails leaves the counter where it was; ids stay increasing
    // within this process, which is the guarantee the cursor actually needs.
  }
}

/** Force the seed/preload now (the route calls this so an idle server still
 *  shows persisted history on the first poll). */
export function initServerLogs(): void {
  ensureSeeded();
}

// ── Read side ────────────────────────────────────────────────────────────────

/** Counts over the CURRENT ring, unfiltered, so the UI can render level badges
 *  without fetching every entry. Trace is folded into debug: it is a debug-tier
 *  detail and the dashboard shows four badges. */
export interface LogLevelCounts {
  debug: number;
  info: number;
  warn: number;
  error: number;
}

export interface LogQuery {
  levels?: ServerLogLevel[];
  q?: string;
  provider?: string;
  sinceId?: number;
  limit?: number;
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
export const MIN_LIMIT = 1;

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(raw)));
}

/** Highest id handed out so far — what the client sends back as sinceId, even
 *  when every entry it would have matched was filtered away. */
export function currentMaxId(): number {
  ensureSeeded();
  return lastId;
}

export function levelCounts(): LogLevelCounts {
  ensureSeeded();
  const counts: LogLevelCounts = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const entry of ring) {
    if (entry.level === 'trace' || entry.level === 'debug') counts.debug++;
    else counts[entry.level]++;
  }
  return counts;
}

function matches(entry: ServerLogEntry, levels: Set<ServerLogLevel> | null, needle: string | null, provider: string | null): boolean {
  if (levels && !levels.has(entry.level)) return false;
  if (provider !== null && entry.provider !== provider) return false;
  if (needle !== null) {
    const haystack = `${entry.message} ${entry.provider ?? ''} ${entry.source ?? ''} ${entry.event ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** The newest `limit` entries of the filtered set, oldest→newest. */
export function queryLogs(query: LogQuery = {}): ServerLogEntry[] {
  ensureSeeded();
  const sinceId = query.sinceId;
  // A caller already caught up costs one comparison, not a scan.
  if (sinceId !== undefined && sinceId >= lastId) return [];

  const levels = query.levels && query.levels.length > 0 ? new Set(query.levels) : null;
  const needle = query.q && query.q.trim() !== '' ? query.q.trim().toLowerCase() : null;
  const provider = query.provider && query.provider.trim() !== '' ? query.provider.trim() : null;
  const limit = clampLimit(query.limit);

  const out: ServerLogEntry[] = [];
  // Walk backwards so `limit` bounds the work, not just the result.
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = ring[i]!;
    if (sinceId !== undefined && entry.id <= sinceId) break;
    if (matches(entry, levels, needle, provider)) out.push(entry);
  }
  return out.reverse();
}

/** Empty both tiers. The id counter is deliberately NOT reset: a dashboard tab
 *  holding a cursor would otherwise be handed ids it has already seen. */
export function clearLogs(): void {
  ensureSeeded();
  ring = [];
  const db = tryDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM server_logs').run();
  } catch {
    // Same best-effort contract as persist().
  }
}

/** Test seam: drop every entry AND the counter/seed state, so a suite can
 *  simulate a cold start against a database that still holds rows. */
export function resetServerLogsForTest(): void {
  ring = [];
  lastId = 0;
  seeded = false;
  seeding = false;
  mirroring = false;
  persisting = false;
}

/** Test/introspection seam: the ring exactly as stored. */
export function ringSnapshot(): readonly ServerLogEntry[] {
  return ring;
}
