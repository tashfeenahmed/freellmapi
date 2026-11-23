import {
  adminSessionIsValid,
  errorResponse,
  isErrorResponse,
  json,
  rateLimit,
  readJson,
  type SeezFunction,
} from '../../../cloudflare/seez'

interface OrderInput {
  customerName: string
  customerPhone: string
  address: string
  perfume: string
  volumeMl: number
}

function validateOrder(value: unknown): OrderInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (typeof body.customerName !== 'string'
    || typeof body.customerPhone !== 'string'
    || typeof body.address !== 'string'
    || typeof body.perfume !== 'string'
    || typeof body.volumeMl !== 'number'
    || !Number.isInteger(body.volumeMl)) return null

  const order = {
    customerName: body.customerName.trim(),
    customerPhone: body.customerPhone.trim(),
    address: body.address.trim(),
    perfume: body.perfume.trim(),
    volumeMl: body.volumeMl,
  }
  if (
    order.customerName.length < 1 || order.customerName.length > 100
    || order.customerPhone.length < 7 || order.customerPhone.length > 24
    || !/^[+0-9() -]+$/.test(order.customerPhone)
    || order.address.length < 5 || order.address.length > 500
    || order.perfume.length < 1 || order.perfume.length > 100
    || order.volumeMl < 1 || order.volumeMl > 5000
  ) return null
  return order
}

export const onRequestPost: SeezFunction = async ({ request, env }) => {
  if (!await rateLimit(env, request, 'orders', 20, 60)) {
    return errorResponse('Too many order attempts. Please try again later.', 'rate_limit_error', 429)
  }
  const body = await readJson(request)
  if (isErrorResponse(body)) return body
  const order = validateOrder(body)
  if (!order) {
    return errorResponse('Please check the name, phone, address, perfume, and ml amount.', 'invalid_order', 400)
  }

  const createdAt = new Date().toISOString()
  const result = await env.SEEZ_DB.prepare(`
    INSERT INTO seez_orders (customer_name, customer_phone, address, perfume, volume_ml, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    order.customerName,
    order.customerPhone,
    order.address,
    order.perfume,
    order.volumeMl,
    createdAt,
  ).run()

  return json({ id: result.meta?.last_row_id ?? null, createdAt }, 201)
}

export const onRequestGet: SeezFunction = async ({ request, env }) => {
  if (!await adminSessionIsValid(env, request)) {
    return errorResponse('Admin sign-in is required.', 'authentication_error', 401)
  }

  const result = await env.SEEZ_DB.prepare(`
    SELECT id, customer_name AS customerName, customer_phone AS customerPhone,
      address, perfume, volume_ml AS volumeMl, created_at AS createdAt
    FROM seez_orders
    ORDER BY id DESC
    LIMIT 500
  `).all()

  return json({ orders: result.results ?? [] })
}
