// Structured, reviewed metadata for every registered provider: how it
// authenticates, what kind of free access it offers, and where that claim
// comes from.
//
// Ground rules for editing this file:
//  - Every classification must be defensible from a cited source. Today the
//    only sources are this repository's own notes (the Platform comments in
//    shared/types.ts, docs/en/providers/*.md, migration comments). Nothing here
//    has been re-checked against a provider's official documentation, so
//    `officialDocsVerifiedOn` is null everywhere. Set it only after actually
//    reading the official page, and record that page in `docsUrl`.
//  - `docsUrlSource: 'unchecked'` means the URL is the provider's well-known
//    documentation location but was not fetched when this entry was written.
//  - Unknown stays unknown. Do not upgrade a terse note to `medium`.
//  - `confidence` describes the evidence, not the provider: `medium` needs a
//    concrete, repo-documented free-tier fact (a limit, an allowance, a live
//    probe); `low` is a vague or self-reported note; `high` is reserved for
//    independently verified official documentation.
//
// services/free-only.ts turns this into routing decisions.
import type { Platform } from '@freellmapi/shared/types.js';

export type FreeTierClass =
  /** Recurring free allowance (rate, daily or monthly limits); no card needed. */
  | 'free-recurring'
  /** Only some models are free; `freeModelRule` says which. */
  | 'free-model-subset'
  /** Recurring free credits (a $ or token balance that renews). Credit-based. */
  | 'free-recurring-credit'
  /** Trial key or one-time grant; not a permanent free tier. */
  | 'trial'
  /** Limited-time $0 promotion that can end without notice. */
  | 'promotional'
  /** Free allowance, but usage beyond it is billed (payment method on file). */
  | 'paid-beyond-free'
  /** No free tier for new accounts. */
  | 'paid'
  /** The free tier was withdrawn. */
  | 'retired'
  /** A user-configured endpoint; the operator decides what it costs. */
  | 'operator-managed'
  /** Not a chat provider (web search APIs). */
  | 'not-chat'
  /** No defensible statement in the repository. */
  | 'unknown';

export type Confidence = 'low' | 'medium' | 'high';

export type FreeModelRule =
  | { kind: 'suffix'; values: string[] }
  | { kind: 'ids'; values: string[] }
  | { kind: 'include-pattern'; pattern: string }
  | { kind: 'exclude-pattern'; pattern: string };

export interface ProviderMetadata {
  platform: Platform;
  auth: 'api-key' | 'keyless' | 'compound-key' | 'operator-configured';
  freeTier: FreeTierClass;
  freeModelRule?: FreeModelRule;
  quotasPublished: 'yes' | 'partial' | 'no' | 'unknown';
  /** Conditions on access: card, identity checks, regional walls, etc. */
  restrictions: string[];
  /** The repository records that prompts/outputs are logged for training. */
  trainsOnPrompts?: boolean;
  docsUrl: string | null;
  docsUrlSource: 'repo' | 'unchecked' | null;
  evidence: {
    kind: 'repo-documented' | 'none';
    sources: string[];
    /** A date the repository itself states for an observation, if any. */
    repoObservedOn?: string;
  };
  /** ISO date the official docs were read to confirm `freeTier`. Never guessed. */
  officialDocsVerifiedOn: string | null;
  confidence: Confidence;
  summary: string;
}

const TYPES = 'shared/types.ts Platform comment';
const PLATFORMS_DOC = 'docs/en/providers/01-supported-platforms.md';
const CREDIT_DOC = 'docs/en/providers/04-recurring-credit-gateways.md';
const BASELINE = 'server/src/db/migrations/20260101_000000_legacy_baseline.ts';
const CATALOG = 'shipped model catalog (per-model free-tier limits)';

type Entry = Omit<ProviderMetadata, 'platform' | 'officialDocsVerifiedOn' | 'evidence' | 'docsUrl' | 'docsUrlSource' | 'restrictions' | 'auth'> & {
  auth?: ProviderMetadata['auth'];
  restrictions?: string[];
  sources: string[];
  repoObservedOn?: string;
  docsUrl?: string;
  docsUrlSource?: 'repo' | 'unchecked';
};

const ENTRIES: Record<string, Entry> = {
  google: {
    freeTier: 'free-recurring', freeModelRule: { kind: 'exclude-pattern', pattern: '-pro(-|$)' },
    quotasPublished: 'partial', confidence: 'medium',
    restrictions: [
      'Pro-class models left the free tier on 2026-04-01 (repo note); they are treated as not free',
      'Limits are per Google Cloud project; whether a project with billing enabled is charged was not verified here',
    ],
    sources: [CATALOG, `${BASELINE} (V5 note)`],
    docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits', docsUrlSource: 'unchecked',
    summary: 'Gemini/Gemma free tier with small per-model daily caps (catalog: 20 RPD for Gemini, 1,000 RPD for Gemma 4).',
  },
  groq: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium',
    sources: [CATALOG, `${BASELINE} (Groq limit corrections)`],
    docsUrl: 'https://console.groq.com/docs/rate-limits', docsUrlSource: 'unchecked',
    summary: 'Free tier with per-model RPM/RPD/TPM limits (catalog: 1,000–14,400 RPD).',
  },
  cerebras: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium',
    sources: [CATALOG, `${BASELINE} (live-probed with a free-tier key)`], repoObservedOn: '2026-05',
    docsUrl: 'https://inference-docs.cerebras.ai', docsUrlSource: 'unchecked',
    summary: 'Free pool (catalog: about 1M tokens/day, 2,400 RPD on most models).',
  },
  sail: {
    freeTier: 'paid-beyond-free', quotasPublished: 'yes', confidence: 'medium',
    restrictions: ['Payment method required for the monthly credit; usage beyond it is billed'],
    sources: [TYPES, PLATFORMS_DOC],
    summary: '$5 monthly credit with a payment method attached, then pay-as-you-go.',
  },
  aclide: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Responses-only gateway with a shared monthly free allowance (no figures recorded).',
  },
  speka: {
    freeTier: 'free-recurring-credit', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES],
    summary: 'One shared $1 monthly allowance across chat and embeddings.',
  },
  kenari: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Named free routes share a renewable daily account allowance (no figures recorded).',
  },
  kiosapi: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Named free routes share a renewable daily account allowance (no figures recorded).',
  },
  beatapi: {
    freeTier: 'promotional', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Decision-only adapter; promotional availability is catalog-managed.',
  },
  apinex: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Free-category chat shares one weighted daily allowance (no figures recorded).',
  },
  onomeo: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [`${TYPES} (#1460)`],
    summary: 'Free models share a 30-calls/5-hour account allowance plus a site-wide pool.',
  },
  iteracompute: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [`${TYPES} (#1649)`],
    summary: 'One account-wide free allowance of 30M tokens per month.',
  },
  typhoon: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Ongoing free research API (no limits recorded).',
  },
  plugsky: {
    freeTier: 'free-recurring', quotasPublished: 'no', confidence: 'low', sources: [TYPES],
    summary: 'Permanent free chat aliases on a shared fair-use quota (self-described).',
  },
  inferbase: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-only gateway with shared account allowances (no figures recorded).',
  },
  simplellm: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-only gateway with shared account allowances (no figures recorded).',
  },
  llmtr: {
    freeTier: 'free-model-subset', quotasPublished: 'partial', confidence: 'low', sources: [TYPES],
    restrictions: ['The public roster also includes paid and promotional IDs'],
    summary: 'Selected zero-priced routes with daily/rolling quotas; no rule recorded to tell them apart.',
  },
  gizmo: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed free routes (monthly request quota / ongoing $0 models).',
  },
  blockrun: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed free routes (monthly request quota / ongoing $0 models).',
  },
  moondream: {
    freeTier: 'free-recurring-credit', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES],
    summary: 'Hosted vision API with $5 per workspace in recurring monthly credits.',
  },
  electronhub: {
    freeTier: 'free-recurring-credit', quotasPublished: 'partial', confidence: 'medium', sources: [TYPES, CREDIT_DOC],
    summary: 'Shared weekly credit pool.',
  },
  experiential: {
    freeTier: 'free-recurring-credit', quotasPublished: 'partial', confidence: 'medium', sources: [TYPES, CREDIT_DOC],
    restrictions: ['Account verification noted in the repo docs'],
    summary: 'Shared monthly credit pool.',
  },
  router9: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed gateway: monthly shared credits or a daily free-model quota (not recorded which).',
  },
  septor: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed gateway: monthly shared credits or a daily free-model quota (not recorded which).',
  },
  clod: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed gateway: monthly shared credits or a daily free-model quota (not recorded which).',
  },
  speechify: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Catalog-managed speech gateway (allowance not recorded).',
  },
  freeai: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES],
    summary: 'Self-hosted TTS: shared 30K tokens/day and 1K API requests/month, no card.',
  },
  blaze: {
    freeTier: 'unknown', quotasPublished: 'unknown', confidence: 'low',
    restrictions: ['Registered base URL path is /paid/v1'],
    sources: ['server/src/providers/index.ts registration'],
    summary: 'No free-tier statement recorded in the repository.',
  },
  lucidity: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Daily free allowance (no figures recorded).',
  },
  airforce: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Daily free allowance (no figures recorded).',
  },
  dreamprompting: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Daily free allowance (no figures recorded).',
  },
  waterfall: {
    freeTier: 'free-recurring', quotasPublished: 'no', confidence: 'low', sources: [TYPES],
    summary: 'Community / fair-use tier.',
  },
  logfare: {
    freeTier: 'free-recurring', quotasPublished: 'no', confidence: 'low', sources: [TYPES],
    summary: 'Community / fair-use tier.',
  },
  bai: {
    freeTier: 'promotional', quotasPublished: 'unknown', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    summary: 'Only catalog row is a limited-time 0-credit promotion, not a recurring allowance.',
  },
  anyapi: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium', sources: [`${TYPES} (#772)`, PLATFORMS_DOC],
    restrictions: ['Free tier covers "free and basic" models only'],
    summary: '$0, no card, recurring; capped at 100K tokens/day. No RPM/RPD published.',
  },
  radeon: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    summary: 'Rotating public-model roster served free without consuming instance credits; limits read from headers.',
  },
  nvidia: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium',
    sources: [`${BASELINE} (June 2026: credits replaced by per-account rate limits)`, CATALOG], repoObservedOn: '2026-06',
    docsUrl: 'https://build.nvidia.com', docsUrlSource: 'unchecked',
    summary: 'Per-account rate limits (catalog: 40 RPM); cold starts can take minutes.',
  },
  mistral: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [`${BASELINE} (Experiment tier)`, CATALOG],
    docsUrl: 'https://docs.mistral.ai', docsUrlSource: 'unchecked',
    summary: 'Experiment tier: 2 RPM, 500K TPM, about 1B tokens/month shared across models.',
  },
  sambanova: {
    freeTier: 'retired', quotasPublished: 'unknown', confidence: 'medium', sources: [PLATFORMS_DOC],
    summary: 'Free tier permanently gone; kept only for historical key rows.',
  },
  openrouter: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'suffix', values: [':free'] },
    quotasPublished: 'yes', confidence: 'medium', sources: [PLATFORMS_DOC, `${BASELINE} (:free quotas)`],
    docsUrl: 'https://openrouter.ai/docs', docsUrlSource: 'unchecked',
    summary: 'Only `:free` models are free (20 RPM / 50 RPD without credits, per repo note). Other models are paid.',
  },
  cohere: {
    freeTier: 'trial', quotasPublished: 'yes', confidence: 'medium', sources: [`${BASELINE} (trial pool)`],
    restrictions: ['Trial key: 1,000 calls/month total', 'A catalog comment notes a terms review marked it "Avoid for personal use"'],
    docsUrl: 'https://docs.cohere.com/docs/rate-limits', docsUrlSource: 'unchecked',
    summary: 'Trial key access, not a permanent free tier.',
  },
  tavily: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  exa: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  firecrawl: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  linkup: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  parallel: { auth: 'keyless', freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  serpsearch: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  keenable: { auth: 'keyless', freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  brave: { freeTier: 'not-chat', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES], summary: 'Web search API, not a chat provider.' },
  cloudflare: {
    auth: 'compound-key', freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium',
    sources: [`${BASELINE} (10K Neurons/day)`, PLATFORMS_DOC],
    docsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/', docsUrlSource: 'unchecked',
    summary: '10K Neurons/day shared free pool across @cf/* models. Key format is account_id:token.',
  },
  zhipu: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'suffix', values: ['-flash'] },
    quotasPublished: 'no', confidence: 'medium', sources: [`${BASELINE} (free pool; glm-4.6v-flash listed "Free")`],
    summary: 'The -flash models are free; quotas unpublished. Other GLM models are not treated as free.',
  },
  huggingface: {
    freeTier: 'free-recurring-credit', quotasPublished: 'yes', confidence: 'medium', sources: [PLATFORMS_DOC],
    docsUrl: 'https://huggingface.co/docs/inference-providers', docsUrlSource: 'unchecked',
    summary: 'Router meta-provider with a recurring $0.10/month credit on the free tier.',
  },
  ollama: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'medium',
    sources: [PLATFORMS_DOC, 'server/src/providers/index.ts (Ollama Cloud Free)'],
    summary: 'Ollama Cloud free plan; the catalog keeps only confirmed-free rows.',
  },
  kilo: {
    auth: 'keyless', freeTier: 'free-model-subset', freeModelRule: { kind: 'suffix', values: [':free'] },
    quotasPublished: 'yes', confidence: 'medium', trainsOnPrompts: true, sources: [PLATFORMS_DOC],
    restrictions: ['Prompts and outputs are logged for training', '200 req/hr per IP on anonymous :free routes'],
    summary: 'Anonymous `:free` routes; logs prompts for training.',
  },
  pollinations: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium', sources: [`${BASELINE} (quirk note)`],
    summary: 'Free publishable key with shared free capacity.',
  },
  llm7: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [PLATFORMS_DOC, BASELINE],
    summary: '100 requests/hour free tier; anonymous use works for basic models.',
  },
  opencode: {
    freeTier: 'paid', quotasPublished: 'unknown', confidence: 'medium', sources: [`${PLATFORMS_DOC} (#1249)`],
    docsUrl: 'https://opencode.ai/auth', docsUrlSource: 'repo',
    summary: 'Free roster locked to the OpenCode client since 2026-09; paid models only here.',
  },
  ovh: {
    auth: 'keyless', freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [PLATFORMS_DOC, TYPES],
    restrictions: ['Anonymous tier only: 2 req/min per IP per model; the authenticated tier needs a payment method'],
    summary: 'Keyless anonymous tier.',
  },
  agnes: {
    freeTier: 'promotional', quotasPublished: 'no', confidence: 'medium', sources: [PLATFORMS_DOC, TYPES],
    docsUrl: 'https://platform.agnes-ai.com', docsUrlSource: 'repo',
    summary: 'Proprietary models served at $0/token promotionally.',
  },
  reka: {
    freeTier: 'paid', quotasPublished: 'unknown', confidence: 'medium', sources: [`${PLATFORMS_DOC} (#1202)`],
    docsUrl: 'https://platform.reka.ai', docsUrlSource: 'repo',
    summary: 'No free tier for new accounts since 2026-09; prepaid credits required.',
  },
  siliconflow: {
    freeTier: 'free-model-subset', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES, PLATFORMS_DOC],
    docsUrl: 'https://siliconflow.com', docsUrlSource: 'repo',
    summary: 'Registered for free media models; no rule recorded for which chat models are free.',
  },
  routeway: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'suffix', values: [':free'] },
    quotasPublished: 'yes', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    docsUrl: 'https://routeway.ai', docsUrlSource: 'repo',
    summary: '$0 `:free` models on a rate-limited pool (documented 20 RPM / 200 RPD; observed about 5 RPM).',
  },
  bazaarlink: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'ids', values: ['auto:free'] },
    quotasPublished: 'unknown', confidence: 'medium', sources: [`${PLATFORMS_DOC} (#385)`],
    docsUrl: 'https://bazaarlink.ai', docsUrlSource: 'repo',
    summary: 'Only the `auto:free` route is free; direct model ids are paid.',
  },
  ainative: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'low', sources: [TYPES, PLATFORMS_DOC],
    docsUrl: 'https://ainative.studio', docsUrlSource: 'repo',
    summary: 'Advertises about 10M tokens/month free; quota unverified.',
  },
  aion: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'No-card free key; availability is catalog-managed.',
  },
  requesty: {
    freeTier: 'free-model-subset', quotasPublished: 'yes', confidence: 'low', sources: [TYPES, PLATFORMS_DOC],
    summary: '200 requests/day shared across free models; no rule recorded to identify them.',
  },
  navy: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    summary: 'Free plan: 150K tokens/day and 20 RPM.',
  },
  nara: {
    freeTier: 'free-recurring', quotasPublished: 'unknown', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC], repoObservedOn: '2026-07-09',
    restrictions: ['Free key needs Telegram channel/link verification'],
    docsUrl: 'https://router.bynara.id', docsUrlSource: 'repo',
    summary: 'Free-plan routes reset daily.',
  },
  sealion: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    summary: 'First-party free key (Google sign-in, no card) at 10 RPM.',
  },
  orcarouter: {
    freeTier: 'free-recurring', quotasPublished: 'no', confidence: 'medium', sources: [`${TYPES} (#896)`, PLATFORMS_DOC],
    docsUrl: 'https://orcarouter.ai', docsUrlSource: 'repo',
    summary: 'Recurring $0 free aliases with unpublished limits; free routes never fall back to paid.',
  },
  unorouter: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'suffix', values: [':free'] },
    quotasPublished: 'partial', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC], repoObservedOn: '2026-08-23',
    docsUrl: 'https://unorouter.com', docsUrlSource: 'repo',
    summary: 'Free `:free` models with a per-minute rate limit.',
  },
  xkiro: {
    freeTier: 'free-recurring', quotasPublished: 'yes', confidence: 'medium', sources: [TYPES, PLATFORMS_DOC],
    docsUrl: 'https://xkiro.com', docsUrlSource: 'repo',
    summary: 'Free plan: 5M tokens/day on free models; paid models answer 403 on a free key.',
  },
  modelscope: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium', sources: [`${TYPES} (#581)`], repoObservedOn: '2026-08-14',
    restrictions: ['Requires binding to an Alibaba Cloud China-site account with Chinese real-name verification'],
    summary: 'About 250 magic-grain units/day (about 125 requests/day observed).',
  },
  qianfan: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'include-pattern', pattern: 'ernie-(speed|lite|tiny)' },
    quotasPublished: 'partial', confidence: 'medium', sources: [`${TYPES} (#936)`, PLATFORMS_DOC],
    restrictions: ['Chinese real-name verification required', 'Runs on a pay-as-you-go billing account; only the ERNIE Speed/Lite/Tiny series are free'],
    summary: 'ERNIE Speed/Lite/Tiny free indefinitely, bounded by rate limits.',
  },
  volcengine: {
    freeTier: 'paid-beyond-free', quotasPublished: 'yes', confidence: 'medium', sources: [`${TYPES} (#936)`, PLATFORMS_DOC],
    restrictions: ['Chinese real-name verification required', 'Whether usage beyond the daily reward is billed was not recorded; treated as billable'],
    summary: 'Recurring daily per-model reward (2M tokens/day/model) plus a one-time 500K grant.',
  },
  longcat: {
    freeTier: 'free-recurring', quotasPublished: 'partial', confidence: 'medium', sources: [`${TYPES} (#936)`, PLATFORMS_DOC],
    summary: 'Daily free quota (100K tokens/day quoted at launch); email signup works outside mainland China.',
  },
  xfyun: {
    freeTier: 'free-model-subset', freeModelRule: { kind: 'ids', values: ['lite'] },
    quotasPublished: 'no', confidence: 'medium', sources: [`${TYPES} (#936)`, PLATFORMS_DOC],
    restrictions: ['Chinese real-name verification required'],
    summary: 'The `lite` model is documented as free; no token or QPS ceiling published.',
  },
  aihorde: {
    auth: 'keyless', freeTier: 'free-recurring', quotasPublished: 'no', confidence: 'medium', sources: [`${TYPES} (#345)`, PLATFORMS_DOC],
    restrictions: ['Community volunteer workers; queue-based, slow; no tool support'],
    docsUrl: 'https://aihorde.net', docsUrlSource: 'repo',
    summary: 'Free community inference; the anonymous key works at lowest priority.',
  },
  custom: {
    auth: 'operator-configured', freeTier: 'operator-managed', quotasPublished: 'unknown', confidence: 'low', sources: [TYPES],
    summary: 'Your own OpenAI-compatible endpoint; its cost is whatever that endpoint charges.',
  },
};

function build(platform: string, e: Entry): ProviderMetadata {
  return {
    platform: platform as Platform,
    auth: e.auth ?? 'api-key',
    freeTier: e.freeTier,
    ...(e.freeModelRule ? { freeModelRule: e.freeModelRule } : {}),
    quotasPublished: e.quotasPublished,
    restrictions: e.restrictions ?? [],
    ...(e.trainsOnPrompts ? { trainsOnPrompts: true } : {}),
    docsUrl: e.docsUrl ?? null,
    docsUrlSource: e.docsUrl ? (e.docsUrlSource ?? 'unchecked') : null,
    evidence: {
      kind: e.sources.length > 0 ? 'repo-documented' : 'none',
      sources: e.sources,
      ...(e.repoObservedOn ? { repoObservedOn: e.repoObservedOn } : {}),
    },
    officialDocsVerifiedOn: null,
    confidence: e.confidence,
    summary: e.summary,
  };
}

const METADATA: ReadonlyMap<string, ProviderMetadata> = new Map(
  Object.entries(ENTRIES).map(([platform, e]) => [platform, Object.freeze(build(platform, e))]),
);

/** Fallback for a platform this file does not describe: unknown, never free. */
function unknownMetadata(platform: string): ProviderMetadata {
  return {
    platform: platform as Platform,
    auth: 'api-key',
    freeTier: 'unknown',
    quotasPublished: 'unknown',
    restrictions: [],
    docsUrl: null,
    docsUrlSource: null,
    evidence: { kind: 'none', sources: [] },
    officialDocsVerifiedOn: null,
    confidence: 'low',
    summary: 'No metadata recorded for this provider.',
  };
}

export function getProviderMetadata(platform: string): ProviderMetadata {
  return METADATA.get(platform) ?? unknownMetadata(platform);
}

export function hasProviderMetadata(platform: string): boolean {
  return METADATA.has(platform);
}

export function listProviderMetadata(): ProviderMetadata[] {
  return [...METADATA.values()];
}

/**
 * Whether a specific model is covered by its provider's free access:
 * 'free' when the class is free and the model passes `freeModelRule`,
 * 'not-free' when the rule excludes it or the class is not free,
 * 'unknown' when the provider offers some free models but no rule says which.
 */
export function modelFreeStatus(meta: ProviderMetadata, modelId: string): 'free' | 'not-free' | 'unknown' {
  const id = modelId.toLowerCase();
  if (meta.freeTier === 'free-recurring') {
    if (meta.freeModelRule?.kind === 'exclude-pattern') return new RegExp(meta.freeModelRule.pattern, 'i').test(id) ? 'not-free' : 'free';
    return 'free';
  }
  if (meta.freeTier === 'free-model-subset') {
    const rule = meta.freeModelRule;
    if (!rule) return 'unknown';
    switch (rule.kind) {
      case 'suffix': return rule.values.some(s => id.endsWith(s.toLowerCase())) ? 'free' : 'not-free';
      case 'ids': return rule.values.some(v => v.toLowerCase() === id) ? 'free' : 'not-free';
      case 'include-pattern': return new RegExp(rule.pattern, 'i').test(id) ? 'free' : 'not-free';
      case 'exclude-pattern': return new RegExp(rule.pattern, 'i').test(id) ? 'not-free' : 'free';
    }
  }
  return 'not-free';
}
