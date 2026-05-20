import './env.js';
import { createApp } from './app.js';
import { initDbFromPersistentSnapshot } from './db/index.js';
import { startHealthChecker } from './services/health.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  await initDbFromPersistentSnapshot();
  const app = createApp();

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });
}

main().catch(console.error);
