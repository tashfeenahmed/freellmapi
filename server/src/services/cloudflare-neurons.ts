import { getDb } from '../db/index.js';
import { cloudflareAccountId, benchCloudflareAccountId } from './cloudflare-daily-quota.js';

// Cloudflare Workers AI: keep the free neurons free.
//
// Workers AI gives every ACCOUNT 10,000 free neurons a day, shared by every
// model and every token. On the Free plan Cloudflare answers a "daily free
// allocation" 429 once they are spent, and cloudflare-daily-quota.ts benches
// the account until midnight UTC. On Workers Paid that 429 never comes:
// Cloudflare just bills $0.011 per 1,000 neurons over the allowance. An
// account upgraded for any other reason (more Workers requests, say) turned
// FreeLLMAPI's "free" Cloudflare route into a paid one with no warning. On
// 2026-11-02/03 one bulk-generation run spent ~16.6M neurons (~$183) that way.
//
// So FreeLLMAPI meters neurons itself:
//   - Every Cloudflare call is charged an ESTIMATE in cloudflare_neuron_usage
//     the moment it is dispatched (startCloudflareCall) and corrected to the
//     real usage when it completes (settle). A call that aborts, times out or
//     loses a hedge keeps its estimate: Cloudflare bills work it started, and
//     during the incident above it billed 2.4x the calls that ever reached the
//     request log.
//   - The router and the embeddings/media/decision credential picker skip a
//     Cloudflare key whose account has reached the cap, and the meter itself
//     refuses (with the same 429 Cloudflare's Free plan sends) as a backstop.
//   - When the key's token may read account analytics, Cloudflare's own count
//     for the day is fetched every few minutes and the higher of the two wins,
//     so usage from outside this install counts as well.
//
// CLOUDFLARE_DAILY_NEURON_CAP sets the cap (default 9,000: the 10,000 free
// allowance minus a margin for estimate drift and calls in flight). 0 turns the
// meter's gate off, for an operator who WANTS to pay for Workers AI.

export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000;
export const DEFAULT_CLOUDFLARE_DAILY_NEURON_CAP = 9_000;

/** Workers AI bills $0.011 per 1,000 neurons, so one USD buys this many. */
const NEURONS_PER_USD = 1000 / 0.011;

/** Workers AI prices in USD, from GET /accounts/{id}/ai/models/search
 *  (`price` property) on 2026-11-04. Token prices are per million tokens. A
 *  model missing here is charged the conservative defaults below. */
export interface CloudflarePrice {
  inputPerM?: number;
  outputPerM?: number;
  perRequest?: number;
  perStep?: number;
  perTile?: number;
  perAudioMinute?: number;
  per1kChars?: number;
}

export const CLOUDFLARE_PRICES: Record<string, CloudflarePrice> = {
  '@cf/ai4bharat/indictrans2-en-indic-1B': { inputPerM: 0.342, outputPerM: 0.342 },
  '@cf/aisingapore/gemma-sea-lion-v4-27b-it': { inputPerM: 0.351, outputPerM: 0.555 },
  '@cf/baai/bge-base-en-v1.5': { inputPerM: 0.0666 },
  '@cf/baai/bge-large-en-v1.5': { inputPerM: 0.204 },
  '@cf/baai/bge-m3': { inputPerM: 0.0118 },
  '@cf/baai/bge-reranker-base': { inputPerM: 0.00311 },
  '@cf/baai/bge-small-en-v1.5': { inputPerM: 0.0202 },
  '@cf/bytedance/stable-diffusion-xl-lightning': { perStep: 0 },
  '@cf/cloudflare/clairic': { inputPerM: 0.1 },
  '@cf/cloudflare/clef': { inputPerM: 0.24 },
  '@cf/cloudflare/clef-flash': { inputPerM: 0.038 },
  '@cf/cloudflare/clef-omni': { inputPerM: 0.15 },
  '@cf/deepgram/aura-1': { per1kChars: 0.015 },
  '@cf/deepgram/aura-2-en': { per1kChars: 0.03 },
  '@cf/deepgram/aura-2-es': { per1kChars: 0.03 },
  '@cf/deepgram/nova-3': { perAudioMinute: 0.0052 },
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { inputPerM: 0.497, outputPerM: 4.881 },
  '@cf/deepseek-ai/deepseek-v4-flash-0731': { inputPerM: 0.44, outputPerM: 1.32 },
  '@cf/deepseek-ai/deepseek-v4-pro-0813': { inputPerM: 1.32, outputPerM: 3.96 },
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017': { inputPerM: 0.3, outputPerM: 1.2 },
  '@cf/google/gemma-4-26b-a4b-it': { inputPerM: 0.1, outputPerM: 0.3 },
  '@cf/huggingface/distilbert-sst-2-int8': { inputPerM: 0.0263 },
  '@cf/leonardo/lucid-origin': { perTile: 0.007, perStep: 0.000132 },
  '@cf/leonardo/phoenix-1.0': { perTile: 0.00583, perStep: 0.00011 },
  '@cf/meta/llama-3.1-8b-instruct-fp8': { inputPerM: 0.152, outputPerM: 0.287 },
  '@cf/meta/llama-3.2-11b-vision-instruct': { inputPerM: 0.0485, outputPerM: 0.676 },
  '@cf/meta/llama-3.2-1b-instruct': { inputPerM: 0.027, outputPerM: 0.201 },
  '@cf/meta/llama-3.2-3b-instruct': { inputPerM: 0.0509, outputPerM: 0.335 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inputPerM: 0.293, outputPerM: 2.253 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { inputPerM: 0.27, outputPerM: 0.85 },
  '@cf/meta/llama-guard-3-8b': { inputPerM: 0.484, outputPerM: 0.03 },
  '@cf/meta/m2m100-1.2b': { inputPerM: 0.342, outputPerM: 0.342 },
  '@cf/microsoft/resnet-50': { perRequest: 2.51e-06 },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { inputPerM: 0.351, outputPerM: 0.555 },
  '@cf/moondream/moondream3.1-9B-A2B': { inputPerM: 0.3, outputPerM: 1 },
  '@cf/moonshotai/kimi-k2.6': { inputPerM: 0.95, outputPerM: 4 },
  '@cf/moonshotai/kimi-k2.7-code': { inputPerM: 0.95, outputPerM: 4 },
  '@cf/myshell-ai/melotts': { perAudioMinute: 0.000205 },
  '@cf/nvidia/nemotron-3-120b-a12b': { inputPerM: 0.5, outputPerM: 1.5 },
  '@cf/openai/gpt-oss-120b': { inputPerM: 0.35, outputPerM: 0.75 },
  '@cf/openai/gpt-oss-20b': { inputPerM: 0.2, outputPerM: 0.3 },
  '@cf/openai/whisper-large-v3-turbo': { perAudioMinute: 0.000513 },
  '@cf/pfnet/plamo-embedding-1b': { inputPerM: 0.0186 },
  '@cf/pipecat-ai/smart-turn-v2': { perAudioMinute: 0.000338 },
  '@cf/qwen/qwen2.5-coder-32b-instruct': { inputPerM: 0.66, outputPerM: 1 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { inputPerM: 0.0509, outputPerM: 0.335 },
  '@cf/qwen/qwen3-embedding-0.6b': { inputPerM: 0.0118 },
  '@cf/qwen/qwen3.8-27b': { inputPerM: 0.45, outputPerM: 3.2 },
  '@cf/qwen/qwq-32b': { inputPerM: 0.66, outputPerM: 1 },
  '@cf/runwayml/stable-diffusion-v1-5-inpainting': { perStep: 0 },
  '@cf/stabilityai/stable-diffusion-xl-base-1.0': { perStep: 0 },
  '@cf/zai-org/glm-4.7-flash': { inputPerM: 0.0605, outputPerM: 0.4 },
  '@cf/zai-org/glm-5.2': { inputPerM: 1.4, outputPerM: 4.4 },
  '@cf/zai-org/glm-5.3': { inputPerM: 1.4, outputPerM: 4.4 },
  '@cf/zai-org/glm-5.3-flash': { inputPerM: 0.15, outputPerM: 0.5 },
};

/** A model with no published price is charged like the dearest listed one. */
const UNKNOWN_TOKEN_PRICE: CloudflarePrice = { inputPerM: 1.4, outputPerM: 4.9 };
/** ...and an unpriced non-token call (an image, a clip) a flat 1,000 neurons. */
const UNKNOWN_CALL_NEURONS = 1_000;
/** Output guess for a chat call before this model has completed any today. */
const DEFAULT_OUTPUT_ESTIMATE = 1_024;
const DEFAULT_IMAGE_STEPS = 20;
const DEFAULT_IMAGE_TILES = 4; // 1024x1024
const DEFAULT_AUDIO_MINUTES = 1;

/** What a Cloudflare call used (or is expected to use). */
export interface NeuronUsage {
  inputTokens?: number;
  outputTokens?: number;
  steps?: number;
  tiles?: number;
  audioMinutes?: number;
  characters?: number;
}

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Neurons Cloudflare charges for `usage` on `modelId`. */
export function neuronsFor(modelId: string, usage: NeuronUsage): number {
  const listed = CLOUDFLARE_PRICES[modelId];
  const hasTokens = n(usage.inputTokens) > 0 || n(usage.outputTokens) > 0;
  if (!listed && !hasTokens) return UNKNOWN_CALL_NEURONS;
  const price = listed ?? UNKNOWN_TOKEN_PRICE;
  let usd = 0;
  usd += (n(usage.inputTokens) / 1e6) * (price.inputPerM ?? 0);
  usd += (n(usage.outputTokens) / 1e6) * (price.outputPerM ?? 0);
  usd += price.perRequest ?? 0;
  if (price.perStep !== undefined) usd += (usage.steps ?? DEFAULT_IMAGE_STEPS) * price.perStep;
  if (price.perTile !== undefined) usd += (usage.tiles ?? DEFAULT_IMAGE_TILES) * price.perTile;
  if (price.perAudioMinute !== undefined) usd += (usage.audioMinutes ?? DEFAULT_AUDIO_MINUTES) * price.perAudioMinute;
  if (price.per1kChars !== undefined) usd += (n(usage.characters) / 1000) * price.per1kChars;
  return usd * NEURONS_PER_USD;
}

function generatesTokens(modelId: string): boolean {
  const listed = CLOUDFLARE_PRICES[modelId];
  return listed ? listed.outputPerM !== undefined : true;
}

// ── Cap ─────────────────────────────────────────────────────────────────────

/** The per-account daily neuron cap, or null when the operator turned it off. */
export function getCloudflareDailyNeuronCap(): number | null {
  const raw = process.env.CLOUDFLARE_DAILY_NEURON_CAP;
  if (raw !== undefined && raw.trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return v === 0 ? null : v;
  }
  return DEFAULT_CLOUDFLARE_DAILY_NEURON_CAP;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function msUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

// ── Ledger ──────────────────────────────────────────────────────────────────

const REMOTE_ROW = ''; // model_id of the row holding Cloudflare's own count

// The server always has its database open before it serves a request; only
// isolated provider unit tests call an adapter without one. The meter steps
// aside there instead of failing the call.
function ledgerReady(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

function charge(day: string, account: string, modelId: string, delta: {
  calls?: number; settled?: number; input?: number; output?: number; neurons?: number;
}): void {
  getDb().prepare(`
    INSERT INTO cloudflare_neuron_usage (day, account_id, model_id, calls, settled_calls, input_tokens, output_tokens, neurons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, account_id, model_id) DO UPDATE SET
      calls = calls + excluded.calls,
      settled_calls = settled_calls + excluded.settled_calls,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      neurons = MAX(0, neurons + excluded.neurons)
  `).run(day, account, modelId, delta.calls ?? 0, delta.settled ?? 0,
    Math.round(delta.input ?? 0), Math.round(delta.output ?? 0), delta.neurons ?? 0);
}

/** Neurons this install has charged the account today (estimates included). */
export function localNeuronsToday(account: string, now = Date.now()): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(neurons), 0) AS used FROM cloudflare_neuron_usage
     WHERE day = ? AND account_id = ? AND model_id <> ?
  `).get(utcDay(now), account, REMOTE_ROW) as { used: number };
  return row.used;
}

function remoteNeuronsToday(account: string, now: number): number | null {
  const row = getDb().prepare(`
    SELECT remote_neurons FROM cloudflare_neuron_usage WHERE day = ? AND account_id = ? AND model_id = ?
  `).get(utcDay(now), account, REMOTE_ROW) as { remote_neurons: number | null } | undefined;
  return row?.remote_neurons ?? null;
}

/** Neurons the account has used today: the higher of our ledger and Cloudflare's own count. */
export function cloudflareNeuronsUsedToday(account: string, now = Date.now()): number {
  return Math.max(localNeuronsToday(account, now), remoteNeuronsToday(account, now) ?? 0);
}

function averageOutputTokens(day: string, account: string, modelId: string): number | null {
  const row = getDb().prepare(`
    SELECT settled_calls, output_tokens FROM cloudflare_neuron_usage
     WHERE day = ? AND account_id = ? AND model_id = ?
  `).get(day, account, modelId) as { settled_calls: number; output_tokens: number } | undefined;
  if (!row || row.settled_calls < 3) return null;
  return row.output_tokens / row.settled_calls;
}

let lastPruneDay = '';
function pruneOldRows(now: number): void {
  const day = utcDay(now);
  if (day === lastPruneDay) return;
  lastPruneDay = day;
  getDb().prepare('DELETE FROM cloudflare_neuron_usage WHERE day < ?').run(utcDay(now - 60 * 86_400_000));
}

// ── Gate ────────────────────────────────────────────────────────────────────

export interface CloudflareNeuronStatus {
  used: number;
  cap: number | null;
  remote: number | null;
  resetsAt: string;
}

export function cloudflareNeuronStatus(apiKey: string, now = Date.now()): CloudflareNeuronStatus | null {
  const account = cloudflareAccountId(apiKey);
  if (!account) return null;
  return {
    used: Math.round(cloudflareNeuronsUsedToday(account, now)),
    cap: getCloudflareDailyNeuronCap(),
    remote: remoteNeuronsToday(account, now),
    resetsAt: new Date(now + msUntilUtcMidnight(now)).toISOString(),
  };
}

/** False once the key's account has reached today's neuron cap. */
export function cloudflareNeuronsAvailable(apiKey: string, now = Date.now()): boolean {
  const cap = getCloudflareDailyNeuronCap();
  if (cap === null) return true;
  const account = cloudflareAccountId(apiKey);
  if (!account || !ledgerReady()) return true; // malformed key: the provider rejects it anyway
  maybeRefreshRemote(apiKey, account, now);
  return cloudflareNeuronsUsedToday(account, now) < cap;
}

export class CloudflareNeuronCapError extends Error {
  readonly status = 429;
  readonly retryAfterSec: number;
  constructor(used: number, cap: number, now: number) {
    super(
      `Cloudflare API error 429: daily free allocation of neurons used up for this account `
      + `(FreeLLMAPI meter: ${Math.round(used)} of ${cap} neurons today, resets 00:00 UTC). `
      + 'Workers Paid would bill the overage, so FreeLLMAPI stops here; set CLOUDFLARE_DAILY_NEURON_CAP=0 to allow paid usage.',
    );
    this.name = 'CloudflareNeuronCapError';
    this.retryAfterSec = Math.ceil(msUntilUtcMidnight(now) / 1000);
  }
}

// ── Metering ────────────────────────────────────────────────────────────────

export interface CloudflareCallEstimate extends NeuronUsage {
  /** The request's max_tokens, when the client sent one. Bounds the output guess. */
  maxOutputTokens?: number;
}

export interface CloudflareNeuronCall {
  /** The call completed: replace the estimate with what it really used. Pass
   *  null when the real usage is unknown (the estimate stays). */
  settle(actual: NeuronUsage | null): void;
  /** The call was cut short: charge what it used so far, but never less than
   *  the estimate (Cloudflare may have kept generating after we hung up). */
  settleAtLeast(partial: NeuronUsage): void;
  /** Cloudflare refused the call before running it (an HTTP error answer):
   *  nothing was billed, so take the estimate back. */
  refund(): void;
}

const NOOP_CALL: CloudflareNeuronCall = { settle() {}, settleAtLeast() {}, refund() {} };

/**
 * Charge a Cloudflare call's estimated neurons before it is dispatched. Throws
 * CloudflareNeuronCapError when the account has no room left today (and
 * benches the account until midnight UTC so the router stops offering it).
 */
export function startCloudflareCall(
  apiKey: string,
  modelId: string,
  estimate: CloudflareCallEstimate,
  now = Date.now(),
): CloudflareNeuronCall {
  const account = cloudflareAccountId(apiKey);
  if (!account || !ledgerReady()) return NOOP_CALL;
  const day = utcDay(now);
  pruneOldRows(now);

  const usage: NeuronUsage = { ...estimate };
  if (generatesTokens(modelId) && estimate.outputTokens === undefined) {
    const max = n(estimate.maxOutputTokens) || Infinity;
    usage.outputTokens = Math.min(averageOutputTokens(day, account, modelId) ?? DEFAULT_OUTPUT_ESTIMATE, max);
  }
  const estimated = neuronsFor(modelId, usage);

  const cap = getCloudflareDailyNeuronCap();
  if (cap !== null) {
    maybeRefreshRemote(apiKey, account, now);
    const used = cloudflareNeuronsUsedToday(account, now);
    if (used + estimated > cap) {
      benchCloudflareAccountId(account, msUntilUtcMidnight(now), 'authoritative');
      throw new CloudflareNeuronCapError(used, cap, now);
    }
  }

  charge(day, account, modelId, { calls: 1, neurons: estimated });
  let done = false;
  return {
    settle(actual) {
      if (done) return;
      done = true;
      if (!actual) return;
      const real = neuronsFor(modelId, actual);
      charge(day, account, modelId, {
        settled: 1, input: n(actual.inputTokens), output: n(actual.outputTokens), neurons: real - estimated,
      });
    },
    settleAtLeast(partial) {
      if (done) return;
      done = true;
      const real = neuronsFor(modelId, partial);
      if (real > estimated) charge(day, account, modelId, { neurons: real - estimated });
    },
    refund() {
      if (done) return;
      done = true;
      charge(day, account, modelId, { neurons: -estimated });
    },
  };
}

// ── Cloudflare's own count (best effort) ────────────────────────────────────

const REMOTE_REFRESH_MS = 5 * 60_000;
const REMOTE_BACKOFF_MS = 6 * 60 * 60_000;
const remoteNextCheck = new Map<string, number>();
const remoteInFlight = new Set<string>();

function remoteAnalyticsEnabled(): boolean {
  return process.env.CLOUDFLARE_NEURON_ANALYTICS !== '0';
}

function maybeRefreshRemote(apiKey: string, account: string, now: number): void {
  if (!remoteAnalyticsEnabled() || remoteInFlight.has(account)) return;
  if ((remoteNextCheck.get(account) ?? 0) > now) return;
  remoteNextCheck.set(account, now + REMOTE_REFRESH_MS);
  remoteInFlight.add(account);
  void refreshRemoteNeurons(apiKey, now)
    .catch(() => undefined)
    .finally(() => remoteInFlight.delete(account));
}

/**
 * Ask Cloudflare's GraphQL analytics how many neurons the account used today
 * and store it. Needs the token's "Account Analytics: Read" permission; a
 * token without it is left alone for six hours. Returns the count, or null.
 */
export async function refreshRemoteNeurons(apiKey: string, now = Date.now()): Promise<number | null> {
  const account = cloudflareAccountId(apiKey);
  const token = apiKey.slice(apiKey.indexOf(':') + 1);
  if (!account || !token) return null;
  const day = utcDay(now);
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:1,filter:{date:$d}){sum{totalNeurons}}}}}',
        variables: { a: account, d: day },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => null) as {
      data?: { viewer?: { accounts?: { aiInferenceAdaptiveGroups?: { sum?: { totalNeurons?: number } }[] }[] } };
      errors?: unknown[] | null;
    } | null;
    const groups = json?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
    if (!res.ok || (json?.errors && json.errors.length > 0) || !Array.isArray(groups)) {
      remoteNextCheck.set(account, now + REMOTE_BACKOFF_MS);
      return null;
    }
    const total = n(groups[0]?.sum?.totalNeurons);
    getDb().prepare(`
      INSERT INTO cloudflare_neuron_usage (day, account_id, model_id, remote_neurons, remote_checked_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, account_id, model_id) DO UPDATE SET
        remote_neurons = excluded.remote_neurons,
        remote_checked_at_ms = excluded.remote_checked_at_ms
    `).run(day, account, REMOTE_ROW, total, now);
    return total;
  } catch {
    remoteNextCheck.set(account, now + REMOTE_REFRESH_MS);
    return null;
  }
}

/** Test hook: forget remote-check timers. */
export function resetCloudflareNeuronMeter(): void {
  remoteNextCheck.clear();
  remoteInFlight.clear();
  lastPruneDay = '';
}

/**
 * Run one Cloudflare call under the meter: charge the estimate, refund it when
 * Cloudflare answered with an HTTP error (nothing ran), keep it when the call
 * died without an answer (timeout, transport: Cloudflare may still bill), and
 * settle on `actualOf(result)` when it completed. `wrapCapError` turns the
 * meter's own refusal into the caller's error type so its usual 429 handling
 * (cooldown, next key) applies.
 */
export async function meterCloudflare<T>(
  apiKey: string,
  modelId: string,
  estimate: CloudflareCallEstimate,
  run: () => Promise<T>,
  actualOf: (result: T) => NeuronUsage | null,
  wrapCapError?: (err: CloudflareNeuronCapError) => Error,
): Promise<T> {
  let call: CloudflareNeuronCall;
  try {
    call = startCloudflareCall(apiKey, modelId, estimate);
  } catch (e) {
    if (e instanceof CloudflareNeuronCapError && wrapCapError) throw wrapCapError(e);
    throw e;
  }
  let result: T;
  try {
    result = await run();
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) call.refund();
    else call.settle(null);
    throw e;
  }
  call.settle(actualOf(result));
  return result;
}

/** ~4 characters a token, the same rough count the router uses. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
