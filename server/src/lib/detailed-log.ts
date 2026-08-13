import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db/index.js';

// ── Config ───────────────────────────────────────────────────────────────
const LOG_DIR = process.env.FREEL_LOG_DIR || path.resolve(process.env.HOME || '/tmp', '.freellmapi');
const LOG_FILE = path.join(LOG_DIR, 'requests.ndjson');
const MAX_ENTRIES = 100;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB — trim to MAX_ENTRIES

// ── In-memory request-payload store (start → ok/fail) ────────────────────
const pendingPayloads = new Map<string, any>();
const MAX_PENDING = 500;

// ── Key label cache (keyId → label) ──────────────────────────────────────
const labelCache = new Map<number, string>();
const LABEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let lastLabelFetch = 0;

function resolveKeyLabel(keyId: number | undefined): string | null {
  if (keyId == null) return null;

  // Check cache first
  const cached = labelCache.get(keyId);
  if (cached !== undefined) return cached || null; // empty string → null

  // Throttle DB fetch to avoid hammering on every log entry
  const now = Date.now();
  if (now - lastLabelFetch > 5000) { // at most every 5s
    lastLabelFetch = now;
    try {
      const db = getDb();
      const rows = db.prepare('SELECT id, label FROM api_keys WHERE id IS NOT NULL').all() as { id: number; label: string }[];
      for (const row of rows) {
        labelCache.set(row.id, row.label || '');
      }
      const hit = labelCache.get(keyId);
      return hit ?? null;
    } catch {
      // DB not ready yet
    }
  }

  // Cache miss but throttle active — skip lookup
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** Strip or shorten large fields from the request body so the log stays lean. */
function sanitizeRequestBody(body: any): any {
  if (!body) return null;
  const clone: any = {};
  try {
    Object.assign(clone, JSON.parse(JSON.stringify(body)));
  } catch {
    return { _truncated: true, raw: String(body).slice(0, 200) };
  }

  // Keep top-level metadata
  clone.model = clone.model ?? null;
  if (clone.temperature != null) clone.temperature = clone.temperature;
  if (clone.max_tokens != null) clone.max_tokens = clone.max_tokens;
  if (clone.top_p != null) clone.top_p = clone.top_p;
  clone.tools = clone.tools ? `[${clone.tools.length} tool(s)]` : undefined;

  // Messages: keep text, mark images as placeholder
  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map((msg: any) => {
      if (!msg || !msg.content) return msg;
      if (Array.isArray(msg.content)) {
        const sanitized: any[] = [];
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') {
            sanitized.push(block);
          } else if (block.type === 'text') {
            sanitized.push({ type: 'text', text: (block.text ?? '').slice(0, 500) });
          } else if (block.type === 'image_url' && block.image_url?.url) {
            const url = block.image_url.url;
            const isBase64 = url.startsWith('data:');
            const summary = isBase64
              ? `${url.slice(0, 30)}...[base64: ~${Math.ceil((url.length * 3) / 4)} bytes]`
              : url;
            sanitized.push({ type: 'image_url', image_url: { url: summary } });
          } else if (block.type === 'image') {
            sanitized.push({ type: 'image', _data: '[image data truncated]' });
          } else {
            sanitized.push(block);
          }
        }
        return { ...msg, content: sanitized };
      }
      if (typeof msg.content === 'string' && msg.content.length > 500) {
        return { ...msg, content: msg.content.slice(0, 500) + '...[TRUNCATED]' };
      }
      return msg;
    });
  }

  return clone;
}

function trimLogFile(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= MAX_FILE_SIZE) return;
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-MAX_ENTRIES).join('\n') + '\n');
    }
  } catch { /* race: file may not exist */ }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Store the incoming request body so the `ok`/`fail` event can reference it.
 * Call once per request, right after validation, keyed by requestGroupId.
 * The body stays in memory for ALL attempts of this request — it is never
 * deleted by logDetailedEvent. MAX_PENDING caps the map so it doesn't leak.
 */
export function captureRequestBody(requestId: string, body: any): void {
  pendingPayloads.set(requestId, sanitizeRequestBody(body));

  // Bound the pending map — evict oldest entries
  if (pendingPayloads.size > MAX_PENDING) {
    const keys = [...pendingPayloads.keys()];
    for (let i = 0; i < keys.length - MAX_PENDING; i++) {
      pendingPayloads.delete(keys[i]);
    }
  }
}

/**
 * Summarise a successful non-streaming response for the log.
 */
export function summarizeResponse(result: any): any {
  if (!result) return null;
  try {
    const msg = result.choices?.[0]?.message;
    const text = msg?.content ?? '';
    const calls = msg?.tool_calls;
    return {
      content: typeof text === 'string' && text.length > 0
        ? text.slice(0, 300) + (text.length > 300 ? '...[TRUNCATED]' : '')
        : null,
      tool_calls: Array.isArray(calls) ? calls.map((tc: any) => tc?.function?.name).filter(Boolean) : [],
      finish_reason: result.choices?.[0]?.finish_reason ?? null,
      usage: result.usage ?? null,
    };
  } catch {
    return { _error: 'failed to summarise response' };
  }
}

/**
 * Write one NDJSON line for a completed (ok or fail) request.
 * Reads the stored request body without deleting it (reusable across attempts).
 */
export function logDetailedEvent(opts: {
  event: 'ok' | 'fail';
  requestId: string;
  attempt: number;
  keyId?: number | null;
  platform: string;
  model: string;
  requestedModel?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
  response?: any;
}): void {
  // Read without deleting — all attempts share the same body
  const requestBody = pendingPayloads.get(opts.requestId);

  const keyLabel = opts.keyId != null ? resolveKeyLabel(opts.keyId) : null;

  const entry = {
    req_id: opts.requestId,
    timestamp: new Date().toISOString(),
    attempt: opts.attempt,
    event: opts.event,
    platform: opts.platform,
    key_id: opts.keyId ?? null,
    key_label: keyLabel,
    model: opts.model,
    requested_model: opts.requestedModel ?? null,
    latency_ms: opts.latencyMs ?? null,
    input_tokens: opts.inputTokens ?? null,
    output_tokens: opts.outputTokens ?? null,
    error: opts.error ?? null,
    request: requestBody ?? null,
    response: opts.response ?? null,
  };

  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    trimLogFile();
  } catch (e: any) {
    console.error(`[DetailedLog] write error: ${e.message}`);
  }
}

/** Return the active log path (for user reference). */
export function getLogPath(): string {
  return LOG_FILE;
}
