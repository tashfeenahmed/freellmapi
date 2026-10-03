import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// This registry is local operator policy, never supplied by the hosted catalog.
// Account attestations are required because a free model on a paid account can
// have different billing. Missing, malformed and expired evidence all deny.
export interface ProviderEvidence {
  platform: string;
  model: string;
  keySha256: string;
  accountId?: string;
  enabled: boolean;
  price: 'verified_zero';
  accountPlan: 'free';
  overage: 'blocked';
  verifiedAt: string;
  expiresAt: string;
  source: string;
  accountEvidence: string;
  purposes: Array<'research' | 'commercial'>;
  privacy: 'public-only' | 'confidential-approved';
}

const ORIGINS: Record<string, string> = {
  openrouter: 'https://openrouter.ai',
  groq: 'https://api.groq.com',
  google: 'https://generativelanguage.googleapis.com',
  cloudflare: 'https://api.cloudflare.com',
};
const SOURCE_HOSTS: Record<string, string[]> = {
  openrouter: ['openrouter.ai'], groq: ['console.groq.com'],
  google: ['ai.google.dev'], cloudflare: ['developers.cloudflare.com'],
};
const MAX_EVIDENCE_AGE = 7 * 24 * 60 * 60 * 1000;

export function strictZeroSpend(): boolean {
  // Opt-in: an unset variable preserves the upstream default. Once configured,
  // only an explicit false disables the gate; empty values and typos fail closed.
  const configured = process.env.STRICT_ZERO_SPEND;
  return configured !== undefined && configured !== 'false';
}

export interface ZeroSpendPolicyContext {
  purpose: 'research' | 'commercial';
  dataClass: 'public' | 'confidential';
}

export function zeroSpendPolicyContext(): ZeroSpendPolicyContext | null {
  const purpose = process.env.FREEAPI_USAGE_PURPOSE?.trim();
  const dataClass = process.env.FREEAPI_DATA_CLASS?.trim();
  if (purpose !== 'research' && purpose !== 'commercial') return null;
  if (dataClass !== 'public' && dataClass !== 'confidential') return null;
  return { purpose, dataClass };
}

export class ZeroSpendError extends Error {
  readonly status = 403;
  readonly code = 'zero_spend_blocked';
  constructor(reason: string) { super(`Zero-spend policy blocked request: ${reason}`); }
}

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function registry(): ProviderEvidence[] {
  const path = process.env.PROVIDER_EVIDENCE_FILE;
  if (!path) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data?.version === 1 && Array.isArray(data.entries) ? data.entries : [];
  } catch { return []; }
}

function valid(e: ProviderEvidence, now: number): boolean {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.platform !== 'string' || !Object.hasOwn(ORIGINS, e.platform)) return false;
  if (typeof e.verifiedAt !== 'string' || typeof e.expiresAt !== 'string') return false;
  if (e.platform === 'cloudflare' && (typeof e.accountId !== 'string' || !/^[a-f0-9]{32}$/.test(e.accountId))) return false;
  const start = Date.parse(e.verifiedAt), end = Date.parse(e.expiresAt);
  const context = zeroSpendPolicyContext();
  if (!context) return false;
  const { purpose, dataClass: privacy } = context;
  if (e.platform === 'openrouter' && e.model === 'openrouter/free' && (purpose !== 'research' || privacy !== 'public')) return false;
  try {
    const source = new URL(e.source);
    if (source.protocol !== 'https:' || !SOURCE_HOSTS[e.platform]?.includes(source.hostname)) return false;
  } catch { return false; }
  return e.enabled === true && e.price === 'verified_zero' && e.accountPlan === 'free'
    && e.overage === 'blocked' && typeof e.model === 'string' && e.model.length > 0
    && typeof e.keySha256 === 'string' && /^[a-f0-9]{64}$/.test(e.keySha256)
    && typeof e.accountEvidence === 'string' && e.accountEvidence.trim().length > 0
    && Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end
    && end > start && end - start <= MAX_EVIDENCE_AGE && now - start < MAX_EVIDENCE_AGE
    && Array.isArray(e.purposes) && e.purposes.includes(purpose as 'research' | 'commercial')
    && ['public-only', 'confidential-approved'].includes(e.privacy)
    && (privacy !== 'confidential' || e.privacy === 'confidential-approved')
    && (e.platform !== 'openrouter' || e.model === 'openrouter/free'
      || (!e.model.toLowerCase().startsWith('openrouter/') && /^[a-z0-9._-]+\/[a-z0-9._-]+:free$/i.test(e.model)));
}

export function hasZeroSpendEvidence(platform: string, model: string): boolean {
  return !strictZeroSpend() || registry().some(e => valid(e, Date.now()) && e.platform === platform && e.model === model);
}

export function hasZeroSpendKeyEvidence(platform: string, model: string, apiKey: string): boolean {
  if (!strictZeroSpend()) return true;
  const sep = apiKey.indexOf(':');
  const token = platform === 'cloudflare' ? apiKey.slice(sep + 1) : apiKey;
  return registry().some(e => valid(e, Date.now()) && e.platform === platform && e.model === model
    && e.keySha256 === keyFingerprint(token)
    && (platform !== 'cloudflare' || (sep > 0 && e.accountId === apiKey.slice(0, sep))));
}

const CHAT_FIELDS = new Set([
  'model', 'messages', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop',
  'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'top_k', 'seed',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'logit_bias', 'logprobs',
  'top_logprobs', 'response_format', 'reasoning_effort', 'reasoning', 'include_reasoning',
]);

/** Last check for requests dispatched through proxyFetch. Checks the actual
 * serialized model, URL and credential,
 * so explicit pins, fallback, catalog updates and option overrides cannot evade it.
 * Only the four reviewed chat transports are supported in this first phase.
 */
export function assertZeroSpendRequest(url: string, init?: RequestInit, platform?: string): void {
  if (!strictZeroSpend()) return;
  const deny = (reason: string): never => { throw new ZeroSpendError(reason); };
  if (!zeroSpendPolicyContext()) deny('FREEAPI_USAGE_PURPOSE and FREEAPI_DATA_CLASS must be set explicitly');
  if (!platform || !Object.hasOwn(ORIGINS, platform)) deny('provider is not reviewed');
  const p = platform!;
  let target: URL;
  try { target = new URL(url); } catch { return deny('invalid destination'); }
  if (target.origin !== ORIGINS[p] || target.username || target.password || target.hash) deny('unapproved destination');
  const headers = new Headers(init?.headers);
  const key = p === 'google' ? headers.get('x-goog-api-key') : headers.get('authorization')?.replace(/^Bearer /, '');
  if (!key) deny('missing credential');
  const evidence = registry().filter(e => valid(e, Date.now()) && e.platform === p && e.keySha256 === keyFingerprint(key!));
  if (evidence.length === 0) deny('no current evidence for this credential and use');
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = target.pathname;
  if (method === 'GET' && !target.search && !init?.body) {
    const metadata = p === 'openrouter' ? path === '/api/v1/models'
      : p === 'groq' ? path === '/openai/v1/models'
      : p === 'google' ? path === '/v1beta/models'
      : path === '/client/v4/user/tokens/verify' || evidence.some(e => /^[a-f0-9]{32}$/.test(e.accountId ?? '') && path === `/client/v4/accounts/${e.accountId}/tokens/verify`);
    if (metadata) return;
  }
  if (method !== 'POST' || typeof init?.body !== 'string') deny('operation is not approved');
  let parsed: unknown;
  try { parsed = JSON.parse(init!.body as string); } catch { return deny('invalid request body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return deny('invalid request body');
  const body = parsed as Record<string, any>;
  let model: string;
  if (p === 'google') {
    const match = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path);
    if (!match || (target.search && target.search !== '?alt=sse')) deny('unapproved Gemini operation');
    model = match![1];
    if (Object.keys(body).some(k => !['contents', 'generationConfig', 'systemInstruction', 'tools', 'toolConfig', 'safetySettings'].includes(k))) deny('unreviewed Gemini option');
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => !t || Object.keys(t).some(k => k !== 'functionDeclarations')))) deny('built-in tools are not approved');
    const modalities = body.generationConfig?.responseModalities;
    if (modalities !== undefined && (!Array.isArray(modalities) || modalities.some((m: unknown) => m !== 'TEXT'))) deny('media generation is not approved');
    const content = [...(Array.isArray(body.contents) ? body.contents : []), ...(body.systemInstruction ? [body.systemInstruction] : [])];
    if (!Array.isArray(body.contents) || content.some((c: any) => !Array.isArray(c?.parts)
      || c.parts.some((part: any) => !part || Object.keys(part).some(k => !['text', 'functionCall', 'functionResponse', 'thoughtSignature', 'thought'].includes(k))))) deny('only text and function parts are approved');
  } else {
    const expected = p === 'openrouter' ? '/api/v1/chat/completions' : p === 'groq' ? '/openai/v1/chat/completions' : null;
    if (target.search || (expected ? path !== expected : !evidence.some(e => /^[a-f0-9]{32}$/.test(e.accountId ?? '') && path === `/client/v4/accounts/${e.accountId}/ai/v1/chat/completions`))) deny('unapproved chat endpoint');
    if (Object.keys(body).some(k => !CHAT_FIELDS.has(k))) deny('unreviewed request option');
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => t?.type !== 'function'))) deny('built-in tools are not approved');
    // File parts can implicitly trigger separately billed OCR on OpenRouter,
    // even when plugins are absent and the selected model is free. Phase one
    // accepts text content only; free-model evidence is not evidence that
    // document processing, audio or other modalities are also zero priced.
    if (!Array.isArray(body.messages) || body.messages.some((m: any) => !m ||
      (m.content != null && typeof m.content !== 'string' &&
        (!Array.isArray(m.content) || m.content.some((part: any) => !part || part.type !== 'text'
          || typeof part.text !== 'string' || Object.keys(part).some(k => k !== 'type' && k !== 'text')))))) {
      deny('only text message content is approved');
    }
    model = body.model;
  }
  if (typeof model !== 'string' || !evidence.some(e => e.model === model && (p !== 'cloudflare' || path === `/client/v4/accounts/${e.accountId}/ai/v1/chat/completions`))) deny('model has no current zero-price evidence');
}
