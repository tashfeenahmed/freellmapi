import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Stream commit point (M13). A client that hangs up mid-stream is a 'canceled'
// request on every streaming surface: never 'success' (the answer was not
// delivered, and /v1/chat/completions would cache the truncated text) and
// never 'error' (the provider did nothing wrong, and an error row counts
// against it in the stats). Two ways the pump learns the client left:
// - the provider keeps yielding and the pump's `if (clientGone) break` fires;
//   that break used to fall through to the success path, or, before the
//   commit point, return with no row at all;
// - the provider honours the abort signal and rejects; inbound-chat (Gemini,
//   Ollama) used to log that as a provider 'error'.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getProvider: () => fakeProvider, resolveProvider: () => fakeProvider };
});

const logged: string[] = [];
vi.mock('../../lib/request-log.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    logRequest: (...args: any[]) => {
      logged.push(args[3]);
      return actual.logRequest(...args);
    },
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

// Longer than the 256-char hold window /v1/responses and /v1/messages keep
// before committing, so the first chunk alone commits every surface.
const LONG = 'The answer is forty-two, and here is a long explanation of why. '.repeat(6);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(5);
}

type Mode = 'keeps-yielding' | 'honours-abort';

/** A provider turn that waits for the client to leave. `committed` sends the
 *  long first chunk before waiting; otherwise nothing comes before it. */
function turn(committed: boolean, mode: Mode) {
  return async function* (_key: string, _messages: unknown, _model: string, opts: { signal?: AbortSignal }) {
    if (committed) yield { choices: [{ delta: { role: 'assistant', content: LONG } }] };
    await until(() => opts?.signal?.aborted === true, 2000);
    if (mode === 'honours-abort') throw opts.signal!.reason;
    yield { choices: [{ delta: { content: ' More text after the client left.' } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 70, total_tokens: 75 } };
  };
}

/** Starts the request, hangs up once `committed` text arrives (or straight
 *  away), then waits for the server's request row. */
async function hangUp(app: Express, path: string, body: any, headers: Record<string, string>, committed: boolean) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const client = new AbortController();
  const pending = fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: client.signal,
  });
  try {
    if (committed) {
      const res = await pending;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('forty-two')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } else {
      await sleep(50);
    }
    client.abort();
    await pending.catch(() => {});
  } catch {
    // The abort rejects whichever read was pending.
  }
  await until(() => logged.length > 0, 3000);
  await sleep(50);
  server.close();
}

describe('a client that hangs up mid-stream', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    logged.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bearer = () => ({ Authorization: `Bearer ${key}` });

  const surfaces: Array<{ name: string; path: string; body: any; headers: () => Record<string, string> }> = [
    { name: '/v1/chat/completions', path: '/v1/chat/completions', body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }, headers: bearer },
    { name: '/v1/completions', path: '/v1/completions', body: { model: 'auto', stream: true, prompt: 'hi' }, headers: bearer },
    { name: '/v1/responses', path: '/v1/responses', body: { input: 'hi', stream: true }, headers: bearer },
    { name: '/v1/messages', path: '/v1/messages', body: { model: 'auto', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }, headers: () => ({ 'x-api-key': key }) },
    { name: 'gemini streamGenerateContent (inbound-chat)', path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, headers: () => ({ 'x-goog-api-key': key }) },
  ];

  const cases: Array<{ label: string; committed: boolean; mode: Mode }> = [
    { label: 'after the commit point, provider keeps yielding', committed: true, mode: 'keeps-yielding' },
    { label: 'after the commit point, provider honours the abort', committed: true, mode: 'honours-abort' },
    { label: 'before the commit point, provider keeps yielding', committed: false, mode: 'keeps-yielding' },
  ];

  for (const surface of surfaces) {
    for (const c of cases) {
      it(`${surface.name}: ${c.label} -> one 'canceled' row`, async () => {
        streamChatCompletion.mockImplementation(turn(c.committed, c.mode));

        await hangUp(app, surface.path, surface.body, surface.headers(), c.committed);

        expect(logged).toEqual(['canceled']);
      });
    }
  }
});
