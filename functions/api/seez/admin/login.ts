import {
  constantTimeEqual,
  createAdminSession,
  errorResponse,
  isErrorResponse,
  rateLimit,
  readJson,
  sameOrigin,
  type SeezFunction,
} from '../../../../cloudflare/seez'

export const onRequestPost: SeezFunction = async ({ request, env }) => {
  if (!sameOrigin(request)) {
    return errorResponse('Sign-in requests must come from this site.', 'invalid_origin', 403)
  }
  if (!await rateLimit(env, request, 'admin-login', 10, 60)) {
    return errorResponse('Too many sign-in attempts. Try again in a minute.', 'rate_limit_error', 429)
  }
  if (!env.SEEZ_ADMIN_PASSWORD || env.SEEZ_ADMIN_PASSWORD.length < 16) {
    return errorResponse(
      'Set a unique admin password of at least 16 characters in Cloudflare Pages secrets.',
      'admin_not_configured',
      503,
    )
  }

  const body = await readJson(request, 1024)
  if (isErrorResponse(body)) return body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Enter the admin password.', 'invalid_credentials', 400)
  }
  const password = (body as Record<string, unknown>).password
  if (typeof password !== 'string' || password.length > 256
    || !constantTimeEqual(password, env.SEEZ_ADMIN_PASSWORD)) {
    return errorResponse('The admin password is incorrect.', 'authentication_error', 401)
  }

  return createAdminSession(env, request)
}
