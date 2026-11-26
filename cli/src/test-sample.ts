import { DashboardHttpError, dashboardClient, type DashboardOptions } from './dashboard.js';
import { fetchRows, type Row } from './dashboard-models.js';
import { formatTable, ms, oneLine } from './table.js';

export interface TestSampleOptions extends DashboardOptions {
  args: string[];
  dryRun: boolean;
  platform?: string;
  all?: boolean;
  count?: string;
  pace?: string;
  seed?: string;
}

// The server allows one test per model every 5 s; a rerun inside that window gets 429.
const THROTTLE_RETRY_MS = 5_500;

export function testSampleHelp(): string {
  return [
    'Live-test a random sample of enabled chat models (dashboard authentication):',
    '  freellmapi test-sample (--platform a,b | --all) [-n 2] [--pace SECONDS] [--seed N] [--dry-run]',
    '',
    'Picks at most n enabled chat models per platform (default 2) and tests them one at a time through',
    'POST /api/models/:id/test, pausing --pace seconds between calls (default 2).',
    '--seed makes the sample reproducible; the seed used is printed. --dry-run lists the sample only.',
    'Prints model, result, latency, and a one-line error. Exits 1 if any test failed.',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
  ].join('\n');
}

function integer(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

/** mulberry32: small seedable PRNG so a sample can be reproduced from the printed seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** At most `n` rows per platform, platforms in name order; a pure function of rows, n, and seed. */
export function sampleRows(rows: Row[], n: number, seed: number): Row[] {
  const next = random(seed);
  const byPlatform = new Map<string, Row[]>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row]);
  }
  return [...byPlatform.keys()].sort().flatMap(platform => {
    const list = byPlatform.get(platform)!;
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, n);
  });
}

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

interface TestReply { success?: unknown; latencyMs?: unknown; error?: unknown }

export async function runTestSample(options: TestSampleOptions): Promise<number> {
  if (options.args.length) throw new Error(`Unknown option: ${options.args[0]}`);
  if (options.all && options.platform !== undefined) throw new Error('--platform and --all cannot be combined');
  if (!options.all && options.platform === undefined) {
    throw new Error(`test-sample needs --platform a,b or --all.\n\n${testSampleHelp()}`);
  }
  const n = integer(options.count, '-n', 1, 100) ?? 2;
  const pace = integer(options.pace, '--pace', 0, 600) ?? 2;
  const seed = integer(options.seed, '--seed', 0, 4294967295) ?? Math.floor(Math.random() * 4294967296);
  const platforms = options.platform?.split(',').map(p => p.trim().toLowerCase());
  if (platforms && platforms.some(p => !/^[a-z][a-z0-9_-]*$/.test(p))) throw new Error('Invalid --platform list');

  const { request } = dashboardClient(options);
  const rows = (await fetchRows(request, 'chat')).filter(r => r.enabled && (!platforms || platforms.includes(r.platform)));
  if (!rows.length) {
    process.stdout.write('No enabled chat models match.\n');
    return 0;
  }
  const sample = sampleRows(rows, n, seed);
  process.stdout.write(`Sample of ${sample.length} (seed ${seed}, at most ${n} per platform).\n`);

  const results: string[][] = [];
  let failed = 0;
  for (const [index, row] of sample.entries()) {
    const label = `${oneLine(row.platform, 40)}/${oneLine(row.modelId, 60)}`;
    if (options.dryRun) {
      results.push([label, 'skipped', '-', 'dry run']);
      continue;
    }
    if (index > 0 && pace > 0) await sleep(pace * 1000);
    let reply: TestReply | undefined;
    let error = '';
    for (let attempt = 0; attempt < 2 && !reply && !error; attempt += 1) {
      try {
        reply = await request<TestReply>(`/api/models/${row.id}/test`, 'POST');
      } catch (caught) {
        if (caught instanceof DashboardHttpError && caught.status === 429 && attempt === 0) {
          await sleep(THROTTLE_RETRY_MS);
        } else if (caught instanceof DashboardHttpError) {
          error = caught.message;
        } else {
          throw caught;
        }
      }
    }
    const ok = reply?.success === true;
    if (!ok) failed += 1;
    results.push([label, ok ? 'ok' : 'FAIL', ms(reply?.latencyMs), ok ? '' : oneLine(error || reply?.error || 'unknown error', 80)]);
  }
  process.stdout.write(`${formatTable(['MODEL', 'RESULT', 'LATENCY', 'ERROR'], results, [2])}\n`);
  if (!options.dryRun) process.stdout.write(`${sample.length - failed} ok, ${failed} failed.\n`);
  return failed ? 1 : 0;
}
