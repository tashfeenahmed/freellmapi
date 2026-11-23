import { adminSessionIsValid, json, type SeezFunction } from '../../../../cloudflare/seez'

export const onRequestGet: SeezFunction = async ({ request, env }) =>
  json({ authenticated: await adminSessionIsValid(env, request) })
