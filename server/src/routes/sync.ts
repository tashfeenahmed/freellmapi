import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const syncRouter = Router();

/**
 * GET /api/sync
 * On-demand import of Ollama models from configured local providers.
 * Filters out cloud stub models (':cloud' suffix, 'ollama:' prefix).
 */
syncRouter.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
 
  // Only allow sync when explicitly requested for the local Ollama provider
  const provider = typeof _req.query.provider === 'string' ? _req.query.provider : '';
  if (provider !== 'ollama-local') {
    return res.status(400).json({ error: 'Invalid or missing provider. Use provider=ollama-local to run sync.' });
  }

  // Find all enabled ollama-local keys
  const keys = db.prepare(
    'SELECT id, base_url FROM api_keys WHERE platform = ? AND enabled = 1'
  ).all('ollama-local') as Array<{ id: number; base_url: string | null }>;

  if (keys.length === 0) {
    return res.status(404).json({ error: 'No enabled ollama-local providers configured' });
  }

  const imported: string[] = [];
  const defaultBaseUrl = 'http://127.0.0.1:11434/v1';

  for (const key of keys) {
    const fetchedUrl = (key.base_url?.trim() || defaultBaseUrl).replace(/\/+$/, '');
    const tagsUrl = `${fetchedUrl}/api/tags`;

    try {
      const http = await import('http');
      const https = await import('https');
      const url = new URL(tagsUrl);
      const client = url.protocol === 'https:' ? https : http;

      const models = await new Promise<any[]>((resolve, reject) => {
        const req = client.get(tagsUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.models ?? []);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy());
      });

      // Filter out cloud stubs
      const filtered = models.filter((m: any) =>
        !m.name.includes(':cloud') &&
        !m.name.startsWith('ollama:')
      );

      for (const model of filtered) {
        const name = model.name;
        const displayName = `${name} (Local)`;

        // Insert model
        const insertModel = db.prepare(`
          INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        const result = insertModel.run(
          'ollama-local', name, displayName,
          50, 10, 'Local', null, null, null, null, 'unlimited', 131072
        );
        if (result.changes > 0) {
          imported.push(name);
          
          const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('ollama-local', name) as any;
          if (row) {
            db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?,?,1)').run(row.id, 9999);
          }
        }
      }
    } catch (err: any) {
      console.warn(`Failed to fetch from ${fetchedUrl}: ${err.message}`);
    }
  }

  res.json({ success: true, imported_count: imported.length, models: imported });
});