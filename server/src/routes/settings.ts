import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getSetting, setSetting, getDb } from '../db/index.js';
import { applyProxyUrl, applyProxyMode, applyProxyEnabled, applyProxyBypass, applyFetchRelayToken, encodeFetchRelayToken, isProxyActive, getProxyUrl, getProxyMode, getFetchRelayToken, isProxyEnabled, getProxyBypassPlatforms, probeProxyUrl, fetchRelayUrlError, DEFAULT_PROXY_PROBE_TARGET, PROXY_MODES, PROXY_SCHEMES } from '../lib/proxy.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { ProxyMode } from '@freellmapi/shared/types.js';
import { getSavedFusionConfig, setSavedFusionConfig, savedFusionConfigSchema, getFusionMaxK } from '../services/fusion.js';
import { isUnifyEnabled, setUnifyEnabled, getUnifyOverrides, setUnifyOverrides, unifyOverridesSchema } from '../services/model-groups.js';
import { getClaudeModelMap, setClaudeModelMap } from '../services/anthropic-map.js';
import { getGeminiModelMap, setGeminiModelMap } from '../services/gemini-map.js';
import { getOllamaEmulationMode } from './ollama.js';
import { UPDATE_CHECK_SETTING, isAutoUpdateCheckEnabled } from './update.js';
import { listUrlTokens, mintUrlToken, revokeUrlToken } from '../services/url-tokens.js';
import {
  getRequestMaxTokensBudget,
  getMaxConsecutiveUpstreamFails,
  REQUEST_MAX_TOKENS_BUDGET_SETTING,
  MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING,
} from '../lib/guardrails.js';
import {
  compressionUpdateSchema,
  getCompressionConfig,
  setCompressionConfig,
} from '../services/compression/config.js';
import { getHeadroomThresholds, setHeadroomThresholds } from '../services/router.js';
import { z } from 'zod';
import { getAppVersion } from '../lib/app-version.js';
import {
  UNIFIED_MAX_TOKENS_SETTING,
  UNIFIED_MAX_TOKENS_AUTO,
  unifiedMaxTokensCap,
} from '../lib/sampling-params.js';

export const settingsRouter = Router();

// Which RELEASE this install is, for the dashboard's version row (#703).
// Deliberately NOT /api/version: the Ollama emulation already owns that path
// and answers it for real Ollama clients, so mounting here would have shadowed
// it. `null` means the version could not be established honestly, and the
// dashboard then shows nothing rather than a number that isn't the release.
settingsRouter.get('/version', (_req: Request, res: Response) => {
  res.json({ version: getAppVersion() });
});

// Opt-in for the dashboard's automatic release reminder (#782). Off unless the
// operator turns it on: a self-hosted install must not contact GitHub on page
// load on behalf of someone who never asked it to. The manual checker in
// Settings is a separate surface and is unaffected by this flag.
const updateCheckSchema = z.object({ enabled: z.boolean() }).strict();

settingsRouter.get('/update-check', (_req: Request, res: Response) => {
  res.json({ enabled: isAutoUpdateCheckEnabled() });
});

settingsRouter.put('/update-check', (req: Request, res: Response) => {
  const parsed = updateCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid update check setting: ${parsed.error.errors.map(error => error.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  setSetting(UPDATE_CHECK_SETTING, parsed.data.enabled ? '1' : '0');
  res.json({ enabled: isAutoUpdateCheckEnabled() });
});

settingsRouter.get('/compression', (_req: Request, res: Response) => {
  res.json(getCompressionConfig());
});

settingsRouter.put('/compression', (req: Request, res: Response) => {
  const parsed = compressionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid compression settings: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }
  res.json(setCompressionConfig(parsed.data));
});

// Get the model-unification setting: the global toggle (default ON) plus any
// merge/split overrides. Governs the dashboard grouping, /v1/models grouping,
// and cross-provider pin failover.
settingsRouter.get('/unify', (_req: Request, res: Response) => {
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

const unifyPutSchema = z.object({
  enabled: z.boolean().optional(),
  overrides: unifyOverridesSchema.optional(),
});

// Update the unify toggle and/or overrides. Partial: send just `enabled` to
// flip the switch, or `overrides` to adjust grouping, or both.
settingsRouter.put('/unify', (req: Request, res: Response) => {
  const parsed = unifyPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid unify settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.enabled !== undefined) setUnifyEnabled(parsed.data.enabled);
  if (parsed.data.overrides) setUnifyOverrides(parsed.data.overrides);
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

// Get the saved fusion default config (panel mode, models, judge, k, strategy).
settingsRouter.get('/fusion', (_req: Request, res: Response) => {
  res.json({ config: getSavedFusionConfig(), maxK: getFusionMaxK() });
});

// Save the fusion default config. A request's inline `fusion` field still
// overrides this per call (see services/fusion.ts resolveEffectiveConfig).
settingsRouter.put('/fusion', (req: Request, res: Response) => {
  const parsed = savedFusionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid fusion config: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const saved = setSavedFusionConfig(parsed.data);
  res.json({ config: saved, maxK: getFusionMaxK() });
});

// Get the Claude Code model map (opus/sonnet/haiku/default → 'auto' | model_id).
// Drives how the Anthropic /v1/messages route resolves Claude Code's built-in
// model names against the free pool.
settingsRouter.get('/anthropic-map', (_req: Request, res: Response) => {
  res.json({ map: getClaudeModelMap() });
});

// Update the Claude Code model map. Partial: send just the families you want to
// change; each value is 'auto' or a catalog model_id.
settingsRouter.put('/anthropic-map', (req: Request, res: Response) => {
  try {
    res.json({ map: setClaudeModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid anthropic model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

settingsRouter.get('/gemini-map', (_req: Request, res: Response) => {
  res.json({ map: getGeminiModelMap() });
});

settingsRouter.put('/gemini-map', (req: Request, res: Response) => {
  try {
    res.json({ map: setGeminiModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid Gemini model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

const compatibilitySchema = z.object({
  ollamaEmulation: z.enum(['off', 'open-loopback', 'key-required']).optional(),
  exposeClaudeDiscoveryAliases: z.boolean().optional(),
}).strict();

settingsRouter.get('/agent-compatibility', (_req: Request, res: Response) => {
  res.json({
    ollamaEmulation: getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.put('/agent-compatibility', (req: Request, res: Response) => {
  const parsed = compatibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid agent compatibility settings: ${parsed.error.errors.map(error => error.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  if (parsed.data.ollamaEmulation) setSetting('ollama_emulation', parsed.data.ollamaEmulation);
  if (parsed.data.exposeClaudeDiscoveryAliases !== undefined) {
    setSetting('expose_cc_discovery_aliases', parsed.data.exposeClaudeDiscoveryAliases ? '1' : '0');
  }
  res.json({
    ollamaEmulation: getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.get('/url-tokens', (_req: Request, res: Response) => {
  res.json({ tokens: listUrlTokens() });
});

settingsRouter.post('/url-tokens', (req: Request, res: Response) => {
  const parsed = z.object({ label: z.string().max(120).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid URL token label', type: 'invalid_request_error' } });
    return;
  }
  res.status(201).json(mintUrlToken(parsed.data.label ?? ''));
});

settingsRouter.delete('/url-tokens/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid URL token id', type: 'invalid_request_error' } });
    return;
  }
  if (!revokeUrlToken(id)) {
    res.status(404).json({ error: { message: 'Active URL token not found', type: 'not_found_error' } });
    return;
  }
  res.status(204).end();
});

// The unified output-token cap as the dashboard sees it. `mode` is exactly
// what PUT accepts back — 'off', 'auto', or the integer itself, never a
// stringified number — so a read/modify/write round trip can't 400 on its own
// output. A stored value that unifiedMaxTokensCap() doesn't understand is
// reported as 'off', which is how it actually behaves (effectiveCap null).
function outputLimitState(): { mode: 'off' | 'auto' | number; effectiveCap: number | null; autoValue: number } {
  const raw = (getSetting(UNIFIED_MAX_TOKENS_SETTING) ?? '').trim().toLowerCase();
  const effectiveCap = unifiedMaxTokensCap();
  const mode = raw === 'auto' ? 'auto' as const : (effectiveCap ?? 'off' as const);
  return { mode, effectiveCap, autoValue: UNIFIED_MAX_TOKENS_AUTO };
}

// Get the unified output-token cap ('off' = disabled, 'auto' = 32768, or an
// explicit integer). See lib/sampling-params.ts unifiedMaxTokensCap().
settingsRouter.get('/output-limit', (_req: Request, res: Response) => {
  res.json(outputLimitState());
});

const outputLimitPutSchema = z.object({
  mode: z.union([
    z.literal('off'),
    z.literal('auto'),
    z.number().int().min(1),
  ]),
});

// Update the unified output-token cap. 'off' restores pass-through behaviour;
// 'auto' clamps every request's max_tokens to UNIFIED_MAX_TOKENS_AUTO; an
// integer clamps to that value. Takes effect on the next request.
settingsRouter.put('/output-limit', (req: Request, res: Response) => {
  const parsed = outputLimitPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid output limit: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  setSetting(UNIFIED_MAX_TOKENS_SETTING, String(parsed.data.mode));
  res.json(outputLimitState());
});

// Get the request guardrails (per-request token budget + failover circuit
// breaker). Both default to 0 = disabled; see lib/guardrails.ts.
settingsRouter.get('/guardrails', (_req: Request, res: Response) => {
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

const guardrailsPutSchema = z.object({
  requestMaxTokensBudget: z.number().int().min(0).optional(),
  maxConsecutiveUpstreamFails: z.number().int().min(0).optional(),
});

// Get the headroom guardrail thresholds (#899): the remaining-budget fraction
// at which proactive demotion begins and the score floor at 0 remaining. Both
// are decimals (0.2 = 20%). null = the scoring.ts default is in effect.
settingsRouter.get('/headroom', (_req: Request, res: Response) => {
  const { rampStart, floor } = getHeadroomThresholds();
  res.json({ rampStart: rampStart ?? null, floor: floor ?? null });
});

const headroomPutSchema = z.object({
  rampStart: z.number().min(0).max(1).nullable().optional(),
  floor: z.number().min(0).max(1).nullable().optional(),
});

// Update the headroom guardrail thresholds. null clears a threshold back to the
// scoring.ts default. Takes effect on the next request — no restart needed.
settingsRouter.put('/headroom', (req: Request, res: Response) => {
  const parsed = headroomPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid headroom thresholds: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  try {
    setHeadroomThresholds(parsed.data.rampStart, parsed.data.floor);
    const { rampStart, floor } = getHeadroomThresholds();
    res.json({ rampStart: rampStart ?? null, floor: floor ?? null });
  } catch (err: any) {
    res.status(400).json({ error: { message: `Invalid headroom thresholds: ${err.message}`, type: 'invalid_request_error' } });
  }
});

// Update the guardrails. Partial: send just the knob you want to change.
// Takes effect on the next request — no restart needed. 0 disables a knob.
settingsRouter.put('/guardrails', (req: Request, res: Response) => {
  const parsed = guardrailsPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid guardrail settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.requestMaxTokensBudget !== undefined) {
    setSetting(REQUEST_MAX_TOKENS_BUDGET_SETTING, String(parsed.data.requestMaxTokensBudget));
  }
  if (parsed.data.maxConsecutiveUpstreamFails !== undefined) {
    setSetting(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, String(parsed.data.maxConsecutiveUpstreamFails));
  }
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Get the proxy settings
settingsRouter.get('/proxy', (_req: Request, res: Response) => {
  res.json({
    proxyUrl: getProxyUrl(),
    proxyMode: getProxyMode(),
    fetchRelayTokenConfigured: Boolean(getFetchRelayToken()),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// A forward proxy only tunnels the TLS session, so plain http to the proxy is
// fine. A relay is the opposite: the provider API key and the relay token ride
// inside the request it forwards, in the clear, so the hop to the relay has to
// be https unless the relay is on this machine. fetchRelayUrlError owns that
// rule and the boot-time env guard applies the same one.
function proxyUrlError(proxyUrl: string, proxyMode: ProxyMode): string | undefined {
  if (!proxyUrl) return undefined;
  if (proxyMode === 'fetch-relay') return fetchRelayUrlError(proxyUrl);
  try {
    const protocol = new URL(proxyUrl).protocol;
    if (!PROXY_SCHEMES.includes(protocol)) {
      return 'Proxy URL must use http, https, socks5, socks5h, socks4, or socks4a scheme';
    }
  } catch {
    return 'Invalid proxy URL — must be a valid URL like socks5://host:port';
  }
  return undefined;
}

// Set the proxy settings. Accepts partial updates.
settingsRouter.put('/proxy', (req: Request, res: Response) => {
  const { proxyUrl, proxyMode, fetchRelayToken, enabled, bypassPlatforms } = req.body as {
    proxyUrl?: string;
    proxyMode?: ProxyMode;
    fetchRelayToken?: string;
    enabled?: boolean;
    bypassPlatforms?: string[];
  };

  if (proxyMode !== undefined && !PROXY_MODES.includes(proxyMode)) {
    res.status(400).json({
      error: { message: 'Proxy mode must be forward or fetch-relay', type: 'invalid_request_error' },
    });
    return;
  }

  // Only validate the URL when this request actually decides it. A body that
  // touches neither proxyUrl nor proxyMode — the enabled switch, the
  // per-platform bypass list — must not 400 on an ambient ALL_PROXY value the
  // dashboard never set and cannot fix (getProxyUrl may return exactly that).
  if (typeof proxyUrl === 'string' || proxyMode !== undefined) {
    const nextMode = proxyMode ?? getProxyMode();
    const nextUrl = typeof proxyUrl === 'string' ? proxyUrl.trim() : getProxyUrl();
    const urlError = proxyUrlError(nextUrl, nextMode);
    if (urlError) {
      res.status(400).json({ error: { message: urlError, type: 'invalid_request_error' } });
      return;
    }
  }

  // --- proxyUrl ---
  if (typeof proxyUrl === 'string') {
    const trimmed = proxyUrl.trim();
    setSetting('proxy_url', trimmed);
    applyProxyUrl(trimmed);
  }

  // --- proxyMode ---
  if (proxyMode !== undefined) {
    setSetting('proxy_mode', proxyMode);
    applyProxyMode(proxyMode);
  }

  // --- fetchRelayToken ---
  // Never return this value from the API. Undefined retains the saved token;
  // an explicit empty string clears it.
  if (typeof fetchRelayToken === 'string') {
    const trimmed = fetchRelayToken.trim();
    setSetting('fetch_relay_token', encodeFetchRelayToken(trimmed));
    applyFetchRelayToken(trimmed);
  }

  // --- enabled ---
  if (typeof enabled === 'boolean') {
    setSetting('proxy_enabled', enabled ? '1' : '0');
    applyProxyEnabled(enabled);
  }

  // --- bypassPlatforms ---
  if (Array.isArray(bypassPlatforms)) {
    const csv = bypassPlatforms.map(s => s.trim()).filter(Boolean).join(',');
    setSetting('proxy_bypass', csv);
    applyProxyBypass(csv);
  }

  res.json({
    proxyUrl: getProxyUrl(),
    proxyMode: getProxyMode(),
    fetchRelayTokenConfigured: Boolean(getFetchRelayToken()),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// Test proxy connectivity WITHOUT saving (#863). The dashboard's "Test" button
// sends the DRAFT value; an empty body falls back to the saved proxy URL. The
// probe never persists anything — it only builds a throwaway dispatcher and
// measures a round trip through the (draft or saved) proxy.
/**
 * What the proxy probe should call.
 *
 * The question the Test button answers is "can outbound traffic from THIS
 * install reach the upstreams it routes to", so the target is the /models
 * endpoint of a provider the operator actually holds an enabled key for —
 * preferring one that is not bypassing the proxy, since a bypassed platform
 * would not exercise the proxy at all. PROXY_TEST_URL overrides everything for
 * air-gapped or mirror-only deployments. With no keys at all there is no
 * upstream to name, and only then does the neutral fallback apply.
 */
function proxyProbeTarget(): string {
  const override = (process.env.PROXY_TEST_URL ?? '').trim();
  if (override) return override;

  let platforms: { platform: string }[] = [];
  try {
    platforms = getDb().prepare(
      `SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform`,
    ).all() as { platform: string }[];
  } catch {
    return DEFAULT_PROXY_PROBE_TARGET;
  }

  const bypassed = new Set(getProxyBypassPlatforms());
  const candidates = [
    ...platforms.filter(row => !bypassed.has(row.platform)),
    ...platforms.filter(row => bypassed.has(row.platform)),
  ];
  for (const row of candidates) {
    // 'custom' has no single registered base URL, and a provider may expose no
    // OpenAI-style catalog route at all; skip rather than invent one.
    if (row.platform === 'custom') continue;
    const url = (getProvider(row.platform as Platform) as { modelsUrl?: string } | undefined)?.modelsUrl;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return DEFAULT_PROXY_PROBE_TARGET;
}

settingsRouter.post('/proxy/test', async (req: Request, res: Response) => {
  const { proxyUrl, proxyMode, fetchRelayToken } = (req.body ?? {}) as {
    proxyUrl?: string;
    proxyMode?: ProxyMode;
    fetchRelayToken?: string;
  };
  if (proxyMode !== undefined && !PROXY_MODES.includes(proxyMode)) {
    res.status(400).json({ error: { message: 'Proxy mode must be forward or fetch-relay', type: 'invalid_request_error' } });
    return;
  }
  const mode = proxyMode ?? getProxyMode();
  const url = (proxyUrl ?? '').trim() || getProxyUrl();
  const urlError = proxyUrlError(url, mode);
  if (urlError) {
    res.status(400).json({ error: { message: urlError, type: 'invalid_request_error' } });
    return;
  }
  const result = await probeProxyUrl(proxyUrl, {
    targetUrl: proxyProbeTarget(),
    mode,
    relayToken: typeof fetchRelayToken === 'string' && fetchRelayToken.trim()
      ? fetchRelayToken.trim()
      : getFetchRelayToken(),
  });
  res.json(result);
});
