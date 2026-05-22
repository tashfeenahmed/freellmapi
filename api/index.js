import { createApp } from '../server/dist/app.js';
import { initDb } from '../server/dist/db/index.js';

// Initialize database
initDb();

// Create and export the Express app
const app = createApp();

export default app;
