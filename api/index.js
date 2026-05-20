import '../server/dist/env.js';
import { createApp } from '../server/dist/app.js';
import { initDbFromPersistentSnapshot } from '../server/dist/db/index.js';

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      await initDbFromPersistentSnapshot();
      return createApp();
    })();
  }
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
