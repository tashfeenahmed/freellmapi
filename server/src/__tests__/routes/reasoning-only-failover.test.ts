import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Reasoning-only responses used to pass as success on the shared inbound-chat
// lane (#1184): the empty-completion check required the turn to have no text,
// no reasoning AND no tool calls, so a stream that spent the whole budget on a
// thinking trace — then dropped or truncated the answer — was delivered as a
// blank success and the failover ladder never moved. Coding agents (the main
// consumers) treat a reasoning-only turn as an empty assistant message and
// stall.
//
// The fix mirrors the Anthropic surface, which already fails over on
// reasoning-only turns: the empty check drops `!reasoning`, and streaming
// holds thinking deltas until something commit-worthy arrives, so a
// thinking-only stream stays uncommitted through to stream end and the next
// attempt happens invisibly.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, setSetting, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const { TOOL_ARGUMENT_VALIDATION_SETTING } = await import('../../lib/tool-validate.js');

async function post(app: Express, body: Record<string, unknown>, path = '/api/chat', headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* NDJSON stream */ }
  return { status: res.status, body: json, raw, routedVia: res.headers.get('x-routed-via') };
}

/** Collect content / thinking / tool_calls out of the Ollama NDJSON stream. */
function readStream(raw: string): { content: string; thinking: string } {
  let content = '';
  let thinking = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let frame: any;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.message?.content) content += frame.message.content;
    if (frame.message?.thinking) thinking += frame.message.thinking;
  }
  return { content, thinking };
}

/** Attempt 1: a pure thinking trace, then the stream just ends. */
function* reasoningOnlyTurn() {
  yield { choices: [{ delta: { reasoning_content: 'pondering the void ' } }] };
  yield { choices: [{ delta: { reasoning_content: 'still pondering' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

function* textTurn(text: string) {
  yield { choices: [{ delta: { content: text } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

function* reasoningThenTextTurn() {
  yield { choices: [{ delta: { reasoning_content: 'working it out' } }] };
  yield { choices: [{ delta: { content: 'the answer' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

function insertKey(label: string): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt('test-key');
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(label, encrypted, iv, authTag);
}

let builtApp: Express;
const app = () => builtApp;

describe('reasoning-only turns fail over on the shared inbound-chat lane (#1184)', () => {

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setSetting('ollama_emulation', 'open-loopback');
    builtApp = createApp();
    setRoutingStrategy('priority');
    insertKey('first');
    insertKey('second');
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('non-streaming: a reasoning-only answer fails over to the next key', async () => {
    chatCompletion
      .mockResolvedValueOnce({ choices: [{ message: { reasoning_content: 'all thinking, no answer' }, finish_reason: 'stop' }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'the real answer' }, finish_reason: 'stop' }] });

    const { status, body } = await post(app(), {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(body.message?.content).toBe('the real answer');
    // The failed attempt's thinking trace must not leak into the served turn.
    expect(body.message?.thinking ?? '').not.toContain('all thinking');
  });

  it('streaming: a thinking-only stream fails over and the client never sees attempt one', async () => {
    streamChatCompletion
      .mockImplementationOnce(() => reasoningOnlyTurn())
      .mockImplementationOnce(() => textTurn('the real answer'));

    const { status, raw } = await post(app(), {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const { content, thinking } = readStream(raw);
    expect(content).toBe('the real answer');
    expect(thinking).not.toContain('pondering');
  });

  it('streaming: thinking that precedes real content is delivered, in order', async () => {
    streamChatCompletion.mockImplementation(() => reasoningThenTextTurn());

    const { status, raw } = await post(app(), {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    const { content, thinking } = readStream(raw);
    expect(content).toBe('the answer');
    expect(thinking).toContain('working it out');
    const thinkingIdx = raw.indexOf('working it out');
    const contentIdx = raw.indexOf('the answer');
    expect(thinkingIdx).toBeGreaterThan(-1);
    expect(thinkingIdx).toBeLessThan(contentIdx);
  });
});

// #1642: holding reasoning uncommitted for minutes made idle-watchdog clients
// (Claude Code) hang up. Past REASONING_HOLD_MAX_MS the attempt commits with
// its real status + routing headers and keeps the stream alive; dying after
// that goes through the surface's normal mid-stream error path.
describe('long reasoning commits and keeps the stream alive (#1642)', () => {
  let skew = 0;
  const realNow = Date.now.bind(Date);
  const auth = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}`, 'anthropic-version': '2023-06-01' });
  const req = { model: 'auto', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] };

  /** Reasoning that outlasts the hold window, then optionally an answer. */
  function* longReasoning(answer: string | null) {
    yield { choices: [{ delta: { reasoning_content: 'deep thought ' } }] };
    skew += 16_000;
    yield { choices: [{ delta: { reasoning_content: 'still thinking' } }] };
    if (answer) yield { choices: [{ delta: { content: answer } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  }

  beforeEach(() => {
    skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('/v1/messages: pings once committed, then delivers thinking and the answer', async () => {
    streamChatCompletion.mockImplementation(() => longReasoning('the answer'));
    const { status, raw, routedVia } = await post(app(), req, '/v1/messages', auth());
    expect(status).toBe(200);
    expect(routedVia).toBeTruthy();
    const start = raw.indexOf('event: message_start');
    const ping = raw.indexOf('event: ping');
    expect(start).toBeGreaterThan(-1);
    expect(ping).toBeGreaterThan(start);
    expect(raw.indexOf('deep thought still thinking')).toBeGreaterThan(ping);
    expect(raw).toContain('the answer');
    expect(raw).toContain('event: message_stop');
  });

  it('/v1/messages: a committed reasoning-only stream ends with an error event, not a blank success', async () => {
    streamChatCompletion.mockImplementation(() => longReasoning(null));
    const { status, raw } = await post(app(), req, '/v1/messages', auth());
    expect(status).toBe(200);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(raw).toContain('event: error');
    expect(raw).not.toContain('event: message_stop');
  });

  it('/v1/chat/completions: streams the reasoning live once committed, answer after it', async () => {
    streamChatCompletion.mockImplementation(() => longReasoning('the answer'));
    const { status, raw, routedVia } = await post(app(), req, '/v1/chat/completions', auth());
    expect(status).toBe(200);
    expect(routedVia).toBeTruthy();
    const thought = raw.indexOf('still thinking');
    expect(thought).toBeGreaterThan(-1);
    expect(thought).toBeLessThan(raw.indexOf('the answer'));
  });

  it('/v1/chat/completions: a committed reasoning-only stream ends with stream_error', async () => {
    streamChatCompletion.mockImplementation(() => longReasoning(null));
    const { status, raw } = await post(app(), req, '/v1/chat/completions', auth());
    expect(status).toBe(200);
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
    expect(raw).toContain('stream_error');
    expect(raw).toContain('data: [DONE]');
  });

  describe('after an early commit', () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    function* longReasoningThenBadToolCall(prefix = '') {
      yield { choices: [{ delta: { reasoning_content: 'deep thought ' } }] };
      skew += 16_000;
      yield { choices: [{ delta: { reasoning_content: 'still thinking' } }] };
      if (prefix) yield { choices: [{ delta: { content: prefix } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    }
    afterEach(() => { getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOOL_ARGUMENT_VALIDATION_SETTING); });

    it('/v1/messages: still validates tool arguments and ends with an error event', async () => {
      setSetting(TOOL_ARGUMENT_VALIDATION_SETTING, '1');
      streamChatCompletion.mockImplementation(() => longReasoningThenBadToolCall());
      const { raw } = await post(app(), { ...req, tools: [{ name: 'lookup', description: 'find', input_schema: schema }] }, '/v1/messages', auth());
      expect(raw).toContain('event: ping');
      expect(raw).toContain('event: error');
      expect(raw).not.toContain('"tool_use"');
    });

    it('/v1/chat/completions: still validates tool arguments and ends with stream_error', async () => {
      setSetting(TOOL_ARGUMENT_VALIDATION_SETTING, '1');
      streamChatCompletion.mockImplementation(() => longReasoningThenBadToolCall());
      const tools = [{ type: 'function', function: { name: 'lookup', description: 'find', parameters: schema } }];
      const { raw } = await post(app(), { ...req, tools }, '/v1/chat/completions', auth());
      expect(raw).toContain('still thinking');
      expect(raw).toContain('stream_error');
      expect(raw).not.toContain('"tool_calls":[');
    });

    it.each([
      ['no text', ''],
      ['whitespace-only text', '\n\n'],
    ])('/api/chat (Ollama lane): still validates tool arguments after %s, ending with an error frame', async (_label, prefix) => {
      setSetting(TOOL_ARGUMENT_VALIDATION_SETTING, '1');
      streamChatCompletion.mockImplementation(() => longReasoningThenBadToolCall(prefix));
      const tools = [{ type: 'function', function: { name: 'lookup', description: 'find', parameters: schema } }];
      const { raw } = await post(app(), { ...req, tools });
      const frames = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      expect(readStream(raw).thinking).toContain('still thinking');
      expect(raw).not.toContain('"lookup"');
      expect(frames.at(-1)).toMatchObject({ error: expect.stringMatching(/argument/i), done: true });
    });

    it('/v1/chat/completions: json mode never commits early, so prose still fails over invisibly', async () => {
      streamChatCompletion
        .mockImplementationOnce(() => longReasoning('just some prose'))
        .mockImplementationOnce(() => textTurn('{"ok":true}'));
      const { status, raw } = await post(app(), { ...req, response_format: { type: 'json_object' } }, '/v1/chat/completions', auth());
      expect(status).toBe(200);
      expect(streamChatCompletion).toHaveBeenCalledTimes(2);
      expect(raw).toContain('{\\"ok\\":true}');
      expect(raw).not.toContain('deep thought');
      expect(raw).not.toContain('stream_error');
    });

    it.each(['/v1/messages', '/v1/chat/completions'])('%s: a client that leaves after the early commit is not logged as a provider failure', async (path) => {
      // The upstream stalls until the server has seen the hang-up, then ends empty.
      let hungUp!: () => void;
      const clientLeft = new Promise<void>(r => { hungUp = r; });
      let finished!: () => void;
      const attemptOver = new Promise<void>(r => { finished = r; });
      async function* reasoningThenStall() {
        try {
          yield { choices: [{ delta: { reasoning_content: 'deep thought ' } }] };
          skew += 16_000;
          yield { choices: [{ delta: { reasoning_content: 'still thinking' } }] };
          await clientLeft;
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        } finally { finished(); }
      }
      streamChatCompletion.mockImplementation(() => reasoningThenStall());
      getDb().prepare('DELETE FROM requests').run();
      const server = app().listen(0, '127.0.0.1');
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
      server.on('connection', socket => socket.on('close', () => setImmediate(hungUp)));
      const abort = new AbortController();
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, {
        method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify(req),
      });
      expect(res.status).toBe(200); // committed early: headers are out
      abort.abort();
      await attemptOver;
      await new Promise(r => setImmediate(r));
      server.close();
      expect(streamChatCompletion).toHaveBeenCalledTimes(1);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'error'").get()).toEqual({ n: 0 });
    });
  });
});
