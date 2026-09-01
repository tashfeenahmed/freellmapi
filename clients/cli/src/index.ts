#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { applyGeneratedFiles, printDryRunDiff } from './config-files.js';
import { getTool, tools } from './tools.js';
import { resolveLaunchModel, type ResolvedModel } from './models.js';
import { DOCTOR_TOOLS, diagnose, exitCodeFor, formatReport, type ToolReport } from './doctor.js';
import type { CatalogModel, GenerateContext } from './types.js';

interface CliOptions {
  url: string;
  apiKey?: string;
  profile: string;
  model?: string;
  dryRun: boolean;
  /** `doctor --timeout`: how long to wait for the /livez probe. */
  timeoutMs?: number;
  /** Positional arguments after the command. Only `doctor` takes any; every
   *  other command still rejects a second positional as it always has. */
  args: string[];
}

function rootUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function validateProfile(profile: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)
    || profile === '.'
    || profile === '..'
  ) {
    throw new Error(
      '--profile must use only letters, numbers, dots, underscores, or hyphens',
    );
  }
  return profile;
}

function parseTimeout(value: string): number {
  const ms = Number(value);
  // Rejected rather than clamped: a typo'd `--timeout 5s` parsing to NaN and
  // silently becoming the default is the kind of quiet no-op this command is
  // supposed to be immune to.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got '${value}'`);
  }
  return ms;
}

export function parseArgs(argv: string[]): { command?: string; options: CliOptions } {
  const options: CliOptions = {
    url: process.env.FREELLMAPI_URL || 'http://localhost:3000',
    apiKey: process.env.FREELLMAPI_API_KEY,
    profile: 'default',
    dryRun: false,
    args: [],
  };
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') && !command) {
      command = arg;
      continue;
    }
    if (!arg.startsWith('-')) {
      // Collected rather than rejected here so the parser stays generic; the
      // dispatcher rejects extras for commands that take none, which keeps
      // `setup-claude typo` an error instead of a silently ignored word.
      options.args.push(arg);
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [flag, inline] = arg.split('=', 2);
    const value = inline ?? argv[index + 1];
    if (
      flag === '--url' || flag === '--api-key' || flag === '--profile'
      || flag === '--model' || flag === '--timeout'
    ) {
      if (inline === undefined) index += 1;
      if (!value || (inline === undefined && value.startsWith('-'))) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === '--url') options.url = value;
      else if (flag === '--api-key') options.apiKey = value;
      else if (flag === '--profile') options.profile = validateProfile(value);
      else if (flag === '--timeout') options.timeoutMs = parseTimeout(value);
      else options.model = value;
      continue;
    }
    if (arg !== '--help' && arg !== '-h') throw new Error(`Unknown option: ${arg}`);
  }
  return { command, options };
}

async function promptForKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'No API key supplied. Pass --api-key or set FREELLMAPI_API_KEY.',
    );
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const answer = rl.question('FreeLLMAPI unified API key: ');
    muted = true;
    const value = (await answer).trim();
    muted = false;
    process.stderr.write('\n');
    if (!value) throw new Error('An API key is required');
    return value;
  } finally {
    muted = false;
    rl.close();
  }
}

async function catalog(url: string, apiKey: string, availableOnly = true): Promise<CatalogModel[]> {
  let response: Response;
  try {
    response = await fetch(`${rootUrl(url)}/v1/models${availableOnly ? '?available=true' : ''}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : undefined;
    const reason = cause ?? (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Could not reach the FreeLLMAPI gateway at ${rootUrl(url)} (${reason}). `
      + 'Check that the server is running, or point the CLI at it with --url or FREELLMAPI_URL.',
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Catalog request failed (HTTP ${response.status}): ${detail}`);
  }
  const body = await response.json() as { data?: CatalogModel[] };
  const models = body.data ?? [];
  if (!models.length) throw new Error('The live catalog returned no models');
  return models;
}

export interface Catalogs {
  available: CatalogModel[];
  full: CatalogModel[];
  /** Why the unfiltered fetch failed. Set means `full` is really the FILTERED
   *  roster, so "unknown model" and "out of quota" can no longer be told
   *  apart — the exact ambiguity this pair of fetches exists to remove. */
  degradedReason?: string;
}

/**
 * The available-only roster plus the unfiltered one.
 *
 * Only the unfiltered roster can distinguish "no such model" from "that model
 * exists but is out of quota right now", and reporting the second as the first
 * turns a rate limit into a spurious typo error. The unfiltered fetch is
 * best-effort: an older gateway that ignores the parameter, or any failure,
 * degrades to the filtered roster rather than blocking a launch — but it
 * RECORDS that it degraded, so the degradation can be reported instead of
 * silently reinstating the ambiguity.
 */
export async function catalogs(url: string, apiKey: string): Promise<Catalogs> {
  const available = await catalog(url, apiKey);
  try {
    return { available, full: await catalog(url, apiKey, false) };
  } catch (error) {
    return {
      available,
      full: available,
      degradedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve a pinned `--model` ONCE, and say out loud anything that makes the
 * verdict less than certain.
 *
 * One resolution feeding both the id that gets pinned and the warning the user
 * reads, so the two can never disagree. Returns undefined when nothing was
 * pinned — the launcher then picks from the filtered roster, where there is no
 * ambiguity to lose and so nothing to warn about.
 */
export function resolvePinnedModel(
  requested: string | undefined,
  rosters: Catalogs,
  warn: (message: string) => void = message => process.stderr.write(message),
): ResolvedModel | undefined {
  if (!requested) return undefined;

  // Reported, never silent: degrading to the filtered roster is exactly the
  // state in which an out-of-quota model gets called a typo, so the user has
  // to be told which roster the verdict below came from.
  if (rosters.degradedReason) {
    warn(
      `freellmapi: could not fetch the unfiltered model catalog (${rosters.degradedReason}). `
      + `Checking '${requested}' against the available-only roster instead — a model that `
      + 'exists but is out of quota may be reported as unknown.\n',
    );
  }

  const resolved = resolveLaunchModel(requested, rosters.available, rosters.full);
  // A pinned model that is registered but not servable right now is a launch we
  // should still make — the router may recover it mid-session — but never one
  // we should make silently.
  if (resolved.unavailable) {
    warn(
      `freellmapi: '${resolved.id}' is registered but not currently available `
      + '(out of quota, cooling down, or its key is disabled). Launching anyway.\n',
    );
  }
  return resolved;
}

function help(): string {
  return [
    'FreeLLMAPI coding-agent setup',
    '',
    'Usage:',
    '  freellmapi <command> [--url URL] [--api-key KEY] [--profile NAME] [--model ID] [--dry-run]',
    '',
    'Commands:',
    ...tools.map(tool => `  ${tool.command.padEnd(17)} ${tool.name}`),
    '  doctor [tool…]    Check whether a tool\'s requests actually reach this gateway',
    '                    (--timeout MS raises the probe wait on a slow link)',
    '  launch            Run Claude Code with credentials injected into the child environment',
    '  launch-codex      Run Codex with provider overrides and injected credentials',
    '  list              List supported coding agents',
    '',
    'Environment:',
    '  FREELLMAPI_URL, FREELLMAPI_API_KEY',
  ].join('\n');
}

async function setup(command: string, options: CliOptions): Promise<void> {
  const tool = getTool(command.replace(/^setup-/, ''));
  if (!tool) throw new Error(`Unknown setup command '${command}'`);
  const apiKey = options.apiKey ?? await promptForKey();
  const rosters = await catalogs(options.url, apiKey);
  // --model was parsed but never reached the generators, so `setup-x --model y`
  // silently wrote whatever primaryModel() preferred. Validate it against the
  // unfiltered catalog (so an out-of-quota model is not reported as a typo)
  // and thread it through.
  const requestedModelId = resolvePinnedModel(options.model, rosters)?.id;
  const context: GenerateContext = {
    url: rootUrl(options.url),
    apiKey,
    profile: options.profile,
    models: rosters.available,
    homeDir: os.homedir(),
    requestedModelId,
  };
  const generation = tool.generate(context);

  if (generation.files.length === 0) {
    for (const note of generation.notes) process.stdout.write(`${note}\n`);
    return;
  }

  const results = applyGeneratedFiles(generation.files, options.dryRun);
  for (const result of results) {
    if (options.dryRun && result.changed) {
      process.stdout.write(`${printDryRunDiff(result)}\n`);
    } else if (result.changed) {
      process.stdout.write(`Updated ${result.path}\n`);
      if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
    } else {
      process.stdout.write(`Unchanged ${result.path}\n`);
    }
  }
  for (const note of generation.notes) process.stdout.write(`\n${note}\n`);
}

// Runs an interactive child with inherited stdio. SIGINT is ignored in the
// wrapper (the foreground child receives it from the terminal and decides
// what to do), SIGTERM is forwarded, and the child's exit code is returned.
function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const ignoreSigint = (): void => {};
  const forwardSigterm = (): void => { child.kill('SIGTERM'); };
  process.on('SIGINT', ignoreSigint);
  process.on('SIGTERM', forwardSigterm);
  const cleanup = (): void => {
    process.off('SIGINT', ignoreSigint);
    process.off('SIGTERM', forwardSigterm);
  };
  return new Promise<number>((resolve, reject) => {
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code !== null) resolve(code);
      else if (signal) resolve(128 + (os.constants.signals[signal] ?? 0));
      else resolve(1);
    });
  });
}

// `--profile` selects a CLAUDE_CONFIG_DIR generated by setup-claude and is
// never a model id; `--model` picks the model explicitly.
export function claudeLaunchEnv(
  options: CliOptions,
  apiKey: string,
  models: CatalogModel[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
  fullCatalog: CatalogModel[] = models,
): NodeJS.ProcessEnv {
  const resolved = resolveLaunchModel(options.model, models, fullCatalog);
  const selected = resolved.id;
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // Never leak the user's real Anthropic credentials to the gateway.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (options.profile !== 'default') {
    const directory = path.join(homeDir, '.claude', 'profiles', options.profile);
    if (!fs.existsSync(directory)) {
      throw new Error(
        `Claude profile '${options.profile}' has no configuration directory at ${directory}. `
        + `Create it with: freellmapi setup-claude --profile ${options.profile}`,
      );
    }
    env.CLAUDE_CONFIG_DIR = directory;
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: rootUrl(options.url),
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: selected,
    ANTHROPIC_DEFAULT_OPUS_MODEL: selected,
    ANTHROPIC_DEFAULT_SONNET_MODEL: selected,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selected,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  });
  // Only pin the compaction window when the catalog actually published one.
  // The old `?? 128_000` invented a number for every model with no stated
  // window, and a wrong window is worse than none: too high and Claude Code
  // compacts after the gateway has already rejected the request, too low and
  // it compacts a conversation that still fits. Absent, Claude Code applies
  // its own default.
  if (resolved.contextWindow !== undefined) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(resolved.contextWindow);
  } else {
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
  return env;
}

async function launchClaude(options: CliOptions): Promise<number> {
  const apiKey = options.apiKey ?? await promptForKey();
  const rosters = await catalogs(options.url, apiKey);
  // Resolved here for the warning; claudeLaunchEnv resolves again to build the
  // environment. Both are pure calls over the same two rosters, so they cannot
  // reach different verdicts — keeping claudeLaunchEnv a side-effect-free env
  // builder is worth more than eliding the second call.
  resolvePinnedModel(options.model, rosters);
  const env = claudeLaunchEnv(
    options, apiKey, rosters.available, process.env, os.homedir(), rosters.full,
  );
  return runChild('claude', [], env);
}

export function codexArgs(url: string, selected: string): string[] {
  return [
    '-c', 'model_provider="freellmapi"',
    '-c', `model=${JSON.stringify(selected)}`,
    '-c', 'model_providers.freellmapi.name="FreeLLMAPI"',
    '-c', `model_providers.freellmapi.base_url=${JSON.stringify(`${rootUrl(url)}/v1`)}`,
    '-c', 'model_providers.freellmapi.wire_api="responses"',
    '-c', 'model_providers.freellmapi.env_key="FREELLMAPI_API_KEY"',
    '-c', 'model_providers.freellmapi.requires_openai_auth=false',
  ];
}

async function launchCodex(options: CliOptions): Promise<number> {
  const apiKey = options.apiKey ?? await promptForKey();
  const rosters = await catalogs(options.url, apiKey);
  const selected = (
    resolvePinnedModel(options.model, rosters)
    ?? resolveLaunchModel(undefined, rosters.available, rosters.full)
  ).id;
  const env = { ...process.env, FREELLMAPI_API_KEY: apiKey };
  const args = codexArgs(options.url, selected);
  return runChild('codex', args, env);
}

async function runDoctor(options: CliOptions): Promise<number> {
  const requested = options.args.length ? options.args : DOCTOR_TOOLS;
  const reports: ToolReport[] = [];
  for (const tool of requested) {
    reports.push(await diagnose(tool, {
      expectedUrl: rootUrl(options.url),
      timeoutMs: options.timeoutMs,
    }));
  }
  for (const report of reports) process.stdout.write(`${formatReport(report)}\n`);
  // Nonzero when anything is not routed, so this is usable as a precondition
  // in a script rather than only readable by eye.
  return exitCodeFor(reports);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  // `doctor` is the only command that takes positional arguments. Every other
  // one rejects them here, BEFORE dispatch — checking after the setup-* branch
  // would let `setup-claude typo` run with the stray word silently ignored,
  // where it used to be an error.
  if (command !== 'doctor' && options.args.length) {
    throw new Error(`Unknown option: ${options.args[0]}`);
  }
  if (command === 'list') {
    for (const tool of tools) {
      process.stdout.write(`${tool.id}\t${tool.protocol}\t${tool.baseUrlSupport}\n`);
    }
    return 0;
  }
  if (command.startsWith('setup-')) {
    await setup(command, options);
    return 0;
  }
  if (command === 'doctor') return runDoctor(options);
  if (command === 'launch') return launchClaude(options);
  if (command === 'launch-codex') return launchCodex(options);
  throw new Error(`Unknown command '${command}'\n\n${help()}`);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`freellmapi: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
