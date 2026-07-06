import type Database from 'better-sqlite3';

/**
 * GitHub Models' free GPT-4.1 endpoint rejects requests above the low-tier
 * per-call input cap even though the upstream model can support a larger
 * context elsewhere. Keep the local catalog aligned with the routable limit.
 */
export function up(db: Database.Database): void {
  db.prepare(`
    UPDATE models
       SET context_window = 8000
     WHERE platform = 'github'
       AND model_id = 'openai/gpt-4.1'
  `).run();
}

export function down(db: Database.Database): void {
  db.prepare(`
    UPDATE models
       SET context_window = 128000
     WHERE platform = 'github'
       AND model_id = 'openai/gpt-4.1'
  `).run();
}
