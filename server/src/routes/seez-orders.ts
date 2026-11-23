import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createProxyRateLimiter } from '../middleware/rateLimit.js';

export const seezOrdersRouter = Router();

const orderSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().min(7).max(24)
    .regex(/^[+0-9() -]+$/, 'Enter a valid phone number'),
  address: z.string().trim().min(5).max(500),
  perfume: z.string().trim().min(1).max(100),
  volumeMl: z.number().int().min(1).max(5000),
}).strict();

seezOrdersRouter.post('/', createProxyRateLimiter(20), (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues[0]?.message ?? 'Please check the order details.',
        type: 'invalid_order',
      },
    });
    return;
  }

  const { customerName, customerPhone, address, perfume, volumeMl } = parsed.data;
  const createdAt = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO seez_orders (customer_name, customer_phone, address, perfume, volume_ml, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(customerName, customerPhone, address, perfume, volumeMl, createdAt);

  res.status(201).json({ id: Number(result.lastInsertRowid), createdAt });
});

seezOrdersRouter.get('/', requireAuth, (_req, res) => {
  const orders = getDb().prepare(`
    SELECT id, customer_name AS customerName, customer_phone AS customerPhone,
      address, perfume, volume_ml AS volumeMl, created_at AS createdAt
    FROM seez_orders
    ORDER BY id DESC
    LIMIT 500
  `).all();

  res.setHeader('Cache-Control', 'no-store');
  res.json({ orders });
});
