import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const conversationsRouter = Router();

interface ConversationRow {
  id: number;
  title: string;
  messages: string; // JSON string
  created_at: string;
  updated_at: string;
}

conversationsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC
  `).all() as Pick<ConversationRow, 'id' | 'title' | 'created_at' | 'updated_at'>[];

  res.json(rows.map(r => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
});

conversationsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { title = '' } = req.body ?? {};
  const result = db.prepare(`
    INSERT INTO conversations (title, messages) VALUES (?, '[]')
  `).run(title);
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid) as ConversationRow;
  res.status(201).json({
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

conversationsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id)) as ConversationRow | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }
  res.json({
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

conversationsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }

  const { title, messages } = req.body ?? {};
  const newTitle = title ?? existing.title;
  const newMessages = messages !== undefined ? JSON.stringify(messages) : existing.messages;

  db.prepare(`
    UPDATE conversations SET title = ?, messages = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newTitle, newMessages, id);

  const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
  res.json({
    id: updated.id,
    title: updated.title,
    messages: JSON.parse(updated.messages),
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  });
});

conversationsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: { message: 'Conversation not found' } });
    return;
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  res.json({ success: true });
});
