import type Database from 'better-sqlite3';

export function deleteUnusedCustomEndpointKey(db: Database.Database, keyId: number | null | undefined) {
  if (keyId == null) return;
  const chat = db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  const embeddings = db.prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  const media = db.prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  if (chat.n + embeddings.n + media.n === 0) {
    db.prepare("DELETE FROM api_keys WHERE id = ? AND platform = 'custom'").run(keyId);
  }
}
