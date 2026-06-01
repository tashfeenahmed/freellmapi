import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import {
  AGNES_BASE_URL,
  AGNES_IMAGE_MODEL,
  AGNES_VIDEO_MODEL,
  normalizeAgnesImageModel,
  normalizeAgnesVideoModel,
} from '../providers/agnes.js';
import { extractApiToken, logRequest, timingSafeStringEqual } from '../lib/proxyShared.js';

export const mediaRouter = Router();

const MEDIA_TIMEOUT_MS = 120000;

const imageGenerationSchema = z.object({
  model: z.string().min(1).default(AGNES_IMAGE_MODEL),
  prompt: z.string().min(1),
}).passthrough();

const videoCreateSchema = z.object({
  model: z.string().min(1).default(AGNES_VIDEO_MODEL),
  prompt: z.string().min(1),
}).passthrough();

function requireUnifiedAuth(req: Request, res: Response): boolean {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return false;
  }
  return true;
}

type AgnesKeyRow = { id: number; encrypted_key: string; iv: string; auth_tag: string };

function getAgnesKeyRows(): AgnesKeyRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'agnes'
       AND enabled = 1
       AND status IN ('healthy', 'unknown')
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id ASC
  `).all() as AgnesKeyRow[];
}

function markAgnesKeyError(keyId: number): void {
  getDb().prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
    .run(keyId);
}

function shouldRetryAgnesStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = MEDIA_TIMEOUT_MS): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(res: globalThis.Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text || res.statusText,
        type: 'provider_error',
      },
    };
  }
}

async function proxyAgnesJson(
  req: Request,
  res: Response,
  opts: {
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
    modelId: string;
  },
): Promise<void> {
  const started = Date.now();
  const keys = getAgnesKeyRows();
  if (keys.length === 0) {
    res.status(503).json({
      error: {
        message: 'No enabled Agnes API key is configured. Add an Agnes AI key on the Keys page.',
        type: 'routing_error',
        code: 'no_agnes_key',
      },
    });
    return;
  }

  let lastUpstream: { status: number; body: unknown } | null = null;
  const failures: Array<{ keyId: number; reason: string; status?: number }> = [];

  for (const key of keys) {
    let apiKey: string;
    try {
      apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      markAgnesKeyError(key.id);
      failures.push({ keyId: key.id, reason: 'decrypt_failed' });
      logRequest('agnes', opts.modelId, key.id, 'error', 0, 0, Date.now() - started, 'Failed to decrypt Agnes API key');
      continue;
    }

    try {
      const upstream = await fetchWithTimeout(`${AGNES_BASE_URL}${opts.path}`, {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(opts.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.method === 'POST' ? JSON.stringify(opts.body) : undefined,
      });
      const body = await readJson(upstream);

      logRequest(
        'agnes',
        opts.modelId,
        key.id,
        upstream.ok ? 'success' : 'error',
        0,
        0,
        Date.now() - started,
        upstream.ok ? null : JSON.stringify(body).slice(0, 500),
      );

      if (!upstream.ok && shouldRetryAgnesStatus(upstream.status)) {
        lastUpstream = { status: upstream.status, body };
        failures.push({ keyId: key.id, reason: 'upstream_error', status: upstream.status });
        continue;
      }

      res.status(upstream.status).json(body);
      return;
    } catch (err: any) {
      const message = err?.message ?? 'Agnes media request failed';
      failures.push({ keyId: key.id, reason: message });
      logRequest('agnes', opts.modelId, key.id, 'error', 0, 0, Date.now() - started, message);
    }
  }

  if (lastUpstream) {
    res.status(lastUpstream.status).json(lastUpstream.body);
    return;
  }

  res.status(502).json({
    error: {
      message: 'Provider error (Agnes AI): no Agnes key could complete the request',
      type: 'provider_error',
      code: 'agnes_keys_exhausted',
      failures,
    },
  });
}

mediaRouter.post('/images/generations', async (req: Request, res: Response) => {
  if (!requireUnifiedAuth(req, res)) return;

  const parsed = imageGenerationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const model = normalizeAgnesImageModel(parsed.data.model);
  if (!model) {
    res.status(400).json({
      error: {
        message: `Model '${parsed.data.model}' is not supported by this endpoint. Use '${AGNES_IMAGE_MODEL}'.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    return;
  }

  await proxyAgnesJson(req, res, {
    path: '/images/generations',
    method: 'POST',
    body: { ...parsed.data, model },
    modelId: model,
  });
});

mediaRouter.post('/videos', async (req: Request, res: Response) => {
  if (!requireUnifiedAuth(req, res)) return;

  const parsed = videoCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const model = normalizeAgnesVideoModel(parsed.data.model);
  if (!model) {
    res.status(400).json({
      error: {
        message: `Model '${parsed.data.model}' is not supported by this endpoint. Use '${AGNES_VIDEO_MODEL}'.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    return;
  }

  await proxyAgnesJson(req, res, {
    path: '/videos',
    method: 'POST',
    body: { ...parsed.data, model },
    modelId: model,
  });
});

mediaRouter.get('/videos/:taskId', async (req: Request, res: Response) => {
  if (!requireUnifiedAuth(req, res)) return;

  const taskId = String(req.params.taskId ?? '').trim();
  if (!taskId) {
    res.status(400).json({
      error: {
        message: 'taskId is required',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  await proxyAgnesJson(req, res, {
    path: `/videos/${encodeURIComponent(taskId)}`,
    method: 'GET',
    modelId: AGNES_VIDEO_MODEL,
  });
});
