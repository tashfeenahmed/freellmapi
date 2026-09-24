// Repair balance timestamps/confidence that empty health probes used to refresh.
// DOWN: the index is reversible; corrected observations stay corrected.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quota_balance_observations
    ON provider_quota_observations(platform,key_id,quota_pool_key,metric,observed_at DESC,created_at DESC)
    WHERE remaining_value IS NOT NULL`);
  // One indexed seek per state row, not a scan of the full observation history.
  const snapshot = db.prepare(`SELECT * FROM provider_quota_observations
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=? AND remaining_value IS NOT NULL
    ORDER BY observed_at DESC,created_at DESC LIMIT 1`);
  const update = db.prepare(`UPDATE provider_quota_state SET limit_value=?,remaining_value=?,reset_at=?,
    reset_strategy=?,source=?,confidence=?,notes=?,observed_at=?
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=?`);
  const uncertain = db.prepare(`UPDATE provider_quota_state SET confidence=0
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=?`);
  const confidenceCap: Record<string, number> = { header:1,quota_api:1,error_body:0.55,probe:0.1,local_usage:0.45,documentation:0.35 };
  const rows = db.prepare('SELECT platform,key_id,quota_pool_key,metric FROM provider_quota_state').all() as {
    platform:string;key_id:number;quota_pool_key:string;metric:string;
  }[];
  for (const row of rows) {
    const identity = [row.platform,row.key_id,row.quota_pool_key,row.metric];
    const measured = snapshot.get(...identity) as {
      limit_value:number|null;remaining_value:number;reset_at:string|null;reset_strategy:string;
      source:string;confidence:number;notes:string|null;observed_at:string;
    } | undefined;
    if (measured) update.run(measured.limit_value,measured.remaining_value,measured.reset_at,
      measured.reset_strategy,measured.source,Math.min(measured.confidence,confidenceCap[measured.source] ?? 0),
      measured.notes,measured.observed_at,...identity);
    else uncertain.run(...identity); // Retention may have removed the actual observation.
  }
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_quota_balance_observations');
}
