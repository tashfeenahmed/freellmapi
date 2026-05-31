import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const chatsRouter = Router();

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  meta: z.object({
    platform: z.string().optional(),
    model: z.string().optional(),
    latency: z.number().int().nonnegative().optional(),
    fallbackAttempts: z.number().int().nonnegative().optional(),
  }).optional(),
});

const saveChatSchema = z.object({
  sessionId: z.number().int().positive().optional().nullable(),
  selectedModel: z.string().min(1).default('auto'),
  messages: z.array(messageSchema).min(1),
});

function makeTitle(messages: z.infer<typeof messageSchema>[]) {
  const firstUser = messages.find(m => m.role === 'user')?.content.trim();
  if (!firstUser) return 'Untitled chat';
  return firstUser.length > 80 ? `${firstUser.slice(0, 77)}...` : firstUser;
}

function readSession(sessionId: number) {
  const db = getDb();
  const session = db.prepare(`
    SELECT id, title, selected_model, created_at, updated_at
    FROM chat_sessions
    WHERE id = ?
  `).get(sessionId) as any;

  if (!session) return null;

  const messages = db.prepare(`
    SELECT role, content, platform, model, latency_ms, fallback_attempts, created_at
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId) as any[];

  return {
    id: session.id,
    title: session.title,
    selectedModel: session.selected_model,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      meta: {
        platform: m.platform ?? undefined,
        model: m.model ?? undefined,
        latency: m.latency_ms ?? undefined,
        fallbackAttempts: m.fallback_attempts ?? undefined,
      },
    })),
  };
}

chatsRouter.get('/', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.selected_model,
      s.created_at,
      s.updated_at,
      COUNT(m.id) AS message_count
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ?
  `).all(limit) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    title: r.title,
    selectedModel: r.selected_model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
  })));
});

chatsRouter.get('/:id', (req: Request, res: Response) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: { message: 'Invalid chat id' } });
    return;
  }

  const session = readSession(sessionId);
  if (!session) {
    res.status(404).json({ error: { message: 'Chat not found' } });
    return;
  }

  res.json(session);
});

chatsRouter.post('/', (req: Request, res: Response) => {
  const parsed = saveChatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message } });
    return;
  }

  const db = getDb();
  const { sessionId, selectedModel, messages } = parsed.data;
  const title = makeTitle(messages);

  const save = db.transaction(() => {
    let id: number;
    const existing = sessionId
      ? db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionId)
      : undefined;

    if (!sessionId) {
      const result = db.prepare(`
        INSERT INTO chat_sessions (title, selected_model, updated_at)
        VALUES (?, ?, datetime('now'))
      `).run(title, selectedModel);
      id = Number(result.lastInsertRowid);
    } else if (!existing) {
      const result = db.prepare(`
        INSERT INTO chat_sessions (title, selected_model, updated_at)
        VALUES (?, ?, datetime('now'))
      `).run(title, selectedModel);
      id = Number(result.lastInsertRowid);
    } else {
      id = sessionId;
      db.prepare(`
        UPDATE chat_sessions
        SET title = ?, selected_model = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(title, selectedModel, id);
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
    }

    const insertMessage = db.prepare(`
      INSERT INTO chat_messages (
        session_id,
        role,
        content,
        platform,
        model,
        latency_ms,
        fallback_attempts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const message of messages) {
      insertMessage.run(
        id,
        message.role,
        message.content,
        message.meta?.platform ?? null,
        message.meta?.model ?? null,
        message.meta?.latency ?? null,
        message.meta?.fallbackAttempts ?? null,
      );
    }

    return id;
  });

  const savedId = save();
  res.status(sessionId ? 200 : 201).json(readSession(savedId));
});
