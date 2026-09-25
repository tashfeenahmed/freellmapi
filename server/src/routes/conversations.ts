import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPostgresPool } from '../db/postgres.js';

export const conversationsRouter = Router();

const MAX_TITLE_LEN = 200;
const MAX_MESSAGES_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_LEN = 250;
const MAX_SYSTEM_PROMPT_LEN = 64_000;

const createSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LEN).optional(),
  messages: z.array(z.unknown()).optional(),
  model: z.string().trim().max(MAX_MODEL_LEN).nullish(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_LEN).nullish(),
});

const updateSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LEN).optional(),
  messages: z.array(z.unknown()).optional(),
  model: z.string().trim().max(MAX_MODEL_LEN).nullable().optional(),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_LEN).nullable().optional(),
});

interface ConversationRow {
  id: number;
  title: string;
  messages_json: string;
  model: string | null;
  system_prompt: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function parseMessages(json: string): unknown[] {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toJson(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    messages: parseMessages(row.messages_json),
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
  };
}

async function getConversation(id: number): Promise<ConversationRow | undefined> {
  const pool = getPostgresPool();
  const res = await pool.query('SELECT * FROM playground_conversations WHERE id = $1', [id]);
  return res.rows[0];
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid conversation id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Conversation not found' } });
}

function serialiseMessages(messages: unknown[], res: Response): string | null {
  const json = JSON.stringify(messages);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_MESSAGES_BYTES) {
    res.status(413).json({
      error: {
        message:
          `Conversation is too large to save (${Math.round(bytes / 1024)} KB; the limit is ` +
          `${Math.round(MAX_MESSAGES_BYTES / 1024)} KB). Start a new conversation to keep going.`,
        type: 'conversation_too_large',
      },
    });
    return null;
  }
  return json;
}

conversationsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    const result = await pool.query(`
      SELECT id, title, model, messages_json, created_at_ms, updated_at_ms
        FROM playground_conversations
       ORDER BY updated_at_ms DESC, id DESC
    `);
    res.json(result.rows.map(row => {
      const messages = parseMessages(row.messages_json);
      return {
        id: row.id,
        title: row.title,
        model: row.model,
        messageCount: messages.length,
        createdAt: Number(row.created_at_ms),
        updatedAt: Number(row.updated_at_ms),
      };
    }));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to list conversations' } });
  }
});

conversationsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const row = await getConversation(id);
    if (!row) return notFound(res);
    res.json(toJson(row));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to get conversation' } });
  }
});

conversationsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation' } });
    return;
  }
  const messagesJson = serialiseMessages(parsed.data.messages ?? [], res);
  if (messagesJson === null) return;

  const now = Date.now();
  try {
    const pool = getPostgresPool();
    const result = await pool.query(
      `INSERT INTO playground_conversations
         (title, messages_json, model, system_prompt, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        parsed.data.title ?? '',
        messagesJson,
        parsed.data.model ?? null,
        parsed.data.systemPrompt ?? null,
        now,
        now,
      ]
    );
    res.status(201).json(toJson(result.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to create conversation' } });
  }
});

conversationsRouter.put('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation update' } });
    return;
  }
  try {
    const row = await getConversation(id);
    if (!row) return notFound(res);

    const { title, messages, model, systemPrompt } = parsed.data;
    const messagesJson = messages === undefined
      ? row.messages_json
      : serialiseMessages(messages, res);
    if (messagesJson === null) return;

    const pool = getPostgresPool();
    const updated = await pool.query(
      `UPDATE playground_conversations
         SET title = $1, messages_json = $2, model = $3, system_prompt = $4, updated_at_ms = $5
       WHERE id = $6
       RETURNING *`,
      [
        title ?? row.title,
        messagesJson,
        model === undefined ? row.model : model,
        systemPrompt === undefined ? row.system_prompt : systemPrompt,
        Date.now(),
        id,
      ]
    );
    res.json(toJson(updated.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to update conversation' } });
  }
});

conversationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const pool = getPostgresPool();
    const info = await pool.query('DELETE FROM playground_conversations WHERE id = $1', [id]);
    if ((info.rowCount ?? 0) === 0) return notFound(res);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to delete conversation' } });
  }
});
