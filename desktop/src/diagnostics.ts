import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';

const session = randomUUID();
let reports = 0;
function trackOpen() {
  if (!app.isPackaged || !loadConfig().diagnostics) return;
  void fetch('https://analytics.neu.so/api/track', {
    method: 'POST', headers: { Origin: 'https://freellmapi.co', 'Content-Type': 'application/json', 'openpanel-client-id': '7ed1ef6d-e0fa-4a83-a62b-d7ca291bb2d9' },
    body: JSON.stringify({ type: 'track', payload: { name: 'app_open', properties: {
      platform: 'desktop', os: process.platform, __deviceId: session, __path: '/app',
    } } }),
  }).catch(() => {});
}
function reportFailure(kind: 'RendererExit' | 'MainProcessError') {
  if (!app.isPackaged || !loadConfig().diagnostics || reports++ >= 5) return;
  const id = randomUUID().replace(/-/g, '');
  const event = { event_id: id, timestamp: Date.now() / 1000, environment: 'production', level: 'error',
    platform: 'javascript', tags: { os: process.platform }, exception: { values: [{ type: kind, value: 'Desktop application error' }] } };
  const body = [{ event_id: id }, { type: 'event' }, event].map(part => JSON.stringify(part)).join('\n');
  void fetch('https://errors.neu.so/api/27/envelope/?sentry_key=c5422421a5264d7b8c94cd2605350495&sentry_version=7', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
}
function startDiagnostics() {
  trackOpen();
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit') reportFailure('RendererExit');
  });
  process.on('uncaughtExceptionMonitor', () => reportFailure('MainProcessError'));
}
export { trackOpen, startDiagnostics };
