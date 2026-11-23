export interface SeezD1Statement {
  bind(...values: unknown[]): SeezD1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>
  run(): Promise<{ meta?: { last_row_id?: number } }>
}

export interface SeezD1Database {
  prepare(query: string): SeezD1Statement
}

export interface SeezEnv {
  SEEZ_DB: SeezD1Database
  SEEZ_ADMIN_PASSWORD?: string
}

export interface SeezContext {
  request: Request
  env: SeezEnv
}

export type SeezFunction = (context: SeezContext) => Response | Promise<Response>

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8')
  responseHeaders.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers: responseHeaders })
}

export function errorResponse(message: string, type: string, status: number): Response {
  return json({ error: { message, type } }, status)
}

export async function readJson(request: Request, maxBytes = 4096): Promise<unknown | Response> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maxBytes) {
    return errorResponse('Request body is too large.', 'body_too_large', 413)
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return errorResponse('Request body is too large.', 'body_too_large', 413)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return errorResponse('Invalid JSON body.', 'invalid_json', 400)
  }
}

export function isErrorResponse(value: unknown): value is Response {
  return value instanceof Response
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const [key, ...valueParts] = part.trim().split('=')
    if (key === name) return valueParts.join('=') || null
  }
  return null
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createAdminSession(env: SeezEnv, request: Request): Promise<Response> {
  const token = randomToken()
  const tokenHash = await sha256(token)
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + 60 * 60 * 24 * 7
  await env.SEEZ_DB.prepare(`
    INSERT INTO seez_admin_sessions (token_hash, expires_at, created_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, expiresAt, now).run()

  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  const headers = new Headers()
  headers.append(
    'Set-Cookie',
    `seez_admin_session=${token}; Path=/api/seez; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}${secure}`,
  )
  return json({ authenticated: true }, 200, headers)
}

export async function adminSessionIsValid(env: SeezEnv, request: Request): Promise<boolean> {
  const token = getCookie(request, 'seez_admin_session')
  if (!token || token.length !== 64 || !/^[a-f0-9]+$/.test(token)) return false
  const tokenHash = await sha256(token)
  const now = Math.floor(Date.now() / 1000)
  const session = await env.SEEZ_DB.prepare(`
    SELECT expires_at FROM seez_admin_sessions WHERE token_hash = ?
  `).bind(tokenHash).first<{ expires_at: number }>()

  if (!session) return false
  if (session.expires_at <= now) {
    await env.SEEZ_DB.prepare('DELETE FROM seez_admin_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run()
    return false
  }
  return true
}

export async function clearAdminSession(env: SeezEnv, request: Request): Promise<Response> {
  const token = getCookie(request, 'seez_admin_session')
  if (token && token.length === 64 && /^[a-f0-9]+$/.test(token)) {
    const tokenHash = await sha256(token)
    await env.SEEZ_DB.prepare('DELETE FROM seez_admin_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run()
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  const headers = new Headers()
  headers.append('Set-Cookie', `seez_admin_session=; Path=/api/seez; HttpOnly; SameSite=Strict; Max-Age=0${secure}`)
  return json({ authenticated: false }, 200, headers)
}

export async function rateLimit(
  env: SeezEnv,
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const key = `${scope}:${await sha256(ip)}`
  const now = Math.floor(Date.now() / 1000)
  await env.SEEZ_DB.prepare('DELETE FROM seez_rate_limits WHERE reset_at <= ?').bind(now).run()
  const existing = await env.SEEZ_DB.prepare(`
    SELECT attempts, reset_at FROM seez_rate_limits WHERE bucket = ?
  `).bind(key).first<{ attempts: number; reset_at: number }>()

  if (existing && existing.reset_at > now && existing.attempts >= limit) return false

  await env.SEEZ_DB.prepare(`
    INSERT INTO seez_rate_limits (bucket, attempts, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
  `).bind(key, now + windowSeconds, now, now, now + windowSeconds).run()

  return true
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let mismatch = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return mismatch === 0
}
