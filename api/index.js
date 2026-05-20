import '../server/dist/env.js';
import { createApp } from '../server/dist/app.js';
import { initDb } from '../server/dist/db/index.js';

let app;

function getApp() {
  if (!app) {
    initDb();
    app = createApp();
  }
  return app;
}

export default function handler(req, res) {
  return getApp()(req, res);
}
