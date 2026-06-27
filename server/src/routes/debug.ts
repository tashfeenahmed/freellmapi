import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const debugRouter = Router();

debugRouter.post('/seed-media', (_req: Request, res: Response) => {
  const db = getDb();
  
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES ('google', 'gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', 'audio', 1, 1, 'Keyless')
  `);
  
  const result = insertStmt.run();
  
  const mediaModelsCountRow = db.prepare('SELECT COUNT(*) AS count FROM media_models').get() as { count: number };
  const audioModelsCountRow = db.prepare("SELECT COUNT(*) AS count FROM media_models WHERE modality = 'audio'").get() as { count: number };
  
  res.json({
    success: true,
    rowsInserted: result.changes,
    mediaModelsCount: mediaModelsCountRow.count,
    audioModelsCount: audioModelsCountRow.count,
  });
});

debugRouter.get('/media-status', (_req: Request, res: Response) => {
  const db = getDb();
  
  const models = db.prepare('SELECT * FROM media_models ORDER BY modality, priority, id').all() as any[];
  
  const totalMediaModels = models.length;
  const audioModels = models.filter(m => m.modality === 'audio').length;
  const imageModels = models.filter(m => m.modality === 'image').length;
  const transcriptionModels = models.filter(m => m.modality === 'transcription').length;
  
  res.json({
    totalMediaModels,
    audioModels,
    imageModels,
    transcriptionModels,
    models,
  });
});
