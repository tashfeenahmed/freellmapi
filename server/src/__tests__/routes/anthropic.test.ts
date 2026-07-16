import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('POST /v1/messages (Anthropic endpoint)', () => {
  let app: Express;
  let apiKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    apiKey = getUnifiedApiKey();
  });

  // ---- Authentication ----

  it('rejects requests without API key (401)', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('rejects wrong API key in Authorization header (401)', async () => {
    const { status } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    }, { 'Authorization': 'Bearer wrong-key' });

    expect(status).toBe(401);
  });

  it('rejects wrong API key in x-api-key header (401)', async () => {
    const { status } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    }, { 'x-api-key': 'wrong-key' });

    expect(status).toBe(401);
  });

  it('accepts valid x-api-key header', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    }, { 'x-api-key': apiKey });

    expect(status).not.toBe(401); // Will 400/503 because no models configured
    expect(body).toBeDefined();
  });

  // ---- Request validation ----

  it('rejects missing max_tokens (400)', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
    }, { 'x-api-key': apiKey });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('rejects empty messages array (400)', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [],
      max_tokens: 1024,
    }, { 'x-api-key': apiKey });

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('rejects max_tokens <= 0 (400)', async () => {
    const { status } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 0,
    }, { 'x-api-key': apiKey });

    expect(status).toBe(400);
  });

  // ---- Image/tool gating ----

  it('returns routing error for image request when no models configured', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
      }],
      max_tokens: 1024,
    }, { 'x-api-key': apiKey });

    // With no models in the DB, routeRequest fails before vision check
    expect(status).toBe(429);
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toContain('exhausted');
  });

  it('returns routing error for tool request when no models configured', async () => {
    const { status, body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
      tools: [{ name: 'test_tool', input_schema: { type: 'object' } }],
    }, { 'x-api-key': apiKey });

    // With no models in the DB, routeRequest fails before tool check
    expect(status).toBe(429);
    expect(body.error.type).toBe('api_error');
  });

  // ---- Error format ----

  it('returns Anthropic error format {type:"error", error:{type, message}}', async () => {
    const { body } = await request(app, 'POST', '/v1/messages', {
      model: 'auto',
      messages: [],
      max_tokens: 1024,
    }, { 'x-api-key': apiKey });

    expect(body.type).toBe('error');
    expect(body.error).toHaveProperty('type');
    expect(body.error).toHaveProperty('message');
  });
});
