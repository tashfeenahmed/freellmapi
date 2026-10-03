import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertZeroSpendRequest, hasZeroSpendEvidence, keyFingerprint, strictZeroSpend, zeroSpendPolicyContext, type ProviderEvidence } from '../../lib/zero-spend.js';
import { applyProxyEnabled, applyProxyUrl, applyProxyMode, applyProxyBypass, proxyFetch } from '../../lib/proxy.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { GoogleProvider } from '../../providers/google.js';
import { isRetryableError, isModelAccessForbiddenError } from '../../lib/error-classify.js';
import { ZeroSpendError } from '../../lib/zero-spend.js';

let dir: string;
let file: string;
const secret = 'fake-unit-test-key';
const url = 'https://openrouter.ai/api/v1/chat/completions';
const model = 'test/model:free';
function entry(patch: Partial<ProviderEvidence> = {}): ProviderEvidence {
  return {
    platform: 'openrouter', model, keySha256: keyFingerprint(secret), enabled: true,
    price: 'verified_zero', accountPlan: 'free', overage: 'blocked',
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    source: 'https://openrouter.ai/docs/guides/routing/model-variants/free',
    accountEvidence: 'TEST ONLY: mock account with paid overage disabled',
    purposes: ['research'], privacy: 'public-only', ...patch,
  };
}
function save(entries: unknown[] = [entry()]) { writeFileSync(file, JSON.stringify({ version: 1, entries })); }
function request(body: Record<string, unknown> = { model, messages: [{ role: 'user', content: 'test' }] }): RequestInit {
  return { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify(body) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zero-spend-'));
  file = join(dir, 'evidence.json');
  vi.stubEnv('STRICT_ZERO_SPEND', 'true');
  vi.stubEnv('PROVIDER_EVIDENCE_FILE', file);
  vi.stubEnv('FREEAPI_USAGE_PURPOSE', 'research');
  vi.stubEnv('FREEAPI_DATA_CLASS', 'public');
  applyProxyEnabled(false);
  applyProxyMode('forward');
  applyProxyBypass('');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('zero-spend transport enforcement', () => {
  it('is opt-in, preserves explicit opt-out, and treats configured typos as strict', () => {
    delete process.env.STRICT_ZERO_SPEND;
    expect(strictZeroSpend()).toBe(false);
    process.env.STRICT_ZERO_SPEND = 'false';
    expect(strictZeroSpend()).toBe(false);
    process.env.STRICT_ZERO_SPEND = '';
    expect(strictZeroSpend()).toBe(true);
    process.env.STRICT_ZERO_SPEND = 'flase';
    expect(strictZeroSpend()).toBe(true);
  });
  it.each([undefined, 'false'])('preserves unreviewed transports when the policy is disabled (%s)', async flag => {
    if (flag === undefined) delete process.env.STRICT_ZERO_SPEND;
    else vi.stubEnv('STRICT_ZERO_SPEND', flag);
    const init = request({ model: 'paid/model', plugins: [{ id: 'web' }] });
    await proxyFetch('https://unreviewed.example/chat', init, 'unreviewed');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://unreviewed.example/chat', init);
  });
  it('keeps local policy denials out of provider-health and retry classification', () => {
    const error = new ZeroSpendError('no current evidence');
    expect(isRetryableError(error)).toBe(false);
    expect(isModelAccessForbiddenError(error)).toBe(false);
    expect(isModelAccessForbiddenError(Object.assign(new Error('provider denied model'), { status: 403 }))).toBe(true);
  });
  it.each([
    ['missing purpose', undefined, 'public'],
    ['missing data class', 'research', undefined],
    ['invalid purpose', 'mixed', 'public'],
    ['invalid data class', 'research', 'internal'],
  ])('fails closed for %s even with otherwise valid evidence', async (_label, purpose, dataClass) => {
    save();
    if (purpose === undefined) delete process.env.FREEAPI_USAGE_PURPOSE;
    else vi.stubEnv('FREEAPI_USAGE_PURPOSE', purpose);
    if (dataClass === undefined) delete process.env.FREEAPI_DATA_CLASS;
    else vi.stubEnv('FREEAPI_DATA_CLASS', dataClass);
    expect(zeroSpendPolicyContext()).toBeNull();
    expect(hasZeroSpendEvidence('openrouter', model)).toBe(false);
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('must be set explicitly');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'malformed', 'wrong-schema'])('denies %s registry without any fetch', async kind => {
    if (kind === 'malformed') writeFileSync(file, '{');
    if (kind === 'wrong-schema') writeFileSync(file, JSON.stringify({ version: 2, entries: [entry()] }));
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toMatchObject({ code: 'zero_spend_blocked' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false }, { model: 'paid/model' }, { keySha256: 'a'.repeat(64) },
    { expiresAt: '2020-01-01' }, { verifiedAt: 'not-a-date' },
    { verifiedAt: new Date(Date.now() + 60_000).toISOString() },
    { expiresAt: new Date(Date.now() + 9 * 86_400_000).toISOString() },
    { accountEvidence: '' }, { source: 'https://attacker.example/pricing' },
    { overage: 'payg' }, { price: 'unknown' }, { accountPlan: 'paid' },
  ])('rejects invalid or ineligible evidence: %j', async patch => {
    save([entry(patch as Partial<ProviderEvidence>)]);
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('ignores malformed rows rather than throwing an uncontrolled error', () => {
    save([null, {}, 5, { ...entry(), verifiedAt: { toString: 1 } }, { ...entry(), platform: { toString: 1 } }, entry()]);
    expect(hasZeroSpendEvidence('openrouter', model)).toBe(true);
  });
  it('allows an approved exact model and forces redirect rejection', async () => {
    save();
    await proxyFetch(url, request(), 'openrouter');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
  });
  it.each(['openrouter/auto:free', 'OPENROUTER/auto:free', 'test/model:online:free', '@preset/test:free'])('blocks misleading free variant %s even if attested', async modelId => {
    save([entry({ model: modelId })]);
    await expect(proxyFetch(url, request({ model: modelId, messages: [] }), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['file', 'input_file', 'input_audio', 'image_url'])('blocks unreviewed %s content including implicit paid PDF parsing', async type => {
    save();
    const provider = new OpenAICompatProvider({ platform: 'openrouter', name: 'mock', baseUrl: 'https://openrouter.ai/api/v1' });
    const messages = [{ role: 'user', content: [{ type, file: { filename: 'test.pdf', file_data: 'data:application/pdf;base64,dGVzdA==' } }] }] as any;
    await expect(provider.chatCompletion(secret, messages, model)).rejects.toThrow('only text');
    await expect(provider.streamChatCompletion(secret, messages, model).next()).rejects.toThrow('only text');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['commercial', 'invalid'])('rejects purpose %s without a matching approval', async purpose => {
    save(); vi.stubEnv('FREEAPI_USAGE_PURPOSE', purpose);
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects confidential data without an explicit privacy approval', async () => {
    save(); vi.stubEnv('FREEAPI_DATA_CLASS', 'confidential');
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('Zero-spend');
  });
  it.each([
    'https://attacker.example/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/embeddings',
    'https://openrouter.ai/api/v1/chat/completions?model=paid',
  ])('blocks unapproved endpoint %s', async destination => {
    save(); await expect(proxyFetch(destination, request(), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['github', 'custom', 'sail', 'nvidia', 'constructor'])('blocks unreviewed provider %s', async platform => {
    save(); await expect(proxyFetch(url, request(), platform)).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ plugins: [{ id: 'web' }] }, { models: ['paid/model'] }, { tools: [{ type: 'web_search' }] }])('blocks paid extras/fallbacks %j', async extras => {
    save(); await expect(proxyFetch(url, request({ model, ...extras }), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows only reviewed metadata checks, and only for an attested key', async () => {
    save();
    await proxyFetch('https://openrouter.ai/api/v1/models', { headers: request().headers }, 'openrouter');
    expect(fetch).toHaveBeenCalledOnce();
    await expect(proxyFetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: 'Bearer other-key' } }, 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rechecks evidence on each request (expiry/revocation cannot use a stale cache)', async () => {
    save(); await proxyFetch(url, request(), 'openrouter');
    save([]);
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('Zero-spend');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not disclose an approved key/body to an unreviewed application-layer relay', async () => {
    save();
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    applyProxyEnabled(true);
    applyProxyUrl('https://relay.example');
    applyProxyMode('fetch-relay');
    await expect(proxyFetch(url, request(), 'openrouter')).rejects.toThrow('fetch relay');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('blocks paid non-streaming and streaming adapter calls before upstream dispatch', async () => {
    save();
    const provider = new OpenAICompatProvider({ platform: 'openrouter', name: 'mock', baseUrl: 'https://openrouter.ai/api/v1' });
    await expect(provider.chatCompletion(secret, [], 'paid/model')).rejects.toThrow('Zero-spend');
    await expect(provider.streamChatCompletion(secret, [], 'paid/model').next()).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Gemini blocks billable built-in search and allows reviewed text inference', () => {
    save([entry({ platform: 'google', model: 'gemini-test', source: 'https://ai.google.dev/gemini-api/docs/pricing' })]);
    const target = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent';
    const init = { method: 'POST', headers: { 'x-goog-api-key': secret }, body: JSON.stringify({ contents: [] }) };
    expect(() => assertZeroSpendRequest(target, init, 'google')).not.toThrow();
    expect(() => assertZeroSpendRequest(target, { ...init, body: JSON.stringify({ contents: [], tools: [{ google_search: {} }] }) }, 'google')).toThrow('built-in');
  });
  it('Gemini propagates blocked image policy errors instead of sending a text-only request', async () => {
    save([entry({ platform: 'google', model: 'gemini-test', source: 'https://ai.google.dev/gemini-api/docs/pricing' })]);
    const provider = new GoogleProvider();
    await expect(provider.chatCompletion(secret, [{ role: 'user', content: [
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
    ] }], 'gemini-test')).rejects.toThrow('Zero-spend');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['TEXT', { TEXT: true }])('rejects malformed Gemini modalities with a policy error (%j)', modalities => {
    save([entry({ platform: 'google', model: 'gemini-test', source: 'https://ai.google.dev/gemini-api/docs/pricing' })]);
    const init = { method: 'POST', headers: { 'x-goog-api-key': secret }, body: JSON.stringify({ contents: [], generationConfig: { responseModalities: modalities } }) };
    expect(() => assertZeroSpendRequest('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent', init, 'google')).toThrow(ZeroSpendError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('binds Cloudflare approval to both account and token', () => {
    const accountId = 'a'.repeat(32);
    save([entry({ platform: 'cloudflare', model: '@cf/test', accountId, source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/' })]);
    const init = request({ model: '@cf/test', messages: [] });
    expect(() => assertZeroSpendRequest(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, init, 'cloudflare')).not.toThrow();
    expect(() => assertZeroSpendRequest(`https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/ai/v1/chat/completions`, init, 'cloudflare')).toThrow('Zero-spend');
  });
});
