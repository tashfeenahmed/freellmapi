import { afterEach, describe, expect, it, vi } from 'vitest';
import { GizmoProvider } from '../../providers/gizmo.js';
import { JamaiProvider } from '../../providers/jamai.js';
import { KenariProvider } from '../../providers/kenari.js';
import { KiosAPIProvider } from '../../providers/kiosapi.js';
import { NovaiProvider } from '../../providers/novai.js';
import { FreeInferenceProvider } from '../../providers/freeinference.js';
import { isModelNotFoundError, isProviderBadRequestError, isRetryableError } from '../../lib/error-classify.js';

const messages = [{ role: 'user' as const, content: 'hello' }];

async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (err) { return err as Error; }
  throw new Error('Expected provider to reject');
}

afterEach(() => vi.restoreAllMocks());

describe('provider-side 400 failover', () => {
  it('retries a JamAI upstream request rejection without exposing its body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"secret":"do-not-log"}', { status: 400 }));
    const err = await errorFrom(new JamaiProvider().chatCompletion('proj_example:jamai_pat_testsecret', messages, 'model'));
    expect(err.message).not.toContain('do-not-log');
    expect(isRetryableError(err)).toBe(true);
    expect(isProviderBadRequestError(err)).toBe(true);
  });

  it('retries a Gizmo request that needs tools', async () => {
    const provider = new GizmoProvider();
    const err = await errorFrom(provider.chatCompletion('key', messages, 'model', { tool_choice: 'required' }));
    expect(isRetryableError(err)).toBe(true);
    expect(isProviderBadRequestError(err)).toBe(true);
  });

  it.each([
    ['Kenari', new KenariProvider()], ['KiosAPI', new KiosAPIProvider()],
    ['NovAI', new NovaiProvider()], ['FreeInference', new FreeInferenceProvider()],
  ])('skips an unsupported %s model without blaming the request shape', async (_name, provider) => {
    const err = await errorFrom(provider.chatCompletion('key', messages, 'unsupported-model'));
    expect(isRetryableError(err)).toBe(true);
    expect(isModelNotFoundError(err)).toBe(true);
    expect(isProviderBadRequestError(err)).toBe(false);
  });

  it('does not retry an unrelated local validation error with status 400', () => {
    const err = Object.assign(new Error('invalid request'), { status: 400 });
    expect(isRetryableError(err)).toBe(false);
    expect(isProviderBadRequestError(err)).toBe(false);
  });
});
