import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1102: request analytics gain a `caller` dimension ('http' | 'mcp' | 'web')
// so self-hosters can tell which gateway pathway produced a request. The
// migration adds the column; logRequest writes it; NULL for legacy callers.

vi.mock('../../services/request-retention.js', () => ({
  pruneRequestAnalytics: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';

interface RequestRow {
  platform: string;
  model_id: string;
  caller: string | null;
  status: string;
}

function latestRequest(): RequestRow | undefined {
  return getDb().prepare(
    `SELECT platform, model_id, caller, status FROM requests ORDER BY id DESC LIMIT 1`,
  ).get() as RequestRow | undefined;
}

describe('logRequest caller dimension (#1102)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('persists the caller when provided', () => {
    logRequest('groq', 'llama-3.3-70b', 7, 'success', 10, 5, 120, null, null, null, null, 'http');
    expect(latestRequest()?.caller).toBe('http');
  });

  it('persists mcp and web callers', () => {
    logRequest('groq', 'llama-3.3-70b', 7, 'success', 10, 5, 120, null, null, null, null, 'mcp');
    expect(latestRequest()?.caller).toBe('mcp');
    logRequest('groq', 'llama-3.3-70b', 7, 'success', 10, 5, 120, null, null, null, null, 'web');
    expect(latestRequest()?.caller).toBe('web');
  });

  it('writes NULL for legacy callers that do not pass a caller', () => {
    logRequest('groq', 'llama-3.3-70b', 7, 'success', 10, 5, 120, null);
    expect(latestRequest()?.caller).toBeNull();
  });
});
