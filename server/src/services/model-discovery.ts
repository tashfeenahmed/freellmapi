import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { isAbortLikeError } from '../lib/error-classify.js';
import type { ChatCompletionResponse, ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';

// ── Model discovery on a user's own custom endpoint (#488) ──────────────────
//
// Relay services add and drop models weekly, so registering them by hand from a
// `curl .../v1/models | jq` goes stale immediately. This asks the operator's
// OWN endpoint, with the operator's OWN key, what it currently serves.
//
// Scope: this reads one user-configured base_url. It does not read, refresh or
// publish the provider catalog — nothing here touches catalog sync.
//
// Everything in here assumes the upstream is hostile-by-accident: relays are
// wildly inconsistent about the /models envelope, some answer HTML, and a
// misconfigured base_url can point at something that streams forever. So: cap
// the body, cap the list, accept every envelope we've actually seen, and turn
// any surprise into a clean error instead of a 500.

/** Hard cap on the catalog body we will read. The largest real OpenAI-style
 *  catalog (OpenRouter, ~400 models with metadata) is well under 1 MB. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** Hard cap on how many ids we hand back — a checkbox list, not a data dump. */
export const MAX_DISCOVERED_MODELS = 500;

/** Ids longer than this are certainly not model ids; skip rather than store. */
const MAX_MODEL_ID_LENGTH = 256;

/** What a discovered model IS, when it discernibly isn't a chat model (#1051).
 *  Absent means "chat as far as anyone can tell" — the field is emitted only
 *  when a non-chat kind is detected, so plain chat rows keep their shape. */
export type DiscoveredModelKind = 'embedding' | 'image' | 'audio' | 'transcription' | 'video';

export interface DiscoveredModel {
  id: string;
  ownedBy: string | null;
  /** Approximate context window in tokens when the upstream advertises one
   *  (OpenRouter's context_length, Ollama's ctx_len, max_model_len, ...). */
  contextWindow?: number;
  /** Human-readable price hint ("free", "$1.25/M in $2/M out") when the
   *  upstream ships one — normalized to USD per MILLION tokens (#685). */
  priceNote?: string;
  /** True when every price component the upstream advertises is zero, or it
   *  plainly says "free". Set only alongside priceNote, and the only thing the
   *  picker badges green — the note itself is never pattern-matched. */
  isFree?: boolean;
  /** True when the upstream advertises image input (modalities/vision). */
  vision?: boolean;
  /** Present only when the model is discernibly NOT a chat model (#1051). */
  kind?: DiscoveredModelKind;
}

/** Carries the HTTP status the route should answer with, so a relay's 401 stays
 *  a 401 and an unreachable box reads as a gateway problem. */
export class ModelDiscoveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
    this.status = status;
  }
}

// Envelope keys seen in the wild: OpenAI/most relays use `data`, Ollama and a
// few gateways use `models`, some wrap the list one level deeper.
const LIST_KEYS = ['data', 'models', 'result', 'results', 'items'] as const;
// Id aliases: `id` (OpenAI), `name`/`model` (Ollama), plus the snake/camel and
// slug spellings assorted relays ship.
const ID_KEYS = ['id', 'name', 'model', 'model_id', 'modelId', 'slug'] as const;
const OWNER_KEYS = ['owned_by', 'ownedBy', 'organization', 'owner', 'provider', 'publisher'] as const;
// Context-window spellings seen on OpenAI-style /models (OpenRouter), Ollama
// /api/tags (ctx_len), and assorted relays. Only present on some envelopes;
// absent means "unknown", which the picker renders as nothing.
const CONTEXT_KEYS = ['context_length', 'context_window', 'max_model_len', 'max_context_length', 'max_context_tokens', 'ctx_len', 'contextWindow'] as const;
// Price hint spellings: OpenRouter nests { prompt, completion }, others ship a
// plain string. Absent means "unknown price".
const PRICE_KEYS = ['price', 'pricing'] as const;
const VISION_KEYS = ['vision', 'supports_vision', 'supportsVision', 'image_input', 'multimodal'] as const;
// Modality spellings. OpenRouter keeps the real signal one level down, under
// `architecture`, as an ["text","image"] array AND as a "text+image->text"
// string; flatter relays put an array at the top level.
const MODALITY_KEYS = ['modalities', 'input_modalities', 'inputModalities', 'modality'] as const;
// A modality entry (or a substring of the modality string) that means images.
const VISION_MODALITIES = ['image', 'vision', 'image-input'] as const;
// #1051: some OpenAI-compatible upstreams (SiliconFlow among them) answer
// /v1/models with entries that carry an id and nothing else, so visionOf finds
// no signal at all and a VL model is indistinguishable from a chat one. These
// id markers are the last resort. They are matched per token (the id split on
// non-alphanumerics), never as a substring, so a relay that ships `vllm` in an
// id cannot read as `vl`.
const VISION_ID_MARKERS = ['llava', 'internvl', 'pixtral', 'moondream', 'cogvlm', 'vision'] as const;
// A price hint sits in a chip next to the model id, so a chatty relay must not
// be able to squeeze the id out of the row.
const MAX_PRICE_NOTE_LENGTH = 40;
// Below a cent per unit the figure can only be per-token (OpenRouter quotes
// "0.00000125"); at or above it the relay already quoted per million.
const PER_TOKEN_CEILING = 0.01;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The model array inside whatever envelope this relay chose. Descends at most
 *  one nesting level ({ data: { models: [...] } }) before giving up. */
function findModelArray(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of LIST_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (depth < 1 && asRecord(value)) {
      const nested = findModelArray(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** One price component in USD per MILLION tokens, or null when the upstream
 *  did not ship a usable figure. OpenRouter quotes strings ("0.00000125"),
 *  others quote numbers, and a few already quote per-million — so parse
 *  string-or-number and scale by magnitude rather than by source. */
function perMillionTokens(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim().length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value > 0 && value < PER_TOKEN_CEILING ? value * 1_000_000 : value;
}

/** A tidy USD figure: at most four decimals, and no `1.2500000000000002`
 *  float noise from the per-token scaling. */
function formatUsd(value: number): string {
  return `$${Number(value.toFixed(4))}`;
}

function capNote(note: string): string {
  return note.length > MAX_PRICE_NOTE_LENGTH
    ? `${note.slice(0, MAX_PRICE_NOTE_LENGTH - 1).trimEnd()}…`
    : note;
}

/** Price hint out of OpenRouter-style `pricing: { prompt, completion }` or a
 *  plain `price: "free"` string, plus the free/not-free verdict the picker
 *  badges on. Anything unrecognizable is left alone — no chip at all. */
function priceHintOf(record: Record<string, unknown>): { note: string; isFree: boolean } | undefined {
  for (const key of PRICE_KEYS) {
    const value = record[key];
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length === 0) continue;
      // Only the literal word counts as free — never a pattern over the note,
      // which is how "$10/M in" ends up painted green.
      if (text.toLowerCase() === 'free') return { note: 'free', isFree: true };
      return { note: capNote(text), isFree: false };
    }
    const pricing = asRecord(value);
    if (!pricing) continue;
    const prompt = perMillionTokens(pricing.prompt);
    const completion = perMillionTokens(pricing.completion);
    if (prompt === null && completion === null) continue;
    // OpenRouter's ":free" slugs ship a flat {"prompt":"0","completion":"0"}.
    if ((prompt ?? 0) === 0 && (completion ?? 0) === 0) return { note: 'free', isFree: true };
    const parts: string[] = [];
    if (prompt) parts.push(`${formatUsd(prompt)}/M in`);
    if (completion) parts.push(`${formatUsd(completion)}/M out`);
    return { note: capNote(parts.join(' ')), isFree: false };
  }
  return undefined;
}

/** Image input out of a modality array (["text", "image"]) or a modality
 *  string ("text+image->text", where only the input side counts). */
function modalityVision(record: Record<string, unknown>): boolean | undefined {
  for (const key of MODALITY_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.some(m => (VISION_MODALITIES as readonly string[]).includes(String(m).toLowerCase()));
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const input = value.toLowerCase().split('->')[0];
      return VISION_MODALITIES.some(modality => input.includes(modality));
    }
  }
  return undefined;
}

/** Vision support: a boolean `vision`/`multimodal` flag, an OpenAI-style
 *  `modalities: ["text", "image"]`, or OpenRouter's `architecture` object one
 *  level down. Absent is "unknown" (no badge). */
function visionOf(record: Record<string, unknown>): boolean | undefined {
  for (const key of VISION_KEYS) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  const top = modalityVision(record);
  if (top !== undefined) return top;
  const architecture = asRecord(record['architecture']);
  return architecture ? modalityVision(architecture) : undefined;
}

/** Vision read off the model id, for upstreams that advertise no modality
 *  metadata whatsoever (#1051). Returns true or undefined and never false: a
 *  missing marker is not evidence that a model lacks vision, and a false here
 *  would stamp `vision: false` onto every bare `{ id }` entry. */
function visionFromId(id: string): true | undefined {
  for (const token of id.toLowerCase().split(/[^a-z0-9]+/)) {
    // `vl`/`vlm` plus the version digits some ids carry (`vl2`), anchored to a
    // whole token so `vllm` and `vlab` stay out.
    if (/^vlm?\d*$/.test(token)) return true;
    if (VISION_ID_MARKERS.some(marker => token.includes(marker))) return true;
  }
  return undefined;
}

// #1051, the non-vision half: an upstream that answers with bare ids gives us
// no `object`/`type` to read (SiliconFlow ships none at all), so a diffusion,
// whisper or video model registers as a chat model and then 404s forever. The
// id is the only signal left. Same rules as VISION_ID_MARKERS: matched per
// token (the id split on non-alphanumerics), never as a raw substring, so
// `sdk`, `tootsie` or `pastta` can't smuggle a kind in. Chat is the default —
// classifyModelId returns undefined unless a marker is unambiguous, because a
// wrong "media" verdict makes a working chat model unreachable, which is worse
// than the status quo.
const KIND_ID_MARKERS: ReadonlyArray<readonly [DiscoveredModelKind, RegExp]> = [
  // Embedding first: "embedding" ids sometimes also carry family tokens.
  ['embedding', /^embed(ding)?s?$/],
  ['embedding', /^bge$/],
  // Speech-to-text families.
  ['transcription', /^whisper$/],
  ['transcription', /^(asr|stt)$/],
  ['transcription', /^transcri(be|ption)$/],
  ['transcription', /^sensevoice(small|large)?$/],
  ['transcription', /^voxtral$/],
  // Text-to-speech families.
  ['audio', /^tts$/],
  ['audio', /^cosyvoice\d*$/],
  // Video generation: Wan2.2's own tokens (`wan2`, `t2v`, `i2v`) plus ids that
  // simply say video (HunyuanVideo, LTX-Video, ...).
  ['video', /^wan\d*$/],
  ['video', /^[ti]2v$/],
  ['video', /video/],
  // Image generation: diffusion/SD/FLUX/DALL-E/Kolors families. `sd` only as a
  // whole token with optional xl/digits (sd3, sdxl, sd35) so `sdk` stays out.
  ['image', /^diffusion$/],
  ['image', /^sd(xl)?\d*$/],
  ['image', /^flux$/],
  ['image', /^dall-?e?\d*$/],
  ['image', /^dalle\d*$/],
  ['image', /^kolors$/],
  ['image', /^imagen\d*$/],
  ['image', /^photomaker(v\d+)?$/],
];

// Upstream type metadata beats the id when it exists: a few relays ship a
// `type`/`task`/`object` per entry ("embedding", "text-to-image", ...). OpenAI's
// own `object: "model"` says nothing and maps to undefined here.
const KIND_METADATA_KEYS = ['type', 'task', 'object', 'model_type', 'modelType'] as const;
const KIND_METADATA_VALUES: ReadonlyArray<readonly [DiscoveredModelKind, RegExp]> = [
  ['embedding', /embedding/],
  ['transcription', /(speech-?to-?text|transcri|asr\b|\bstt\b)/],
  ['audio', /(text-?to-?speech|\btts\b|speech-?synthesis)/],
  ['video', /video/],
  ['image', /(text-?to-?image|image-?generation|diffusion)/],
];

/** The model's kind read off its id, for upstreams that advertise no usable
 *  type metadata (#1051). Returns a kind or undefined and never 'chat': absence
 *  of a marker is not evidence of anything, and chat stays the default. */
export function classifyModelId(id: string): DiscoveredModelKind | undefined {
  for (const token of id.toLowerCase().split(/[^a-z0-9]+/)) {
    for (const [kind, pattern] of KIND_ID_MARKERS) {
      if (pattern.test(token)) return kind;
    }
  }
  return undefined;
}

function kindFromMetadata(record: Record<string, unknown>): DiscoveredModelKind | undefined {
  for (const key of KIND_METADATA_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'model') continue;
    for (const [kind, pattern] of KIND_METADATA_VALUES) {
      if (pattern.test(normalized)) return kind;
    }
  }
  return undefined;
}

function toDiscovered(entry: unknown): DiscoveredModel | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id) return null;
    const bare: DiscoveredModel = { id, ownedBy: null };
    const bareVision = visionFromId(id);
    if (bareVision !== undefined) bare.vision = bareVision;
    if (bareVision !== true) {
      const bareKind = classifyModelId(id);
      if (bareKind !== undefined) bare.kind = bareKind;
    }
    return bare;
  }
  const record = asRecord(entry);
  if (!record) return null;
  const id = firstString(record, ID_KEYS);
  if (!id) return null;

  const model: DiscoveredModel = { id, ownedBy: firstString(record, OWNER_KEYS) };
  // Optional detail fields are only set when the upstream actually advertises
  // them, so a minimal `{ data: [{ id }] }` envelope keeps an identical shape.
  const contextWindow = firstNumber(record, CONTEXT_KEYS);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const price = priceHintOf(record);
  if (price !== undefined) {
    model.priceNote = price.note;
    model.isFree = price.isFree;
  }
  // `??` not `||`: an upstream that explicitly says false keeps saying false.
  const vision = visionOf(record) ?? visionFromId(id);
  if (vision !== undefined) model.vision = vision;
  // Metadata wins over the id; a vision verdict wins over both — a VL model is
  // a chat model that sees, not a media model (#1051).
  if (vision !== true) {
    const kind = kindFromMetadata(record) ?? classifyModelId(id);
    if (kind !== undefined) model.kind = kind;
  }
  return model;
}

/** Whether this payload carries a model list at all — the difference between
 *  an endpoint that genuinely serves nothing and one whose answer we can't
 *  read (an HTML error page, a login redirect, a bare error object). */
export function hasModelList(payload: unknown): boolean {
  return findModelArray(payload) !== null;
}

/**
 * Model ids out of any /models envelope we recognize, deduped, sorted and
 * capped. Returns an empty list for a payload with no list in it — the caller
 * decides whether that's an error worth surfacing.
 */
export function parseModelCatalog(payload: unknown): DiscoveredModel[] {
  const entries = findModelArray(payload);
  if (!entries) return [];

  const byId = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    const model = toDiscovered(entry);
    if (!model || model.id.length > MAX_MODEL_ID_LENGTH) continue;
    if (!byId.has(model.id)) byId.set(model.id, model);
  }

  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_DISCOVERED_MODELS);
}

/**
 * Read a response body with a hard byte cap. A declared Content-Length over the
 * cap is refused without reading anything; otherwise the stream is abandoned
 * the moment it runs past the cap, so a base_url pointed at something that
 * never stops can't take the process with it.
 */
export async function readCappedBody(res: Response, maxBytes = MAX_CATALOG_BYTES): Promise<string> {
  const tooLarge = () => new ModelDiscoveryError(
    502, `The endpoint's model list is larger than ${Math.round(maxBytes / 1024)} KB — refusing to read it.`,
  );

  const declared = Number(res.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/** The provider's own error text, when it bothered to send one. */
function upstreamMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = asRecord(parsed.error);
    const detail = [
      typeof error?.message === 'string' ? error.message : null,
      typeof parsed.message === 'string' ? parsed.message : null,
      typeof parsed.detail === 'string' ? parsed.detail : null,
      typeof parsed.error === 'string' ? parsed.error : null,
    ].find(value => typeof value === 'string' && value.trim().length > 0);
    return detail ? detail.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * Ask a custom OpenAI-compatible endpoint what it serves. Reuses the provider
 * adapter's own catalog fetch (auth header, proxy, timeout, quota bookkeeping)
 * rather than re-implementing an HTTP call here.
 */
export async function discoverEndpointModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const provider = new OpenAICompatProvider({
    platform: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl,
    // Discovery is interactive — the operator is watching a spinner — so don't
    // inherit the 120s custom-provider chat timeout.
    timeoutMs: 30_000,
  });

  let res: Response;
  try {
    res = await provider.fetchModelCatalog(apiKey);
  } catch (err) {
    const reason = isAbortLikeError(err) ? 'timed out' : ((err as Error)?.message ?? 'unknown error');
    throw new ModelDiscoveryError(502, `Could not reach ${baseUrl}/models: ${reason}`);
  }

  const bodyText = await readCappedBody(res);

  if (!res.ok) {
    const detail = upstreamMessage(bodyText);
    if (res.status === 401 || res.status === 403) {
      throw new ModelDiscoveryError(401, `The endpoint rejected the key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    throw new ModelDiscoveryError(502, `${baseUrl}/models returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new ModelDiscoveryError(502, `${baseUrl}/models did not return a model list (response was not JSON).`);
  }

  // An endpoint that genuinely serves nothing answers `{"data": []}` and that
  // is a valid (if disappointing) result; an unreadable envelope is an error.
  if (!hasModelList(payload)) {
    throw new ModelDiscoveryError(502, `${baseUrl}/models did not return a model list in a format this gateway understands.`);
  }
  return parseModelCatalog(payload);
}

/** Output cap on the probe request. Exported so the test can assert the floor
 *  rather than a magic number. See the call site for why it is not 1. */
export const PROBE_MAX_TOKENS = 4;

/** Result of a capability probe (#874, phase 1). The `ping` latency/sample
 *  fields are unchanged from the original probe; `reasoning` and `toolCalls`
 *  are OPTIONAL additions so a client reading only `{ modelId, latencyMs }`
 *  keeps working (backward compatible). A probe that answers `ping` but then
 *  errors on a capability probe leaves that capability undefined — the caller
 *  only writes `supports_tools` when `toolCalls === true`. */
export interface ProbeCapabilities {
  /** True when the reasoning probe's answer contained the expected token;
   *  false when it answered something else; undefined when the probe errored
   *  or timed out (unknown). */
  reasoning?: boolean;
  /** True when the tool probe returned `finish_reason: 'tool_calls'`; false
   *  when it finished some other way; undefined when the probe errored or
   *  timed out (unknown). */
  toolCalls?: boolean;
}

export interface ProbeEndpointModelResult extends ProbeCapabilities {
  modelId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Fire one minimal real chat request at a custom endpoint to measure latency
 * and confirm the key works end-to-end ("probe now", #685 follow-up). When the
 * caller already knows which model to probe (a model registered on this
 * endpoint — the one whose bandit stats the sample feeds), it passes
 * `preferredModelId` and the discovery round-trip is skipped entirely; only an
 * endpoint with nothing registered falls back to discovering a model id.
 *
 * Phase 1 (#874): after the `ping` latency probe succeeds, two extra probes
 * fire while the operator is still watching — a deterministic reasoning probe
 * and a tool-call probe. These are best-effort: a capability probe that errors
 * or times out simply leaves that capability flag unset, so a flaky relay can
 * still clear a cooldown and record a success sample from the `ping`. Only a
 * capability probe that returns positive evidence sets its flag.
 *
 * Returns the probed model id, the round-trip latency and the token counts so
 * the caller can write a stats row; throws ModelDiscoveryError with a clean
 * message on any failure (the caller must NOT record a sample then).
 */
export async function probeEndpointModel(
  baseUrl: string,
  apiKey: string,
  preferredModelId?: string | null,
): Promise<ProbeEndpointModelResult> {
  let modelId = preferredModelId?.trim() || null;
  if (!modelId) {
    const discovered = await discoverEndpointModels(baseUrl, apiKey);
    if (discovered.length === 0) {
      throw new ModelDiscoveryError(502, 'The endpoint returned no models to probe.');
    }
    modelId = discovered[0].id;
  }

  const provider = new OpenAICompatProvider({
    platform: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl,
    // Interactive: the operator is watching, so a bounded timeout beats the
    // 120s custom-provider chat default.
    timeoutMs: 30_000,
  });

  const startedAt = Date.now();
  let response: ChatCompletionResponse;
  try {
    response = await provider.chatCompletion(
      apiKey,
      [{ role: 'user', content: 'ping' }],
      modelId,
      // Not 1: several relays enforce a floor above it and 400 the probe
      // outright ("max_tokens must be greater than 2" on b.ai's
      // deepseek-v4-flash, #903), so a probe that only wanted to measure
      // latency reported the endpoint as broken. 4 clears the floors seen so
      // far and still costs a rounding error.
      { max_tokens: PROBE_MAX_TOKENS },
    );
  } catch (err) {
    const reason = isAbortLikeError(err) ? 'timed out' : ((err as Error)?.message ?? 'unknown error');
    throw new ModelDiscoveryError(502, `Probe request to ${modelId} failed: ${reason}`);
  }
  // Stop the clock HERE. `latencyMs` is the endpoint's per-request round trip
  // — it feeds the bandit's speed axis and the operator's toast — so it must
  // measure the ping alone. Reading it after the capability probes below would
  // report the sum of three round trips and make every probed endpoint look
  // roughly three times slower than it is.
  const latencyMs = Date.now() - startedAt;

  // Phase 1 (#874): the ping only proved the key works and the model answers.
  // Fire two extra best-effort probes — reasoning + tool calls — so the
  // operator gets a capability snapshot on the same "probe now" click. Neither
  // can fail the whole probe: the ping's success is the sample-of-record, and a
  // relay that 500s on tools but answers chat still gets its cooldown lifted.
  const capabilities = await probeModelCapabilities(provider, apiKey, modelId).catch(() => {
    // A capability probe that throws (timeout, non-OpenAI error, …) is not a
    // probe failure — the ping already succeeded. Swallow and leave flags unset.
    return {} as ProbeCapabilities;
  });

  return {
    modelId,
    latencyMs,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    ...capabilities,
  };
}

// ── Capability probes (#874, phase 1) ─────────────────────────────────────
//
// Two focused probes run after the ping, while the operator is still watching
// the probe spinner. Neither writes a `requests` row — the ping is the
// sample-of-record — and neither can fail the probe: the ping already proved
// the key works, and a relay that 500s on tools but answers chat still deserves
// its cooldown lifted. Only POSITIVE evidence sets a flag (the "only write
// success samples" philosophy), so `supports_tools` is written back to the
// models row only when the tool probe returns `finish_reason: 'tool_calls'`.

/** A deterministic arithmetic probe: the answer is always 63, so a correct
 *  reply is strong evidence the model actually reasons (not that it echoed the
 *  prompt). The `63` substring check tolerates " 63" / "63." / "sixty-three"
 *  misspellings only insofar as the digits appear; we keep it deliberately
 *  loose because relays wrap answers in markdown/formats. */
const REASONING_PROBE_PROMPT = 'What is 9*7? Reply with just the number.';
const REASONING_PROBE_ANSWER_TOKEN = '63';

/** The tool probe's dummy function: an empty-parameter `get_weather`. We send
 *  `tool_choice: 'auto'` (not `'required'`) so the test is "does the model
 *  CHOOSE to call a tool when one is offered" — the same signal the router
 *  relies on when filtering tool-capable models. */
const TOOL_PROBE: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city to get weather for.' },
      },
      required: ['city'],
    },
  },
};

/**
 * Run the reasoning and tool-call capability probes against a model (#874,
 * phase 1). Best-effort: a probe that errors leaves its flag unset rather than
 * throwing — the caller treats "unset" as "unknown" and only writes
 * `supports_tools` on a positive `toolCalls`.
 *
 * Exposed separately so a future caller can run capability probes without the
 * ping (or reuse the probe set under a different transport). The current probe
 * chain calls this from `probeEndpointModel`.
 */
export async function probeModelCapabilities(
  provider: OpenAICompatProvider,
  apiKey: string,
  modelId: string,
): Promise<ProbeCapabilities> {
  // Reasoning probe: a deterministic arithmetic puzzle. A reply containing the
  // expected answer token is counted as "reasons". We allow a little headroom
  // (max_tokens 16) so the model can emit "63" without being cut off mid-number.
  // `undefined` is the honest starting value: it means "we did not find out".
  // Only a completed probe may downgrade it to `false`.
  let reasoning: boolean | undefined;
  try {
    const reasoningMessages: ChatMessage[] = [
      { role: 'user', content: REASONING_PROBE_PROMPT },
    ];
    const reasoningRes = await provider.chatCompletion(apiKey, reasoningMessages, modelId, {
      max_tokens: 16,
      temperature: 0,
    });
    const text = textOfCompletion(reasoningRes);
    reasoning = text.includes(REASONING_PROBE_ANSWER_TOKEN);
  } catch {
    // An error means "unknown", not "false" — leave it undefined so the caller
    // (and the UI) can tell "the model does not reason" apart from "the probe
    // never got an answer".
    reasoning = undefined;
  }

  // Tool probe: offer a dummy `get_weather` tool with `tool_choice: 'auto'` and
  // inspect `finish_reason`. A `tool_calls` finish is positive evidence the
  // model speaks the OpenAI tool-call protocol; anything else (stop, length,
  // content_filter, …) means "not via this protocol" and leaves the flag false.
  let toolCalls: boolean | undefined;
  try {
    const toolMessages: ChatMessage[] = [
      { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' },
    ];
    const toolRes = await provider.chatCompletion(apiKey, toolMessages, modelId, {
      max_tokens: 64,
      temperature: 0,
      tools: [TOOL_PROBE],
      tool_choice: 'auto',
    });
    const finishReason = toolRes.choices?.[0]?.finish_reason;
    toolCalls = finishReason === 'tool_calls';
  } catch {
    // An error means "unknown", not "false" — see the reasoning probe above.
    toolCalls = undefined;
  }

  return { reasoning, toolCalls };
}

/** Pull the assistant's text content out of a chat completion response, robust
 *  to the choice/message/content nesting relays ship. Returns the empty string
 *  when there is no text content (e.g. a pure tool_calls response). */
function textOfCompletion(res: ChatCompletionResponse): string {
  const choice = res.choices?.[0];
  if (!choice) return '';
  const message = choice.message;
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (block?.text ?? '')))
      .join('');
  }
  return '';
}
