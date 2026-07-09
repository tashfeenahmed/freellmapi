import type { Db } from '../types.js';
import { applyModelPricing } from '../model-pricing.js';

/**
 * Re-add MiniMax as a direct OpenAI-compatible provider and seed MiniMax-M3.
 * The direct base URL is registered in providers/index.ts; this migration only
 * supplies the local catalog floor so existing installs can route the model.
 */
export function up(db: Db): void {
  db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES (
      'minimax', 'MiniMax-M3', 'MiniMax M3', 3, 9, 'Frontier',
      NULL, NULL, NULL, NULL, '',
      1000000, 1, 0, 1
    )
    ON CONFLICT(platform, model_id) DO UPDATE SET
      display_name = excluded.display_name,
      intelligence_rank = excluded.intelligence_rank,
      speed_rank = excluded.speed_rank,
      size_label = excluded.size_label,
      context_window = excluded.context_window,
      enabled = excluded.enabled,
      supports_vision = excluded.supports_vision,
      supports_tools = excluded.supports_tools
  `).run();

  applyModelPricing(db);
}

export function down(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'minimax' AND model_id = 'MiniMax-M3'`).run();
}
