import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const ACTIVE_ENV_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;
const COMMENTED_ENV_RE = /^\s*#\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

const KNOWN_UNDOCUMENTED_ENV = new Set([
  'NODE_ENV',
  'DEV_MODE',
  'FREELLMAPI_DIR',
  'PROXY_URL',
  'CATALOG_BASE_URL',
  'CATALOG_PUBKEY',
  'CATALOG_SYNC_DISABLED',
  'FREEAPI_DB_BACKUP_TARGET',
  'PREMIUM_SITE_URL',
]);

const KNOWN_UNDOCUMENTED_PATTERNS = [
  /^PROVIDER_DAILY_REQUEST_CAP_[A-Z0-9_]+$/,
];

export interface EnvDriftReport {
  missingDocumentedDefaults: string[];
  unknownKeys: string[];
}

export interface EnvDriftPaths {
  envPath?: string;
  examplePath?: string;
}

export function defaultEnvDriftPaths(): Required<EnvDriftPaths> {
  return {
    envPath: process.env.FREEAPI_ENV_PATH ?? path.join(REPO_ROOT, '.env'),
    examplePath: path.join(REPO_ROOT, '.env.example'),
  };
}

export function parseEnvNames(text: string, opts: { includeCommented?: boolean } = {}): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const active = ACTIVE_ENV_RE.exec(line);
    if (active) {
      names.add(active[1]);
      continue;
    }
    if (opts.includeCommented) {
      const commented = COMMENTED_ENV_RE.exec(line);
      if (commented) names.add(commented[1]);
    }
  }
  return [...names].sort();
}

function isKnownUndocumentedEnv(name: string): boolean {
  return KNOWN_UNDOCUMENTED_ENV.has(name) || KNOWN_UNDOCUMENTED_PATTERNS.some(re => re.test(name));
}

export function compareEnvText(envText: string, exampleText: string): EnvDriftReport {
  const actual = new Set(parseEnvNames(envText));
  const documentedDefaults = parseEnvNames(exampleText);
  const documented = new Set(parseEnvNames(exampleText, { includeCommented: true }));

  return {
    missingDocumentedDefaults: documentedDefaults.filter(name => !actual.has(name)),
    unknownKeys: [...actual]
      .filter(name => !documented.has(name) && !isKnownUndocumentedEnv(name))
      .sort(),
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function compactList(names: string[], limit = 8): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} +${names.length - limit} more`;
}

export function formatEnvDriftReport(report: EnvDriftReport): string[] {
  const parts: string[] = [];
  if (report.missingDocumentedDefaults.length > 0) {
    parts.push(`${report.missingDocumentedDefaults.length} documented ${plural(report.missingDocumentedDefaults.length, 'default', 'defaults')} missing`);
  }
  if (report.unknownKeys.length > 0) {
    parts.push(`${report.unknownKeys.length} unrecognised ${plural(report.unknownKeys.length, 'key', 'keys')}`);
  }
  if (parts.length === 0) return [];

  const lines = [`[config] .env check: ${parts.join('; ')}. Startup continues.`];
  if (report.missingDocumentedDefaults.length > 0) {
    lines.push(`[config]   missing from .env: ${compactList(report.missingDocumentedDefaults)}`);
  }
  if (report.unknownKeys.length > 0) {
    lines.push(`[config]   not in .env.example: ${compactList(report.unknownKeys)}`);
  }
  lines.push('[config]   Compare .env.example when you next edit your config.');
  return lines;
}

export function checkEnvDrift(paths: EnvDriftPaths = {}): EnvDriftReport | null {
  const defaults = defaultEnvDriftPaths();
  const envPath = paths.envPath ?? defaults.envPath;
  const examplePath = paths.examplePath ?? defaults.examplePath;

  if (!fs.existsSync(envPath) || !fs.existsSync(examplePath)) return null;

  try {
    return compareEnvText(
      fs.readFileSync(envPath, 'utf8'),
      fs.readFileSync(examplePath, 'utf8'),
    );
  } catch {
    return null;
  }
}

export function warnOnEnvDrift(paths?: EnvDriftPaths, logger: Pick<Console, 'warn'> = console): EnvDriftReport | null {
  const report = checkEnvDrift(paths);
  if (!report) return null;
  for (const line of formatEnvDriftReport(report)) logger.warn(line);
  return report;
}
