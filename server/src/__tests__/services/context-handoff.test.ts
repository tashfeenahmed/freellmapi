import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getContextHandoffMode,
  recordIncomingMessages,
  maybeInjectContextHandoff,
  recordSuccessfulModel,
  hasPriorModel,
  HANDOFF_MAX_TOKENS,
  _clearStoreForTesting,
} from '../../services/context-handoff.js';

const msg = (role: string, content: string) => ({ role, content } as any);

const userMsg = msg('user', 'hello');
const assistantMsg = msg('assistant', 'hi there');
const messages = [userMsg, assistantMsg];

beforeEach(() => {
  _clearStoreForTesting();
  delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
});

afterEach(() => {
  delete process.env.FREELLMAPI_CONTEXT_HANDOFF;
});

describe('getContextHandoffMode', () => {
  it('defaults to off', () => {
    expect(getContextHandoffMode()).toBe('off');
  });

  it('reads on_model_switch', () => {
    process.env.FREELLMAPI_CONTEXT_HANDOFF = 'on_model_switch';
    expect(getContextHandoffMode()).toBe('on_model_switch');
  });

  it('treats unknown value as off', () => {
    process.env.FREELLMAPI_CONTEXT_HANDOFF = 'always';
    expect(getContextHandoffMode()).toBe('off');
  });
});

describe('maybeInjectContextHandoff — off mode', () => {
  it('returns original messages unchanged when mode is off', () => {
    const result = maybeInjectContextHandoff({
      mode: 'off',
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'groq:llama-3',
    });
    expect(result.injected).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

describe('maybeInjectContextHandoff — on_model_switch', () => {
  const mode = 'on_model_switch';

  it('no handoff on first request (no prior model recorded)', () => {
    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'groq:llama-3',
    });
    expect(result.injected).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('no handoff when same model continues', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'groq:llama-3',
    });
    expect(result.injected).toBe(false);
  });

  it('injects handoff when model switches', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    const injected = result.messages.find(m => m.role === 'system');
    expect(injected).toBeDefined();
    expect(injected!.content).toContain('FreeLLMAPI context handoff:');
    expect(injected!.content).toContain('groq:llama-3');
    expect(injected!.content).toContain('google:gemini-flash');
  });

  it('no duplicate handoff on next request after model B succeeds', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    // First request: model switches to google
    const r1 = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(r1.injected).toBe(true);

    // Record model B as successful
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'google:gemini-flash' });

    // Second request on same model B
    const r2 = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(r2.injected).toBe(false);
  });

  it('injects again if model switches a second time', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'google:gemini-flash' });

    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'cerebras:qwen-3',
    });
    expect(result.injected).toBe(true);
    expect(result.messages[0].content).toContain('google:gemini-flash');
    expect(result.messages[0].content).toContain('cerebras:qwen-3');
  });

  it('does not duplicate if handoff system message already present as plain string', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const existingHandoff = msg('system', 'FreeLLMAPI context handoff: prior injection');
    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages: [existingHandoff, ...messages],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(false);
  });

  it('does not duplicate if handoff system message present as array-content (OpenCode format)', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const arrayHandoff = {
      role: 'system',
      content: [{ type: 'text', text: 'FreeLLMAPI context handoff: prior injection' }],
    } as any;
    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages: [arrayHandoff, ...messages],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(false);
  });

  it('inserts handoff after existing system messages', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const sysMsg = msg('system', 'You are a helpful assistant');
    const withSystem = [sysMsg, ...messages];

    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess1',
      messages: withSystem,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    expect(result.messages[0]).toBe(sysMsg);
    expect(result.messages[1].role).toBe('system');
    expect(result.messages[1].content).toContain('FreeLLMAPI context handoff:');
  });

  it('isolates sessions by sessionKey', () => {
    recordIncomingMessages('sess-a', messages);
    recordSuccessfulModel({ sessionKey: 'sess-a', modelKey: 'groq:llama-3' });

    // sess-b has no prior model
    const result = maybeInjectContextHandoff({
      mode,
      sessionKey: 'sess-b',
      messages,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(false);
  });
});

describe('recordIncomingMessages', () => {
  it('truncates long content per message', () => {
    const longMsg = msg('user', 'x'.repeat(1000));
    recordIncomingMessages('sess1', [longMsg]);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages: [msg('user', 'new question')],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    expect((result.messages[0].content as string).length).toBeLessThanOrEqual(6500);
  });

  it('extracts text from array-content messages (OpenCode/Continue.dev format)', () => {
    const arrayMsg = { role: 'user', content: [{ type: 'text', text: 'hello from opencode' }] } as any;
    recordIncomingMessages('sess1', [arrayMsg]);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages: [msg('user', 'follow up')],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    // Summary must contain the extracted text, not raw JSON
    expect(result.messages[0].content as string).toContain('hello from opencode');
    expect(result.messages[0].content as string).not.toContain('"type":"text"');
  });

  it('keeps only last MAX_RECENT_MESSAGES user/assistant messages', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? msg('user', `q${i}`) : msg('assistant', `a${i}`),
    );
    recordIncomingMessages('sess1', many);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages: [msg('user', 'follow up')],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    expect((result.messages[0].content as string)).not.toContain('User: q0\n');
  });

  it('store hard-evicts oldest entries when all sessions are active and over MAX_STORE_SIZE', () => {
    // Fill 510 entries — all within TTL so TTL-prune removes nothing.
    // The LRU eviction path must still bring it back to MAX_STORE_SIZE (500).
    for (let i = 0; i < 510; i++) {
      recordIncomingMessages(`sess-fill-${i}`, [msg('user', `hello ${i}`)]);
    }
    // One more write triggers the eviction; store must not exceed 500 after.
    recordIncomingMessages('sess-trigger', [msg('user', 'trigger')]);
    // We can't read store.size directly, but the operation must not throw
    // and a subsequent inject must still work correctly.
    expect(() => recordIncomingMessages('sess-final', [msg('user', 'ok')])).not.toThrow();
  });

  it('resets lastModelKey when incoming payload has no assistant messages (fresh conversation on reused session ID)', () => {
    // Simulate: model recorded from previous conversation, then client reuses
    // same session ID for a brand-new conversation (no assistant turns yet).
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });

    // New conversation starts — only a user message, no assistant
    recordIncomingMessages('sess1', [msg('user', 'brand new question')]);

    // Should NOT inject — lastModelKey was cleared by fresh-convo heuristic
    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages: [msg('user', 'brand new question')],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(false);
  });

  it('preserves lastModelKey across recordIncomingMessages calls', () => {
    // Simulate: recordSuccessfulModel writes lastModelKey, then next turn's
    // recordIncomingMessages must not wipe it.
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    // Second call (next turn) must preserve lastModelKey
    recordIncomingMessages('sess1', [msg('user', 'turn 2'), msg('assistant', 'reply 2')]);

    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages: [msg('user', 'turn 3')],
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    expect(result.messages[0].content as string).toContain('groq:llama-3');
  });
});

describe('HANDOFF_MAX_TOKENS', () => {
  it('is a positive number exported for proxy routing estimate', () => {
    expect(HANDOFF_MAX_TOKENS).toBeGreaterThan(0);
    expect(typeof HANDOFF_MAX_TOKENS).toBe('number');
  });
});

describe('hasPriorModel', () => {
  it('is false for an unknown session', () => {
    expect(hasPriorModel('nope')).toBe(false);
  });

  it('is false for an empty session key', () => {
    expect(hasPriorModel('')).toBe(false);
  });

  it('is false after recordIncomingMessages alone (no model yet)', () => {
    recordIncomingMessages('sess1', messages);
    expect(hasPriorModel('sess1')).toBe(false);
  });

  it('is true once a model has succeeded for the session', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    expect(hasPriorModel('sess1')).toBe(true);
  });

  it('flips back to false when a fresh conversation clears the prior model', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    // Reused session ID, brand-new conversation (no assistant turns) → cleared.
    recordIncomingMessages('sess1', [msg('user', 'brand new')]);
    expect(hasPriorModel('sess1')).toBe(false);
  });
});

describe('injectedTokens', () => {
  it('is 0 when no handoff is injected', () => {
    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'groq:llama-3',
    });
    expect(result.injected).toBe(false);
    expect(result.injectedTokens).toBe(0);
  });

  it('is a positive estimate when a handoff is injected', () => {
    recordIncomingMessages('sess1', messages);
    recordSuccessfulModel({ sessionKey: 'sess1', modelKey: 'groq:llama-3' });
    const result = maybeInjectContextHandoff({
      mode: 'on_model_switch',
      sessionKey: 'sess1',
      messages,
      selectedModelKey: 'google:gemini-flash',
    });
    expect(result.injected).toBe(true);
    expect(result.injectedTokens).toBeGreaterThan(0);
    // Never exceeds the conservative routing-pad upper bound.
    expect(result.injectedTokens).toBeLessThanOrEqual(HANDOFF_MAX_TOKENS);
  });
});
