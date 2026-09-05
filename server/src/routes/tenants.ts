import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  deleteTenant,
  rotateTenantKey,
  getTenantUsage,
} from '../services/tenant.js';

export const tenantsRouter = Router();

// All tenant management routes require dashboard session auth.
tenantsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  systemPrompt: z.string().optional(),
  maxRpm: z.number().int().min(0).optional(),
  maxRpd: z.number().int().min(0).optional(),
  maxTpm: z.number().int().min(0).optional(),
  allowedModels: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().nullable().optional(),
  maxRpm: z.number().int().min(0).optional(),
  maxRpd: z.number().int().min(0).optional(),
  maxTpm: z.number().int().min(0).optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
});

// GET /api/tenants — list all tenants
tenantsRouter.get('/', (_req: Request, res: Response) => {
  const tenants = listTenants();
  res.json(tenants);
});

// POST /api/tenants — create a new tenant
tenantsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
    const tenant = createTenant(parsed.data);
    res.status(201).json(tenant);
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message ?? '创建租户失败' } });
  }
});

// GET /api/tenants/:id — get tenant details
tenantsRouter.get('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  const tenant = getTenant(id);
  if (!tenant) {
    res.status(404).json({ error: { message: '租户不存在' } });
    return;
  }
  res.json(tenant);
});

// PATCH /api/tenants/:id — update tenant settings
tenantsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const ok = updateTenant(id, parsed.data);
  if (!ok) {
    res.status(404).json({ error: { message: '租户不存在或无更新' } });
    return;
  }
  res.json({ success: true });
});

// DELETE /api/tenants/:id — delete a tenant
tenantsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const ok = deleteTenant(id);
  if (!ok) {
    res.status(404).json({ error: { message: '租户不存在' } });
    return;
  }
  res.json({ success: true });
});

// POST /api/tenants/:id/rotate — rotate tenant API key
tenantsRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const newKey = rotateTenantKey(id);
  if (!newKey) {
    res.status(404).json({ error: { message: '租户不存在' } });
    return;
  }
  res.json({ apiKey: newKey });
});

// GET /api/tenants/:id/usage — get tenant usage stats
tenantsRouter.get('/:id/usage', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const tenant = getTenant(id);
  if (!tenant) {
    res.status(404).json({ error: { message: '租户不存在' } });
    return;
  }

  const usage = getTenantUsage(id);
  res.json({ tenant: { id: tenant.id, name: tenant.name }, ...usage });
});
