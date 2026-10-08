import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeLaunchEnv, codexArgs, main, parseArgs, resolvePinnedModel, unsupportedNodeVersion } from './index.js';
import { UnknownModelError } from './models.js';
import type { CatalogModel } from './types.js';

describe('CLI arguments and launchers', () => {
  it('parses setup options before or after the command', () => {
    expect(parseArgs([
      '--url',
      'http://localhost:3001/v1',
      'setup-codex',
      '--profile=work',
      '--dry-run',
    ])).toMatchObject({
      command: 'setup-codex',
      options: {
        url: 'http://localhost:3001/v1',
        profile: 'work',
        dryRun: true,
      },
    });
  });

  it('rejects profile names that can escape the intended config directory', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '../../outside']))
      .toThrow('--profile must use only');
    expect(() => parseArgs(['setup-codex', '--profile', '..']))
      .toThrow('--profile must use only');
  });

  it('rejects a missing option value instead of consuming the next flag', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '--dry-run']))
      .toThrow('--profile requires a value');
  });

  it('parses doctor --timeout, and rejects a value that is not milliseconds', () => {
    expect(parseArgs(['doctor', '--timeout', '30000']).options.timeoutMs).toBe(30_000);
    expect(parseArgs(['doctor', '--timeout=250']).options.timeoutMs).toBe(250);
    // Left undefined rather than defaulted here, so doctor.ts owns the default.
    expect(parseArgs(['doctor']).options.timeoutMs).toBeUndefined();
    // Rejected, not silently ignored: a typo quietly becoming the default is
    // exactly the quiet no-op this command exists to catch.
    expect(() => parseArgs(['doctor', '--timeout', '5s'])).toThrow('positive number of milliseconds');
    expect(() => parseArgs(['doctor', '--timeout', '0'])).toThrow('positive number of milliseconds');
  });

  it('still rejects a stray positional for commands that take none', async () => {
    // `doctor` is the only command with positional arguments, so parseArgs
    // collects them generically. The dispatcher has to reject them for every
    // other command BEFORE dispatch — checked after the setup-* branch, the
    // stray word would be silently ignored instead of erroring.
    await expect(main(['setup-claude', 'typo'])).rejects.toThrow('Unknown option: typo');
    await expect(main(['launch', 'typo'])).rejects.toThrow('Unknown option: typo');
    // ...and doctor still takes them.
    expect(parseArgs(['doctor', 'claude']).options.args).toEqual(['claude']);
  });

  const models: CatalogModel[] = [
    { id: 'auto' },
    { id: 'fast-coder', available: true, context_window: 131072 },
    { id: 'reasoning-model', available: true, context_window: 262144 },
  ];
  const baseOptions = {
    url: 'http://localhost:3000',
    profile: 'default',
    dryRun: false,
  };
  const temporary: string[] = [];

  afterEach(() => {
    for (const directory of temporary.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses --model for ANTHROPIC_MODEL and defaults to the first available model', () => {
    const explicit = claudeLaunchEnv(
      { ...baseOptions, model: 'reasoning-model' },
      'unified-key',
      models,
      {},
      '/home/tester',
    );
    expect(explicit.ANTHROPIC_MODEL).toBe('reasoning-model');
    expect(explicit.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');

    const fallback = claudeLaunchEnv(baseOptions, 'unified-key', models, {}, '/home/tester');
    expect(fallback.ANTHROPIC_MODEL).toBe('fast-coder');
    expect(fallback.ANTHROPIC_AUTH_TOKEN).toBe('unified-key');
    expect(fallback.ANTHROPIC_BASE_URL).toBe('http://localhost:3000');
  });

  it('never uses the profile name as a model id', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(home);
    const profileDir = path.join(home, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    const env = claudeLaunchEnv(
      { ...baseOptions, profile: 'work' },
      'unified-key',
      models,
      {},
      home,
    );
    expect(env.ANTHROPIC_MODEL).toBe('fast-coder');
    expect(env.CLAUDE_CONFIG_DIR).toBe(profileDir);
  });

  it('rejects a profile whose configuration directory does not exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(home);
    expect(() => claudeLaunchEnv(
      { ...baseOptions, profile: 'missing' },
      'unified-key',
      models,
      {},
      home,
    )).toThrow("freellmapi setup-claude --profile missing");
  });

  it('strips the user\'s real Anthropic credentials from the child environment', () => {
    const env = claudeLaunchEnv(baseOptions, 'unified-key', models, {
      ANTHROPIC_API_KEY: 'real-anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'real-anthropic-token',
      PATH: '/usr/bin',
    }, '/home/tester');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('unified-key');
    expect(env.PATH).toBe('/usr/bin');
    expect(JSON.stringify(env)).not.toContain('real-anthropic');
  });

  describe('resolvePinnedModel', () => {
    const available: CatalogModel[] = [{ id: 'auto' }, { id: 'fast-coder', available: true }];
    const full: CatalogModel[] = [...available, { id: 'benched', available: false }];

    function collect(): { warnings: string[]; warn: (message: string) => void } {
      const warnings: string[] = [];
      return { warnings, warn: message => { warnings.push(message); } };
    }

    it('is silent for an available pinned model', () => {
      const { warnings, warn } = collect();
      expect(resolvePinnedModel('fast-coder', { available, full }, warn)?.id).toBe('fast-coder');
      expect(warnings).toEqual([]);
    });

    it('warns but still resolves a registered-but-unavailable model', () => {
      const { warnings, warn } = collect();
      expect(resolvePinnedModel('benched', { available, full }, warn))
        .toMatchObject({ id: 'benched', unavailable: true });
      expect(warnings.join()).toContain('not currently available');
    });

    it('WARNS when the unfiltered roster could not be fetched', () => {
      // Silently degrading to the filtered roster would reinstate exactly the
      // ambiguity this pair of fetches removes: the user would see a quota
      // problem reported as a typo, with nothing saying the check was weaker.
      const { warnings, warn } = collect();
      resolvePinnedModel(
        'fast-coder',
        { available, full: available, degradedReason: 'HTTP 400' },
        warn,
      );
      expect(warnings.join()).toContain('could not fetch the unfiltered model catalog');
      expect(warnings.join()).toContain('HTTP 400');
    });

    it('still reports an id in neither roster as unknown, degraded or not', () => {
      const { warn } = collect();
      expect(() => resolvePinnedModel('nope', { available, full }, warn))
        .toThrow(UnknownModelError);
    });

    it('does nothing at all when no model was pinned', () => {
      // Nothing to warn about: the launcher picks from the filtered roster,
      // where there is no unknown-vs-unavailable ambiguity to lose.
      const { warnings, warn } = collect();
      expect(resolvePinnedModel(undefined, { available, full, degradedReason: 'x' }, warn))
        .toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  it('passes a complete Responses provider to Codex', () => {
    const args = codexArgs('http://localhost:3001/v1/', 'coder');
    expect(args).toContain('model_provider="freellmapi"');
    expect(args).toContain('model="coder"');
    expect(args).toContain('model_providers.freellmapi.name="FreeLLMAPI"');
    expect(args).toContain(
      'model_providers.freellmapi.base_url="http://localhost:3001/v1"',
    );
    expect(args).toContain('model_providers.freellmapi.wire_api="responses"');
  });

  // #1283: on Node <17.4 the CLI died at module-load time with
  // ERR_UNKNOWN_BUILTIN_MODULE because `node:readline/promises` was imported
  // statically, so no command — not even --help — could run, let alone print
  // a readable reason. Two layers fix it: the readline import is now lazy
  // (only the interactive key prompt needs it), and this pure check turns an
  // old runtime into one clear sentence before main() runs.
  describe('unsupportedNodeVersion (#1283)', () => {
    it('accepts Node 20 and newer', () => {
      expect(unsupportedNodeVersion('20.18.0')).toBeNull();
      expect(unsupportedNodeVersion('22.5.1')).toBeNull();
      expect(unsupportedNodeVersion('26.9.0')).toBeNull();
    });

    it('rejects the older runtimes from the issue reports', () => {
      for (const version of ['12.22.12', '14.21.3', '16.20.2', '18.19.0', '19.9.0']) {
        const message = unsupportedNodeVersion(version);
        expect(message).toContain('Node.js 20 or newer');
        expect(message).toContain(version);
      }
    });

    it('says nothing when the runtime is unrecognised', () => {
      // A non-Node runtime (or a mocked process) must not be told it is
      // "old"; the failure, if any, should come from the code itself.
      expect(unsupportedNodeVersion(undefined)).toBeNull();
      expect(unsupportedNodeVersion('')).toBeNull();
      expect(unsupportedNodeVersion('nightly')).toBeNull();
    });
  });
});
