import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  claudeLayers,
  codexLayers,
  diagnose,
  exitCodeFor,
  managedSettingsDir,
  managedSettingsPaths,
  normalizeUrl,
  probeGateway,
  sameGateway,
} from './doctor.js';

const temporary: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-doctor-'));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetch double that answers /livez exactly as the real gateway does. */
function gatewayFetch(
  body: unknown = { status: 'ok', version: '0.7.0', uptime_s: 12 },
  status = 200,
): typeof fetch {
  return (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

/** The real 503 body from routes/status.ts when the db or encryption key is down. */
const UNAVAILABLE = { status: 'unavailable', version: '0.7.0', uptime_s: 12, checks: { db: false } };
const deadFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

function writeClaudeSettings(home: string, value: Record<string, unknown>): void {
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value));
}

function writeCodexConfig(home: string, toml: string): void {
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), toml);
}

describe('managed settings locations', () => {
  it('uses the documented system directory for each platform', () => {
    expect(managedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(managedSettingsDir('linux')).toBe('/etc/claude-code');
    expect(managedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode');
  });

  it('falls back to the base file alone when there is no drop-in directory', () => {
    // The usual case: an unreadable or absent managed-settings.d contributes
    // nothing rather than failing the whole report.
    const dir = tempHome();
    expect(managedSettingsPaths('linux', dir)).toEqual([path.join(dir, 'managed-settings.json')]);
  });

  it('ranks managed-settings.d drop-ins above the base file, last one first', () => {
    // The drop-in files are merged alphabetically ON TOP of the base, so the
    // alphabetically LAST one wins and the base loses to all of them. Getting
    // this order backwards would name the wrong layer as effective for a
    // fleet-managed install — the exact confident-wrong answer doctor exists
    // to prevent.
    const dir = tempHome();
    fs.mkdirSync(path.join(dir, 'managed-settings.d'));
    for (const name of ['20-b.json', '10-a.json', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, 'managed-settings.d', name), '{}');
    }

    expect(managedSettingsPaths('linux', dir)).toEqual([
      path.join(dir, 'managed-settings.d', '20-b.json'),
      path.join(dir, 'managed-settings.d', '10-a.json'),
      path.join(dir, 'managed-settings.json'),
    ]);
  });
});

describe('url comparison', () => {
  it('ignores trailing slashes, a /v1 suffix, and host case', () => {
    expect(normalizeUrl('http://Localhost:3000/v1/')).toBe('http://localhost:3000');
    expect(sameGateway('http://localhost:3000', 'http://localhost:3000/v1')).toBe(true);
    expect(sameGateway('http://localhost:3000', 'http://localhost:3001')).toBe(false);
    expect(sameGateway(undefined, 'http://localhost:3000')).toBe(false);
  });

  it('keeps a path prefix, so two mounts on one host are not confused', () => {
    // A gateway mounted under a prefix is a different endpoint. Folding the
    // path away reported these as the same gateway.
    expect(normalizeUrl('http://host/gateway/v1/')).toBe('http://host/gateway');
    expect(sameGateway('http://host/gateway', 'http://host/other')).toBe(false);
    expect(sameGateway('http://host/gateway/v1', 'http://host/gateway/')).toBe(true);
    expect(sameGateway('http://host/gateway', 'http://host')).toBe(false);
  });

  it('keeps path case, which is case-sensitive, while folding the host', () => {
    expect(normalizeUrl('HTTP://Host:3000/Gateway')).toBe('http://host:3000/Gateway');
    expect(sameGateway('http://host/Gateway', 'http://host/gateway')).toBe(false);
  });

  it('drops query and fragment, which never identify the endpoint', () => {
    expect(normalizeUrl('http://host:3000/v1?k=1#x')).toBe('http://host:3000');
  });

  it('falls back to lexical trimming for an unparseable value', () => {
    // A malformed config value must still produce a report, not an exception.
    expect(normalizeUrl('localhost:3000/v1/')).toBe('localhost:3000');
  });
});

describe('claude precedence', () => {
  it('ranks a settings env block ABOVE the inherited shell environment', () => {
    // The easy thing to get backwards, and I did: Claude Code writes each
    // `env` entry into the process environment at startup, REPLACING what the
    // shell exported. The shell is the lowest layer, not the highest.
    const home = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' } });
    const layers = claudeLayers({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, home, tempHome());

    expect(layers[0]).toMatchObject({ value: 'http://localhost:3000', effective: true });
    expect(layers[1]).toMatchObject({ value: 'https://api.anthropic.com', effective: false });
  });

  it('uses the shell value when no settings file names one', () => {
    expect(claudeLayers({ ANTHROPIC_BASE_URL: 'http://localhost:3000' }, tempHome(), tempHome())[0])
      .toMatchObject({ value: 'http://localhost:3000', effective: true });
  });

  it('ranks project-local settings above the user scope', () => {
    const home = tempHome();
    const project = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://user:1' } });
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://project-local:2' } }),
    );

    expect(claudeLayers({}, home, project)[0])
      .toMatchObject({ value: 'http://project-local:2', effective: true });
  });

  it('honours CLAUDE_CONFIG_DIR for the user scope', () => {
    // Relocates the user scope wholesale; missing it reads a settings file the
    // running tool never opens.
    const home = tempHome();
    const configDir = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: 'http://ignored:1' } });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://relocated:2' } }),
    );

    expect(claudeLayers({ CLAUDE_CONFIG_DIR: configDir }, home, tempHome())[0]?.value)
      .toBe('http://relocated:2');
  });

  it('reports no layers rather than throwing on absent or malformed settings', () => {
    const home = tempHome();
    expect(claudeLayers({}, home, tempHome())).toEqual([]);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    expect(claudeLayers({}, home, tempHome())).toEqual([]);
  });
});

describe('codex precedence', () => {
  it('resolves the SELECTED provider, not the first base_url in the file', () => {
    // Codex names a provider and the provider carries the url. Reading any
    // base_url would report a provider the user is not selecting.
    const home = tempHome();
    writeCodexConfig(home, [
      'model_provider = "freellmapi"',
      '',
      '[model_providers.other]',
      'base_url = "http://not-this-one:9999/v1"',
      '',
      '[model_providers.freellmapi]',
      'base_url = "http://localhost:3000/v1"',
    ].join('\n'));

    expect(codexLayers({}, home)[0]).toMatchObject({
      value: 'http://localhost:3000/v1',
      effective: true,
    });
  });

  it('reads the dotted-key spelling too', () => {
    const home = tempHome();
    writeCodexConfig(home, [
      'model_provider = "freellmapi"',
      'model_providers.freellmapi.base_url = "http://localhost:3000/v1"',
    ].join('\n'));
    expect(codexLayers({}, home)[0]?.value).toBe('http://localhost:3000/v1');
  });

  it('honours CODEX_HOME over the default location', () => {
    const home = tempHome();
    const alternate = tempHome();
    writeCodexConfig(home, 'model_provider = "a"\n[model_providers.a]\nbase_url = "http://default:1/v1"');
    writeCodexConfig(alternate, 'model_provider = "b"\n[model_providers.b]\nbase_url = "http://override:2/v1"');

    const layers = codexLayers({ CODEX_HOME: path.join(alternate, '.codex') }, home);
    expect(layers[0]?.value).toBe('http://override:2/v1');
  });

  it('records a selected provider that names no base_url instead of skipping it', () => {
    const home = tempHome();
    writeCodexConfig(home, 'model_provider = "freellmapi"\n');
    const layer = codexLayers({}, home)[0];
    expect(layer.effective).toBe(true);
    expect(layer.value).toBeUndefined();
    expect(layer.source).toContain('no base_url found');
  });
});

describe('verdicts', () => {
  const url = 'http://localhost:3000';

  it('routed only when the tool reaches THIS gateway', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('routed');
    expect(report.gateway?.version).toBe('0.7.0');
  });

  it('elsewhere — not routed — when the tool reaches a different host that is alive', async () => {
    // The regression this guards: reporting `routed` for a Claude Code pinned
    // to api.anthropic.com, because it does reach what it is configured to
    // reach. That is a confident wrong answer to the question being asked.
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('elsewhere');
    expect(report.detail).toContain('does not touch this gateway');
  });

  it('elsewhere when the right port answers, but not the way this gateway does', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch({ hello: 'some other service' }),
    });
    expect(report.verdict).toBe('elsewhere');
  });

  it('shadowed names the layer that wins, and the value it beat', async () => {
    const home = tempHome();
    writeClaudeSettings(home, { env: { ANTHROPIC_BASE_URL: url } });
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      homeDir: home, cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });

    expect(report.verdict).toBe('shadowed');
    // The settings block is what wins, so it is what shadows — and the shell
    // export the user probably set by hand is what got overridden.
    expect(report.shadowedBy).toContain('settings.json');
    expect(report.detail).toContain('process environment');
    expect(report.detail).toContain('https://api.anthropic.com');
  });

  it('degraded — not routed, not elsewhere — when this gateway says it cannot serve', async () => {
    // Routing is correct and the gateway is unmistakably this one; it is sick.
    // `routed` would send the user hunting through config that is already
    // right, and `elsewhere` would blame a service that is not there.
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(UNAVAILABLE, 503),
    });
    expect(report.verdict).toBe('degraded');
    expect(report.detail).toContain('that IS this gateway');
    expect(report.detail).toContain('unavailable');
    expect(report.gateway).toMatchObject({ identified: true, healthy: false });
  });

  it('unreachable when the configured endpoint answers nothing', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: { ANTHROPIC_BASE_URL: url },
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: deadFetch,
    });
    expect(report.verdict).toBe('unreachable');
    expect(report.detail).toContain('ECONNREFUSED');
  });

  it('unknown when nothing configures the tool at all', async () => {
    const report = await diagnose('claude', {
      expectedUrl: url,
      env: {},
      homeDir: tempHome(), cwd: tempHome(),
      fetchImpl: gatewayFetch(),
    });
    expect(report.verdict).toBe('unknown');
    expect(report.detail).toContain('vendor default');
  });

  it('unknown, not a crash, for a tool doctor does not model', async () => {
    const report = await diagnose('aider', { expectedUrl: url, env: {}, homeDir: tempHome() });
    expect(report.verdict).toBe('unknown');
    expect(report.detail).toContain('claude');
  });
});

describe('probeGateway', () => {
  it('requires all three /livez fields before claiming identity', async () => {
    // /livez carries no product marker, so the shape is the only evidence
    // available. Two of three fields is not it.
    expect((await probeGateway('http://x', gatewayFetch({ status: 'ok', version: '1' }))).identified)
      .toBe(false);
    expect((await probeGateway('http://x', gatewayFetch())).identified).toBe(true);
  });

  it('treats a non-JSON body as reachable but unidentified', async () => {
    const htmlFetch = (async () => ({
      status: 200,
      json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    expect(await probeGateway('http://x', htmlFetch))
      .toMatchObject({ reachable: true, identified: false, healthy: false });
  });

  it('still IDENTIFIES the gateway when it answers 503 unavailable', async () => {
    // The server really emits this when the db or encryption key is down, and
    // it is unmistakably this gateway. Folding health into identity would
    // report a correctly-routed sick gateway as a foreign service.
    expect(await probeGateway('http://x', gatewayFetch(UNAVAILABLE, 503))).toMatchObject({
      reachable: true,
      identified: true,
      healthy: false,
      serviceStatus: 'unavailable',
      status: 503,
    });
  });

  it('treats an unrecognized status value as unhealthy, not unidentified', async () => {
    // A status added later must degrade into a truthful "this gateway says
    // <status>", never into a claim that it is some other service.
    const probe = await probeGateway(
      'http://x',
      gatewayFetch({ status: 'draining', version: '9', uptime_s: 1 }),
    );
    expect(probe).toMatchObject({ identified: true, healthy: false, serviceStatus: 'draining' });
  });

  it('is unhealthy when a non-2xx carries an ok body', async () => {
    expect((await probeGateway('http://x', gatewayFetch(undefined, 500))).healthy).toBe(false);
  });

  it('honours the caller-supplied timeout instead of the hard-coded default', async () => {
    // Threaded so a slow link is not misreported as unreachable. That the
    // caller's 20ms fires at all is the proof: the 5s default would not have.
    const neverAnswers = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    })) as unknown as typeof fetch;

    const started = Date.now();
    const probe = await probeGateway('http://x', neverAnswers, 20);
    expect(Date.now() - started).toBeLessThan(DEFAULT_PROBE_TIMEOUT_MS);
    expect(probe).toMatchObject({ reachable: false, identified: false, healthy: false });
    expect(probe.error).toContain('abort');
  });
});

describe('exit code', () => {
  it('is zero only when every tool is routed', () => {
    expect(exitCodeFor([{ verdict: 'routed' } as never])).toBe(0);
    expect(exitCodeFor([{ verdict: 'routed' } as never, { verdict: 'elsewhere' } as never])).toBe(1);
    expect(exitCodeFor([{ verdict: 'unknown' } as never])).toBe(1);
    // A gateway that cannot serve is a failed precondition, not a pass.
    expect(exitCodeFor([{ verdict: 'degraded' } as never])).toBe(1);
  });
});
