import type { Db } from '../types.js';

/**
 * Custom OpenAI-compatible providers (Ollama, vLLM, LM Studio, and friends) all
 * speak the tool-call protocol, but early custom-model registration seeded
 * supports_tools = 0. Agentic clients that send `tools` (Trae, Cline, and the
 * like) then matched zero custom models and hit a false "all models exhausted"
 * error (#470).
 *
 * Backfill existing custom rows to tool-capable. The trade is deliberate: a
 * wrong tools = 1 only surfaces a recoverable upstream error the user can turn
 * off with the per-model toggle, whereas tools = 0 hides the model from
 * tool-bearing requests with no recourse. New registrations default to
 * tools = 1 in the route handler, so this only touches rows created earlier.
 */
export function up(db: Db): void {
  db.prepare("UPDATE models SET supports_tools = 1 WHERE platform = 'custom'").run();
}

export function down(db: Db): void {
  db.prepare("UPDATE models SET supports_tools = 0 WHERE platform = 'custom'").run();
}
