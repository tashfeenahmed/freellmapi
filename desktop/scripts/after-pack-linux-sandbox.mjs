// electron-builder copies chrome-sandbox into appOutDir as 0755. Electron then
// refuses to start on Linux unless that helper is root-owned mode 4755
// (setuid). afterPack runs after the files are staged and before fpm/deb, so
// chmod here is what the installed /opt/FreeLLMAPI/chrome-sandbox inherits.
// See #1229. Do not "fix" this with --no-sandbox.
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const LINUX_SANDBOX_NAME = 'chrome-sandbox';
export const LINUX_SANDBOX_MODE = 0o4755;

export function chmodLinuxChromeSandbox(appOutDir) {
  const sandbox = join(appOutDir, LINUX_SANDBOX_NAME);
  if (!existsSync(sandbox)) return;
  chmodSync(sandbox, LINUX_SANDBOX_MODE);
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  chmodLinuxChromeSandbox(context.appOutDir);
}
