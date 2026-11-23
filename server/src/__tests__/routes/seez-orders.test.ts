import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function call(app: Express, method: string, path: string, body?: unknown, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => null);
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return { status: response.status, body: result };
}

describe('Seez storefront orders', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('stores a valid customer order and keeps the order list private', async () => {
    const order = {
      customerName: 'Test Customer',
      customerPhone: '+880 1892-753543',
      address: 'House 1, Road 2, Dhaka',
      perfume: 'Noor',
      volumeMl: 50,
    };

    const created = await call(app, 'POST', '/api/seez/orders', order);
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe('number');

    const privateList = await call(app, 'GET', '/api/seez/orders');
    expect(privateList.status).toBe(401);

    const setup = await call(app, 'POST', '/api/auth/setup', {
      email: 'seez-admin@example.com',
      password: 'secure-password',
    });
    expect(setup.status).toBe(201);

    const list = await call(app, 'GET', '/api/seez/orders', undefined, setup.body.token);
    expect(list.status).toBe(200);
    expect(list.body.orders).toContainEqual(expect.objectContaining({
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      address: order.address,
      perfume: order.perfume,
      volumeMl: order.volumeMl,
    }));
  });

  it('rejects invalid order details', async () => {
    const result = await call(app, 'POST', '/api/seez/orders', {
      customerName: '',
      customerPhone: 'x',
      address: '',
      perfume: 'Noor',
      volumeMl: 0,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.type).toBe('invalid_order');
  });
});
