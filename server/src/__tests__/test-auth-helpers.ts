import type { Express } from 'express';
import { AddressInfo } from 'node:net';

/** Must match `validateSessionPasswordOrExit` minimum length (32+). */
export function setTestSessionPasswordEnv() {
  process.env.SESSION_PASSWORD = '0'.repeat(32);
}

export type HttpJsonResult = { status: number; body: unknown; setCookie: string | null };

export async function httpJson(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  cookieHeader?: string,
): Promise<HttpJsonResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address() as AddressInfo;
        const port = addr.port;
        const url = `http://127.0.0.1:${port}${path}`;
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookieHeader) headers['Cookie'] = cookieHeader;
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const b = await res.json().catch(() => null);
        const setCookie = res.headers.get('set-cookie');
        server.close();
        resolve({ status: res.status, body: b, setCookie });
      } catch (e) {
        try {
          server.close();
        } catch {
          // ignore
        }
        reject(e);
      }
    });
  });
}

/** First-time setup: returns `Cookie` header value to send on later requests. */
export async function createTestUserSession(app: Express): Promise<string> {
  const r = await httpJson(app, 'POST', '/api/auth/setup', {
    username: 'testadmin',
    password: 'testpass12',
    confirmPassword: 'testpass12',
  });
  if (r.status !== 201) {
    throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const c = r.setCookie;
  if (!c) throw new Error('no Set-Cookie from setup');
  const m = c.match(/^([^;]+)/);
  return m ? m[1]! : '';
}
