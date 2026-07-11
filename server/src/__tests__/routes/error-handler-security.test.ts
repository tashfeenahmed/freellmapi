import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { errorHandler } from '../../middleware/errorHandler.js';

async function triggerError(message: string, status: number) {
  const app = express();
  app.get('/boom', () => {
    const err = new Error(message);
    (err as any).status = status;
    throw err;
  });
  app.use(errorHandler);

  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/boom`);
  const json = await res.json();
  server.close();
  return { status: res.status, body: json };
}

describe('Error handler — production mode', () => {
  const orig = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = orig;
  });

  it('hides internal error details on 5xx in production', async () => {
    const { status, body } = await triggerError('S3 bucket credentials leaked', 500);
    expect(status).toBe(500);
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.message).not.toContain('S3');
  });

  it('still reports validation-style messages for 4xx errors', async () => {
    const { status, body } = await triggerError('Missing required field: model', 400);
    expect(status).toBe(400);
    expect(body.error.message).toBe('Missing required field: model');
  });
});
