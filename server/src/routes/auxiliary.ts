// Auxiliary chain management API — per task_type.

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getValidTaskTypes } from '../services/auxiliary.js';

const router = Router();

// GET /api/auxiliary — list all chains or filter by task_type
router.get('/', (req, res) => {
  const db = getDb();
  const { task_type } = req.query;

  let sql =
    "SELECT ac.id, ac.task_type, ac.model_db_id, ac.priority, ac.enabled, " +
    "m.platform, m.model_id, m.display_name, m.supports_vision, m.supports_tools, m.intelligence_rank " +
    "FROM auxiliary_config ac " +
    "JOIN models m ON m.id = ac.model_db_id ";

  const params: any[] = [];
  if (task_type && typeof task_type === 'string') {
    sql += "WHERE ac.task_type = ? ";
    params.push(task_type);
  }
  sql += "ORDER BY ac.task_type, ac.priority ASC";

  const rows = db.prepare(sql).all(...params);
  res.json({ chain: rows, valid_task_types: getValidTaskTypes() });
});

// POST /api/auxiliary/add — add a model to a task_type chain
router.post('/add', (req, res) => {
  const db = getDb();
  const { task_type, model_db_id, priority } = req.body;

  if (!task_type) {
    res.status(400).json({ error: "task_type is required" });
    return;
  }
  if (!model_db_id || typeof model_db_id !== 'number') {
    res.status(400).json({ error: "model_db_id is required (number)" });
    return;
  }

  // Check model exists
  const model = db.prepare("SELECT id FROM models WHERE id = ?").get(model_db_id);
  if (!model) {
    res.status(404).json({ error: "Model not found in catalog" });
    return;
  }

  const row = db.prepare(
    "SELECT COALESCE(MAX(priority), 0) + 1 as next_p FROM auxiliary_config WHERE task_type = ?"
  ).get(task_type);
  const p = priority != null ? priority : ((row as any)?.next_p ?? 1);

  db.prepare(
    "INSERT INTO auxiliary_config (task_type, model_db_id, priority, enabled) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(task_type, model_db_id) DO UPDATE SET priority = ?, enabled = 1"
  ).run(task_type, model_db_id, p, p);

  res.json({ success: true, task_type, model_db_id });
});

// PUT /api/auxiliary/:modelDbId — toggle enabled
router.put('/:modelDbId', (req, res) => {
  const db = getDb();
  const modelDbId = parseInt(req.params.modelDbId, 10);
  if (isNaN(modelDbId)) {
    res.status(400).json({ error: "Invalid model_db_id" });
    return;
  }

  const { task_type, enabled, priority } = req.body;
  if (!task_type) {
    res.status(400).json({ error: "task_type is required" });
    return;
  }

  if (priority !== undefined) {
    db.prepare(
      "UPDATE auxiliary_config SET priority = ? WHERE task_type = ? AND model_db_id = ?"
    ).run(priority, task_type, modelDbId);
  }
  if (enabled !== undefined) {
    db.prepare(
      "UPDATE auxiliary_config SET enabled = ? WHERE task_type = ? AND model_db_id = ?"
    ).run(enabled, task_type, modelDbId);
  }

  res.json({ success: true });
});

// DELETE /api/auxiliary/:modelDbId — remove from chain
router.delete('/:modelDbId', (req, res) => {
  const db = getDb();
  const modelDbId = parseInt(req.params.modelDbId, 10);
  const { task_type } = req.query;
  if (task_type && typeof task_type === 'string') {
    db.prepare("DELETE FROM auxiliary_config WHERE task_type = ? AND model_db_id = ?").run(task_type, modelDbId);
  } else {
    db.prepare("DELETE FROM auxiliary_config WHERE model_db_id = ?").run(modelDbId);
  }
  res.json({ success: true });
});

export default router;
