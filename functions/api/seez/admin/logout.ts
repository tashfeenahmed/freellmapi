import {
  clearAdminSession,
  errorResponse,
  sameOrigin,
  type SeezFunction,
} from '../../../../cloudflare/seez'

export const onRequestPost: SeezFunction = async ({ request, env }) => {
  if (!sameOrigin(request)) {
    return errorResponse('Sign-out requests must come from this site.', 'invalid_origin', 403)
  }
  return clearAdminSession(env, request)
}
