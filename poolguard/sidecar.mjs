// poolguard — retry sidecar for freellmapi (2026-09-19, Eddie: "eliminate the model error —
// it should always find a working model between all the keys we have; if it can't pull a
// model, trigger a fix loop automatically").
//
// Owns the port callers already use (127.0.0.1:3001) and forwards to the pool container over
// the compose network. When the pool answers HTTP 429 "All models exhausted: ... Soonest
// reset Xm" (router.ts throws RouteError(..., 429)) or a 5xx/connect failure, it waits the
// pool's OWN reset ETA (clamped) and re-sends, up to RETRY_MAX times, before passing the last
// response through. Every FINAL exhaustion is appended to the events file; fixloop.py reads
// it to diagnose + auto-heal + page Eddie.
//
// Zero dependencies (node:http only) so it runs from node:<ver>-alpine with the script
// volume-mounted. Only POST /v1/chat/completions gets the retry treatment — admin API,
// probes and everything else are single-shot pass-throughs (canaries must observe raw pool
// behavior, not the retry buffer). Header x-poolguard-no-retry: 1 opts any caller out.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LISTEN_PORT = Number(process.env.LISTEN_PORT) || 3003;
// QA D3 (2026-09-19): default bind is every interface; hosts that only need loopback
// callers (mac native layout) set LISTEN_HOST=127.0.0.1.
const LISTEN_HOST = process.env.LISTEN_HOST || undefined;
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "freellmapi";
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT) || 3001;
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 2); // re-sends after the first failure
const WAIT_MIN_MS = Number(process.env.WAIT_MIN_MS) || 2000;
const WAIT_CAP_MS = Number(process.env.WAIT_CAP_MS) || 45000;
const EVENTS_FILE = process.env.EVENTS_FILE || "/data/poolguard-events.jsonl";
const BACKOFF = [2000, 8000, 20000];

// ── Free-tier billing guard (2026-10-21, Eddie: OpenRouter must only use free daily calls;
// Gemini also daily-limited; the Oct-17 drain was 350k-token prompts billed past the :free
// input allowance). Guards (all request-side, deterministic — no stream buffering):
//   A. OR billing: estimated input tokens > OR_INPUT_MAX -> rewrite model to SAFE_MODEL
//      (a 350k-token prompt on a ":free" OR model is a PAID call; rerouting makes the
//      drain class impossible regardless of what the pool would have picked).
//   B. Daily caps: explicit openrouter models past OR_RPD/day and gemini models past
//      GOOGLE_RPD/day -> rewrite to SAFE_MODEL for the rest of the UTC day.
//   C. Wall flags: an upstream 402 (openrouter credits) or 429 (gemini quota) sets a
//      day flag; ALL OR/gemini/auto:-profile traffic reroutes to SAFE_MODEL until reset.
//      This is also the recovery path for board agents: they get a healthy model
//      instead of a 402 error.
const OR_INPUT_MAX = Number(process.env.OR_INPUT_MAX ?? 16000);
const SAFE_MODEL = process.env.SAFE_MODEL || "MiniMax-M3";
const OR_RPD = Number(process.env.OR_RPD ?? 50);
const GOOGLE_RPD = Number(process.env.GOOGLE_RPD ?? 250);
const COUNTERS_FILE = process.env.COUNTERS_FILE || "/data/poolguard-platform-counters.json";

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function loadCounters() {
  try {
    const c = JSON.parse(fs.readFileSync(COUNTERS_FILE, "utf8"));
    if (c.date === dayKey()) return c;
  } catch (_) { /* fresh day or first run */ }
  return { date: dayKey(), openrouter: 0, google: 0, or402: false, google429: false, rerouted: 0 };
}

function saveCounters(c) {
  try {
    fs.mkdirSync(path.dirname(COUNTERS_FILE), { recursive: true });
    fs.writeFileSync(COUNTERS_FILE, JSON.stringify(c));
  } catch (e) {
    log(`COUNTERS-WRITE-FAILED ${e.message}`);
  }
}

// Conservative estimate: JSON chars / 4 (token≈4 chars for English+code).
function estInputTokens(bodyBuf) {
  return Math.ceil(bodyBuf.length / 4);
}

function modelPlatform(model) {
  if (/gemini/i.test(model)) return "google";
  // OpenRouter ids are "vendor/model" (often ":free"); explicit calls only —
  // auto: profiles are platform-unknown until the pool picks a member.
  if (/^[a-z0-9.-]+\/.+$/i.test(model) && !model.startsWith("auto:")) return "openrouter";
  return null;
}

// Returns { body: Buffer, rerouted: string|null }. Mutates counters in place.
function applyFreeTierGuards(bodyBuf, counters) {
  const text = bodyBuf.toString("utf8");
  const mm = /"model"\s*:\s*"([^"]+)"/.exec(text);
  if (!mm) return { body: bodyBuf, rerouted: null };
  const model = mm[1];
  if (model === SAFE_MODEL) return { body: bodyBuf, rerouted: null };
  const platform = modelPlatform(model);
  const isProfile = model.startsWith("auto:");

  // count explicit-platform requests toward their daily cap
  if (platform === "openrouter") counters.openrouter++;
  if (platform === "google") counters.google++;

  let reason = null;
  // A. oversized input: any OR-explicit or pool-profile request (the pool may pick OR)
  if ((platform === "openrouter" || isProfile) && estInputTokens(bodyBuf) > OR_INPUT_MAX) {
    reason = `or-input-guard(${estInputTokens(bodyBuf)}>${OR_INPUT_MAX})`;
  }
  // B. daily caps for explicit models
  if (!reason && platform === "openrouter" && counters.openrouter > OR_RPD) reason = `or-rpd(${counters.openrouter}>${OR_RPD})`;
  if (!reason && platform === "google" && counters.google > GOOGLE_RPD) reason = `google-rpd(${counters.google}>${GOOGLE_RPD})`;
  // C. wall flags block explicit AND profile traffic for the day
  if (!reason && (counters.or402 || counters.google429)) {
    if (platform === "openrouter" || (isProfile && counters.or402) || (/gemini|google/.test(model) && counters.google429)) {
      reason = `day-flag(or402=${counters.or402},google429=${counters.google429})`;
    }
  }
  if (!reason) return { body: bodyBuf, rerouted: null };
  const rewritten = text.replace(mm[0], `"model":"${SAFE_MODEL}"`);
  counters.rerouted = (counters.rerouted || 0) + 1;
  return { body: Buffer.from(rewritten, "utf8"), rerouted: reason };
}

const state = { requests: 0, retries: 0, absorbed: 0, finalFailures: 0, startedAt: new Date().toISOString(), lastEventAt: null };

function log(msg) {
  console.log(`[poolguard ${new Date().toISOString()}] ${msg}`);
}

function recordEvent(entry) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + "\n");
    state.finalFailures++;
    state.lastEventAt = entry.at;
  } catch (e) {
    log(`EVENTS-WRITE-FAILED ${e.message}`);
  }
}

// "Soonest reset 45s" / "2m" / "1h 5m" -> ms (router.ts formatResetEta shapes)
function parseResetEta(text) {
  const m = /soonest reset ([0-9hms ]+)/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const part of m[1].trim().split(/\s+/)) {
    const n = Number(part.replace(/[hms]/g, ""));
    if (!Number.isFinite(n)) continue;
    if (part.endsWith("h")) ms += n * 3600_000;
    else if (part.endsWith("m")) ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms > 0 ? ms : null;
}

// Exhaustion summaries bucket routes as "N rate-limited", "N on cooldown", "N unavailable",
// "N prompt too large", ... Retrying only helps when at least one bucket is time-healing
// (rate limit / cooldown / unavailable). Prompt-too-large-only means the caller's request
// cannot fit any member — retrying is pure latency, pass it through immediately.
const HEALING = /rate-limited|cooldown|unavailable|no-key|quota/i;
function retryableExhaustion(bodyText) {
  if (!/all models exhausted/i.test(bodyText)) return false;
  return HEALING.test(bodyText);
}

function upstreamRequest(req, body, cb) {
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    cb,
  );
  upstream.on("error", (err) => cb(null, err));
  if (body) upstream.write(body);
  upstream.end();
  return upstream;
}

function isChatCompletion(req) {
  return req.method === "POST" && /^\/v1\/chat\/completions/.test(req.url);
}

const server = http.createServer((req, res) => {
  if (req.url === "/poolguard/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, ...state }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => res.destroy());
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const noRetry = req.headers["x-poolguard-no-retry"] === "1";
    const wantsRetry = isChatCompletion(req) && !noRetry;
    state.requests++;

    // free-tier billing guard: reroute oversized OR-bound and day-capped traffic
    let guardNote = null;
    if (isChatCompletion(req)) {
      const counters = loadCounters();
      const g = applyFreeTierGuards(body, counters);
      if (g.rerouted) {
        guardNote = g.rerouted;
        body = g.body;
        log(`GUARD-REROUTE ${g.rerouted} -> ${SAFE_MODEL}`);
        recordEvent({ at: new Date().toISOString(), kind: "free-tier-guard", reroute: g.rerouted, model: SAFE_MODEL });
      }
      saveCounters(counters);
    }
    attempt(0);

    function attempt(n) {
      const upstream = upstreamRequest(req, body, (ures, uerr) => {
        if (!ures) {
          // connect-level failure: pool down or restarting — short backoff then retry
          return settle(n, 503, Buffer.from(JSON.stringify({ error: { message: `poolguard upstream failure: ${uerr.message}` } })), true, null);
        }
        if (ures.statusCode < 400 || !wantsRetry) {
          res.writeHead(ures.statusCode, ures.headers);
          ures.pipe(res);
          // QA D1 (2026-09-19): upstream socket death mid-streamed 200 must close the
          // caller too — otherwise the client hangs until its own timeout.
          ures.on("error", () => res.destroy());
          return;
        }
        // error status: buffer the (small) error body to decide retryability
        const echunks = [];
        ures.on("data", (c) => echunks.push(c));
        ures.on("end", () => settle(n, ures.statusCode, Buffer.concat(echunks), null, ures.headers));
        ures.on("error", () => settle(n, ures.statusCode, Buffer.concat(echunks), true, ures.headers));
      });
      res.on("close", () => upstream.destroy());
    }

    function settle(n, status, bodyBuf, connectFailed, headers) {
      const text = bodyBuf.toString("utf8");
      // free-tier wall flags: a 402 (OR credits) or gemini quota 429 trips the day flag
      if (status === 402 && /openrouter|credits/i.test(text)) {
        const c = loadCounters(); c.or402 = true; saveCounters(c);
        log("WALL-FLAG openrouter 402 credits — OR traffic reroutes for the rest of the day");
      }
      if (status === 429 && /gemini|google/i.test(text)) {
        const c = loadCounters(); c.google429 = true; saveCounters(c);
        log("WALL-FLAG google/gemini 429 quota — google traffic reroutes for the rest of the day");
      }
      if (guardNote && headers) headers = { ...headers, "x-poolguard-rerouted": guardNote.slice(0, 60) };
      const exhausted = /all models exhausted/i.test(text);
      const retryable = connectFailed || [429, 500, 502, 503, 504].includes(status) || exhausted;
      // Retry ONLY chat-completion traffic (GATE 3 finding): a replayed non-idempotent admin
      // POST whose connection died mid-flight would be a bug, not a feature.
      const worthIt = wantsRetry && (connectFailed || retryableExhaustion(text) || (retryable && !exhausted));
      if (worthIt && n < RETRY_MAX) {
        const eta = parseResetEta(text);
        const wait = connectFailed || !exhausted
          ? Math.min(BACKOFF[Math.min(n, BACKOFF.length - 1)], WAIT_CAP_MS)
          : Math.min(Math.max(eta ?? WAIT_MIN_MS, WAIT_MIN_MS), WAIT_CAP_MS);
        state.retries++;
        log(`retry ${n + 1}/${RETRY_MAX} in ${wait}ms status=${status}${exhausted ? " exhausted" : ""}`);
        setTimeout(() => attempt(n + 1), wait);
        return;
      }
      if (exhausted || connectFailed) {
        state.absorbed = n; // last completed retry round
        // QA D2 (2026-09-19): request bodies can exceed any fixed parse window — regex the
        // model id out of the buffered body instead of JSON.parsing a truncated prefix
        // (every real event logged model:null under the old parse).
        const mm = /"model"\s*:\s*"([^"]+)"/.exec(body.toString("utf8"));
        const model = mm ? mm[1] : null;
        recordEvent({
          at: new Date().toISOString(),
          kind: connectFailed ? "upstream-unreachable" : "exhausted",
          model,
          status,
          retries: n,
          summary: text.slice(0, 500),
        });
        log(`FINAL status=${status} retries=${n} ${text.slice(0, 160)}`);
      }
      res.writeHead(status, headers || { "content-type": "application/json" });
      res.end(bodyBuf);
    }
  });
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

  server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST ?? "*"}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} (retry-max ${RETRY_MAX}, wait ${WAIT_MIN_MS}-${WAIT_CAP_MS}ms)`));
}

export { parseResetEta, retryableExhaustion, isChatCompletion };
