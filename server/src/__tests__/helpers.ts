import type { Express } from 'express';
import { getUnifiedApiKey } from '../db/index.js';

/**
 * Test request helper that includes the unified API key on every request.
 * All endpoints now require authentication.
 */
export async function authedRequest(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const apiKey = getUnifiedApiKey();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data, headers: res.headers };
}
