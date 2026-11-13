import { describe, it, expect } from 'vitest';
import {
  isProviderMomentFailure,
  newClientAbortError,
} from '../../lib/error-classify.js';

// #1347 (PR 1): the "provider had a bad minute" class. These failures steer
// the key (existing cooldowns) but, when attribution is enabled, must NOT be
// counted against the model's reliability — so the boundary of the class is
// load-bearing and gets its own unit coverage.
describe('isProviderMomentFailure (#1347 PR 1)', () => {
  it('classifies a structured 429', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('API error 429: rate limit exceeded'), { status: 429 })))
      .toBe(true);
  });

  it('classifies 5xx statuses as a sick provider', () => {
    for (const status of [500, 502, 503, 529]) {
      expect(isProviderMomentFailure(Object.assign(new Error(`API error ${status}`), { status })))
        .toBe(true);
    }
  });

  it('classifies a timeout that carries no structured status', () => {
    expect(isProviderMomentFailure(new Error('Request timeout: no response from upstream')))
      .toBe(true);
  });

  it('classifies a transport failure by code', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })))
      .toBe(true);
  });

  it('classifies a transport failure found in the cause chain', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isProviderMomentFailure(Object.assign(new Error('fetch failed'), { cause })))
      .toBe(true);
  });

  it('classifies a mid-stream truncation (connection reset mid-SSE)', () => {
    expect(isProviderMomentFailure(new Error('stream ended unexpectedly: no [done], no finish_reason')))
      .toBe(true);
  });

  it('classifies rate-limit wording on a status-less response', () => {
    expect(isProviderMomentFailure(new Error('rate limit exceeded, retry after 60s')))
      .toBe(true);
    expect(isProviderMomentFailure(new Error('Too Many Requests')))
      .toBe(true);
  });

  it('classifies a degraded deployment wearing a 400', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('deployment degraded'), { status: 400 })))
      .toBe(true);
  });

  it('does NOT classify auth failures (key-scoped)', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('API error 401: invalid api key'), { status: 401 })))
      .toBe(false);
    expect(isProviderMomentFailure(Object.assign(new Error('API error 403: forbidden'), { status: 403 })))
      .toBe(false);
  });

  it('does NOT classify quota (402) or model-not-found (404/410)', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('API error 402: insufficient credits'), { status: 402 })))
      .toBe(false);
    expect(isProviderMomentFailure(Object.assign(new Error('API error 404: model not found'), { status: 404 })))
      .toBe(false);
    expect(isProviderMomentFailure(Object.assign(new Error('API error 410: model retired'), { status: 410 })))
      .toBe(false);
  });

  it('does NOT classify an empty completion or a context-too-large 400', () => {
    expect(isProviderMomentFailure(new Error('empty completion'))).toBe(false);
    expect(isProviderMomentFailure(Object.assign(new Error('This model maximum context length is 8192'), { status: 400 })))
      .toBe(false);
  });

  it('does NOT classify a client abort', () => {
    expect(isProviderMomentFailure(newClientAbortError('client disconnected'))).toBe(false);
  });

  it('does NOT classify a model-scoped 400 (skipModelForRequest)', () => {
    expect(isProviderMomentFailure(Object.assign(new Error('response_format unsupported'), { status: 400, skipModelForRequest: true })))
      .toBe(false);
  });
});
