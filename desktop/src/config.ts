import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface DesktopConfig {
  port?: number;
  theme?: 'dark' | 'light';
  // BCP-47 locale mirrored from the dashboard (en, zh-CN, fr, es, pt-BR).
  locale?: string;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): DesktopConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as DesktopConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.warn('[desktop] could not persist config:', err);
  }
}
