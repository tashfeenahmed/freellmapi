/**
 * Console-level credential redaction.
 *
 * Provider keys reach stdout through many paths that no single call site owns:
 * a provider adapter logging a failed URL, an undici error whose stack embeds
 * the request, a debug line someone adds during triage. Users routinely paste
 * that output into GitHub issues. Patching console once at boot is the only
 * place that covers every path, including code that has not been written yet.
 *
 * Distinct from lib/error-redaction.ts, which sanitises a single provider error
 * string for API responses: that one also strips every URL and truncates to 240
 * chars, which would make server logs unreadable. This module removes
 * credentials and nothing else.
 *
 * This is also the capture point for the dashboard's server-log viewer
 * (lib/server-logs.ts). The tap lives inside the one wrapper installed below
 * rather than in a second one, so a line is redacted before anything else can
 * see it and the two consumers cannot drift apart.
 */

import { recordConsoleLine } from './server-logs.js';
import type { ServerLogLevel } from './server-logs.js';

const REDACTED = '[redacted-key]';

// Ordered most-specific first: prefixed provider keys, then bearer tokens, then
// key=value forms, then a conservative high-entropy catch-all.
const PATTERNS: Array<[RegExp, string]> = [
  // Known provider key prefixes. Grouped by shape rather than by vendor so a new
  // provider using an existing convention is covered without an edit here.
  [/\bsk-[A-Za-z0-9_\-/+=]{8,}/g, REDACTED],           // OpenAI-style: OpenRouter, SiliconFlow, Nara, navy, SEA-LION, Agnes, OpenCode
  [/\bsk_[A-Za-z0-9_\-]{8,}/g, REDACTED],              // Pollinations
  [/\bgsk_[A-Za-z0-9_\-]{8,}/g, REDACTED],             // Groq
  [/\bcsk-[A-Za-z0-9_\-]{8,}/g, REDACTED],             // Cerebras
  [/\bnvapi-[A-Za-z0-9_\-]{8,}/g, REDACTED],           // NVIDIA
  [/\bAIza[0-9A-Za-z_\-]{20,}/g, REDACTED],            // Google
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],       // GitHub fine-grained
  [/\bghp_[A-Za-z0-9]{20,}/g, REDACTED],               // GitHub classic
  [/\bhf_[A-Za-z0-9]{16,}/g, REDACTED],                // HuggingFace
  [/\bcfut_[A-Za-z0-9]{16,}/g, REDACTED],              // Cloudflare
  [/\bvck_[A-Za-z0-9]{16,}/g, REDACTED],               // Vercel
  [/\bcpk_[A-Za-z0-9.]{16,}/g, REDACTED],              // Chutes
  [/\balv2_[A-Za-z0-9]{16,}/g, REDACTED],              // Aion Labs
  [/\brqsty-sk-[A-Za-z0-9_\-/+=]{16,}/g, REDACTED],    // Requesty
  [/\bfreellmapi-[A-Za-z0-9_\-]{8,}/g, REDACTED],      // Keys this gateway issues

  // Authorization headers, in prose or serialised objects. The (?!\[redacted)
  // guard keeps a value an earlier pattern already replaced from being matched a
  // second time, which would otherwise append a stray bracket to the marker.
  [/\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/\-]+=*/gi, 'Bearer [redacted]'],
  [/(\bx-goog-api-key\b["']?\s*[:=]\s*["']?)(?!\[redacted)[^"',\s}\]&]+/gi, `$1${REDACTED}`],
  [/(\bx-api-key\b["']?\s*[:=]\s*["']?)(?!\[redacted)[^"',\s}\]&]+/gi, `$1${REDACTED}`],

  // key=/token=/secret= in query strings, env dumps and JSON bodies. Bounded by
  // the delimiters that terminate a value in each of those contexts.
  [
    /(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|encryption[_-]?key|key)\b["']?\s*[:=]\s*["']?)(?!\[redacted)([^"',\s}\]&]{6,})/gi,
    `$1${REDACTED}`,
  ],

  // JWTs and other three-segment tokens.
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[redacted-token]'],

  // Dotted composite keys (Z.ai, Ollama cloud, Chutes) — hex id, dot, secret.
  [/\b[A-Za-z0-9]{24,}\.[A-Za-z0-9_\-]{16,}\b/g, '[redacted-token]'],

  // Last resort: an unbroken 32+ char alphanumeric run. Long enough to exclude
  // request ids, git SHAs (40 hex would match, which is an acceptable trade) and
  // model names, and it catches bare keys with no recognisable prefix.
  //
  // The (?!([A-Za-z0-9])\1{31}) guard excludes a run of ONE repeated character.
  // A credential of 32 identical characters does not exist; padding, separator
  // rules ('='*40), progress bars and truncation markers made of them do, and
  // replacing those with [redacted-token] destroyed readable output while
  // protecting nothing. The exemption is narrow: it only fires when the run's
  // first 32 characters are all the same one, so anything with two distinct
  // characters that early — every real key, the more so the higher its entropy —
  // fails the lookahead and is redacted exactly as before.
  [/\b(?!([A-Za-z0-9])\1{31})[A-Za-z0-9]{32,}\b/g, '[redacted-token]'],
];

/** Strip credentials from a string. Safe to call on anything; non-strings are
 *  returned unchanged by the caller, not here. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Beyond this, JSON round-tripping an argument costs more than it protects.
const MAX_OBJECT_REDACTION_BYTES = 128 * 1024;

function redactArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactSecrets(arg);

  if (arg instanceof Error) {
    // Rebuilding the Error would drop subclass fields (ProviderHttpError.status
    // and friends), so mutate the two string members in place instead.
    const clone = Object.create(
      Object.getPrototypeOf(arg),
      Object.getOwnPropertyDescriptors(arg),
    ) as Error;
    clone.message = redactSecrets(arg.message);
    if (typeof arg.stack === 'string') clone.stack = redactSecrets(arg.stack);
    return clone;
  }

  if (arg !== null && typeof arg === 'object') {
    // Round-trip through JSON so a key nested in a logged object is caught, but
    // keep the result an object so console formatting is unchanged. Anything
    // non-serialisable (cycles, BigInt, sockets) falls through untouched.
    try {
      const json = JSON.stringify(arg);
      if (!json || json.length > MAX_OBJECT_REDACTION_BYTES) return arg;
      const redacted = redactSecrets(json);
      return redacted === json ? arg : JSON.parse(redacted);
    } catch {
      return arg;
    }
  }

  return arg;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug', 'trace'];

// console.log is the codebase's ordinary informational writer, so it shares
// 'info'; debug and trace keep their own level so the dashboard can filter them
// out on their own.
const LEVEL_FOR_METHOD: Record<ConsoleMethod, ServerLogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'trace',
};

let installed = false;

/**
 * Wrap the console writers so no provider credential reaches stdout. Idempotent,
 * and must run before anything else logs. Returns a restore function for tests.
 */
export function installLogRedaction(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of METHODS) {
    const original = console[method] as (...args: unknown[]) => void;
    if (typeof original !== 'function') continue;
    originals.set(method, original);
    const level = LEVEL_FOR_METHOD[method];
    console[method] = (...args: unknown[]) => {
      try {
        const redacted = args.map(redactArg);
        // The dashboard's log viewer taps in HERE, on the redacted args and
        // before the write, so there is still exactly one console patch in the
        // process and the buffer can never hold a credential the terminal did
        // not. recordConsoleLine never throws.
        recordConsoleLine(level, redacted);
        original(...redacted);
      } catch {
        // Never let redaction swallow a log line.
        original(...args);
      }
    };
  }

  return () => {
    for (const [method, original] of originals) {
      console[method] = original;
    }
    installed = false;
  };
}
