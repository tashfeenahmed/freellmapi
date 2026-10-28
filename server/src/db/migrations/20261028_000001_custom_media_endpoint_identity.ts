import type { Db } from '../types.js';

const columns = 'id, platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json';

function rebuild(db: Db, scoped: boolean): void {
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'media_models'").get() as { seq: number } | undefined;
  db.exec(`
    CREATE TABLE media_models_rebuilt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL,
      modality TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, quota_label TEXT NOT NULL DEFAULT '',
      key_id INTEGER, meta_json TEXT
      ${scoped ? ", endpoint_scope TEXT NOT NULL DEFAULT ''" : ''},
      UNIQUE(platform, model_id${scoped ? ', endpoint_scope' : ''})
    );
    INSERT INTO media_models_rebuilt (${columns}${scoped ? ', endpoint_scope' : ''})
      SELECT ${columns}${scoped ? ", CASE WHEN platform = 'custom' THEN COALESCE((SELECT RTRIM(TRIM(base_url), '/') FROM api_keys WHERE id = media_models.key_id AND platform = 'custom'), '') ELSE '' END" : ''}
      FROM media_models;
    DROP TABLE media_models;
    ALTER TABLE media_models_rebuilt RENAME TO media_models;
    CREATE INDEX idx_media_models_key_id ON media_models(key_id);
  `);
  if (seq) {
    const updated = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'media_models' AND seq < ?").run(seq.seq, seq.seq);
    if (!updated.changes && !db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'media_models'").get()) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('media_models', ?)").run(seq.seq);
    }
  }
}

export function up(db: Db): void {
  rebuild(db, true);
  // Keep media identity separate from requests.model_db_id, which names chat models.
  db.exec(`
    ALTER TABLE requests ADD COLUMN media_model_db_id INTEGER;
    CREATE INDEX idx_requests_media_model_db_id ON requests(media_model_db_id);
    UPDATE requests SET media_model_db_id = (
      SELECT mm.id FROM media_models mm
      WHERE mm.platform = requests.platform AND mm.model_id = requests.model_id
        AND mm.modality = requests.request_type
        AND (mm.platform <> 'custom' OR mm.endpoint_scope = COALESCE((
          SELECT RTRIM(TRIM(k.base_url), '/') FROM api_keys k
          WHERE k.id = requests.key_id AND k.platform = 'custom'
        ), ''))
    ) WHERE request_type IN ('image', 'video', 'audio', 'transcription');
  `);
}

export function down(db: Db): void {
  const duplicate = db.prepare('SELECT 1 FROM media_models GROUP BY platform, model_id HAVING COUNT(*) > 1 LIMIT 1').get();
  if (duplicate) throw new Error('Cannot revert media endpoint identity while duplicate model IDs exist');
  rebuild(db, false);
  db.exec('DROP INDEX idx_requests_media_model_db_id; ALTER TABLE requests DROP COLUMN media_model_db_id;');
}
