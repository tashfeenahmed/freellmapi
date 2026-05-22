import '../server/src/env.js';
import { createApp } from '../server/src/app.js';
import { initDb } from '../server/src/db/index.js';

initDb();
const app = createApp();

export default app;
