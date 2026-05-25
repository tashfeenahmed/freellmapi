import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { backfillCopilotTiers } from './services/copilot-bootstrap.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  initDb();
  const app = createApp();

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
    // Best-effort tier backfill for Copilot keys that pre-date V18 —
    // runs in the background so a slow GitHub round-trip doesn't block
    // the server from accepting requests.
    backfillCopilotTiers().catch(err => {
      console.warn(`[copilot-bootstrap] backfill failed: ${err?.message ?? err}`);
    });
  });
}

main().catch(console.error);
