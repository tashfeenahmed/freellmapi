// Detect that the host slept (laptop lid closed, VM paused) and give the
// server a chance to shake off stale state the moment it comes back. While
// the process is suspended nothing runs — timers, health probes, keep-alive
// sockets all freeze — so the first requests after wake used to hit dead
// upstream sockets and pre-sleep key statuses until the 5-minute health cycle
// caught up. Detection is a 5s heartbeat: when the wall clock jumped far
// beyond the expected tick interval (>30s drift), the process was suspended.
// SIGCONT/SIGUSR2 also trigger a wake event, so operators (and the desktop
// wrapper) can force a recovery pass by signaling the process. SIGUSR1 is
// deliberately NOT used: Node reserves it for the inspector — signaling it
// opens a debugger port, which is the opposite of hardening.
//
// Ported from @Naster17's fork (Naster17/freellmapi-pro@4c43cf2a), trimmed to
// what applies upstream: his inflight-slot TTL guards fork-only concurrency
// machinery, and his SQLite ping/reconnect isn't needed for an in-process
// better-sqlite3 handle (and would bypass connectDb's injected factory).

export interface WakeHooks {
  onWake: (event: WakeEvent) => void | Promise<void>;
}

export interface WakeEvent {
  reason: 'drift' | 'signal';
  idleMs: number;
  signal?: string;
}

const TICK_MS = 5_000;
const DRIFT_THRESHOLD_MS = 30_000;
// One recovery pass per resume: a drift tick and an operator SIGCONT/SIGUSR2
// for the SAME wake (or signal spam) must not stack flushes + full key
// re-probes on top of each other.
const WAKE_DEBOUNCE_MS = 15_000;

let hooks: WakeHooks | null = null;
let timer: NodeJS.Timeout | null = null;
let lastTickAt = 0;
let lastWakeAt = 0;
let installed = false;
// Kept so stopWakeDetect can remove exactly the listeners this module added —
// removeAllListeners would silently unhook any OTHER module's SIGUSR2 handler
// (log rotation, heap-dump triggers).
const sigcontHandler = () => handleSignal('SIGCONT');
const sigusr2Handler = () => handleSignal('SIGUSR2');

function tick(): void {
  const now = Date.now();
  if (lastTickAt > 0) {
    const drift = now - lastTickAt - TICK_MS;
    if (drift > DRIFT_THRESHOLD_MS) {
      invokeHooks({ reason: 'drift', idleMs: drift });
    }
  }
  lastTickAt = now;
  timer = setTimeout(tick, TICK_MS);
  // Never keep the process alive just for the heartbeat.
  if (timer.unref) timer.unref();
}

function handleSignal(name: string): void {
  const idleMs = lastTickAt > 0 ? Math.max(0, Date.now() - lastTickAt - TICK_MS) : 0;
  invokeHooks({ reason: 'signal', idleMs, signal: name });
  lastTickAt = Date.now();
}

// The recovery pass must never take the server down: a throwing handler is
// logged and swallowed, sync or async.
function invokeHooks(event: WakeEvent): void {
  if (!hooks) return;
  const now = Date.now();
  if (now - lastWakeAt < WAKE_DEBOUNCE_MS) return;
  lastWakeAt = now;
  try {
    Promise.resolve(hooks.onWake(event)).catch((err) => {
      console.error(`[wake-detect] onWake handler error: ${err?.message ?? err}`);
    });
  } catch (err: any) {
    console.error(`[wake-detect] onWake handler threw synchronously: ${err?.message ?? err}`);
  }
}

export function startWakeDetect(h: WakeHooks): void {
  if (installed) return; // idempotent — no double signal registration
  installed = true;
  hooks = h;
  lastTickAt = Date.now();
  timer = setTimeout(tick, TICK_MS);
  if (timer.unref) timer.unref();
  process.on('SIGCONT', sigcontHandler);
  process.on('SIGUSR2', sigusr2Handler);
}

export function stopWakeDetect(): void {
  if (!installed) return;
  installed = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  process.removeListener('SIGCONT', sigcontHandler);
  process.removeListener('SIGUSR2', sigusr2Handler);
  hooks = null;
  lastTickAt = 0;
  lastWakeAt = 0;
}

export function _resetForTests(): void {
  stopWakeDetect();
}
