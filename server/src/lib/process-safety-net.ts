// Process-level safety net for late network transport errors (fork-validated:
// jasnoorgill's safe-fetch / process-safety-net).
//
// The failure this guards against: undici resolves `fetch()` and we move on, but
// the underlying HTTP/2 / TLS socket is later reset by a CDN edge (CloudFront,
// Cloudflare) AFTER the response was handed off. undici emits that late error on
// a stream with no listener, Node escalates it to an `uncaughtException`, and —
// with no handler installed — the whole proxy exits 1. For a gateway whose entire
// job is uptime in front of flaky free-tier providers, a third party closing a
// socket must never take the process down.
//
// Design: swallow ONLY a tight allowlist of transport-error codes/messages, and
// preserve Node's default fail-fast (exit 1) for everything else, so genuine
// bugs still surface loudly. The classifier is a pure function so it can be
// unit-tested without registering global handlers.

const TRANSPORT_ERROR_CODES = new Set([
  // Node socket-level codes
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  // undici codes (the late-error culprits)
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED',
]);

const TRANSPORT_MESSAGE_HINTS = [
  'fetch failed', 'other side closed', 'socket hang up', 'terminated',
  'premature close', 'econnreset', 'request aborted',
];

// undici wraps the real socket error in `err.cause`; sometimes nested further.
// Walk the cause chain (bounded, cycle-safe) collecting codes and messages.
function walkErrorChain(err: unknown): Array<{ code?: string; message?: string }> {
  const out: Array<{ code?: string; message?: string }> = [];
  let cur: any = err;
  const seen = new Set<unknown>();
  for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    out.push({ code: typeof cur.code === 'string' ? cur.code : undefined, message: typeof cur.message === 'string' ? cur.message : undefined });
    cur = cur.cause;
  }
  return out;
}

/** Pure: true when the error is a recoverable network transport failure that
 *  should not crash the process (vs. a programming bug, which should). */
export function isTransportError(err: unknown): boolean {
  if (err == null) return false;
  const links = walkErrorChain(err);
  for (const { code } of links) {
    if (code && TRANSPORT_ERROR_CODES.has(code)) return true;
  }
  const joined = links.map(l => l.message ?? '').join(' | ').toLowerCase();
  return TRANSPORT_MESSAGE_HINTS.some(h => joined.includes(h));
}

export type ProcessErrorDecision = 'swallow' | 'fatal';

/** Pure: swallow transport errors, treat everything else as fatal. */
export function classifyProcessError(err: unknown): ProcessErrorDecision {
  return isTransportError(err) ? 'swallow' : 'fatal';
}

function describeError(err: unknown): string {
  const links = walkErrorChain(err);
  const code = links.find(l => l.code)?.code;
  const message = links.find(l => l.message)?.message;
  return code ? `${code} (${message ?? 'no message'})` : (message ?? String(err));
}

export interface SafetyNetHooks {
  log?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
  /** Set false to skip registering process.on() handlers (e.g. in test environments
   *  or runtimes that do not expose a Node process). Default: true. */
  hasProcessHooks?: boolean;
}

/** Decide and act on a process-level error. Returns the decision so callers and
 *  tests can assert behavior. `fatal` exits 1 (preserving Node's default
 *  fail-fast); `swallow` logs and lets the process continue. */
export function handleProcessError(
  kind: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  hooks: SafetyNetHooks = {},
): ProcessErrorDecision {
  const log = hooks.log ?? console.error;
  const decision = classifyProcessError(err);
  if (decision === 'swallow') {
    log(`[safety-net] swallowed transient ${kind}: ${describeError(err)}`);
    return 'swallow';
  }
  log(`[safety-net] fatal ${kind}:`, err);
  (hooks.exit ?? process.exit)(1);
  return 'fatal';
}

let installed = false;

/** Install the global handlers once. Idempotent. Call as early as possible at
 *  boot (before the server starts taking traffic). Pass `hasProcessHooks: false`
 *  to skip handler registration without changing other hook behaviour. */
export function installProcessSafetyNet(hooks: SafetyNetHooks = {}): void {
  if (installed) return;
  installed = true;
  if (hooks.hasProcessHooks === false) return;
  process.on('uncaughtException', (err) => handleProcessError('uncaughtException', err, hooks));
  process.on('unhandledRejection', (reason) => handleProcessError('unhandledRejection', reason, hooks));
}
