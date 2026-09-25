import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tools } from './tools.js';
import type { GenerateContext } from './types.js';

// CI runners export XDG_CONFIG_HOME (and could export MIMOCODE_HOME / DSH_HOME),
// which the XDG-aware generators honour over ctx.homeDir. Pin them so golden
// output is stable everywhere.
beforeEach(() => {
  vi.stubEnv('XDG_CONFIG_HOME', '');
  vi.stubEnv('MIMOCODE_HOME', '');
  vi.stubEnv('DSH_HOME', '');
  vi.stubEnv('OPENCLAW_HOME', '');
  vi.stubEnv('OPENCLAW_STATE_DIR', '');
  vi.stubEnv('OPENCLAW_CONFIG_PATH', '');
  vi.stubEnv('HERMES_HOME', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const context: GenerateContext = {
  url: 'http://localhost:3000',
  apiKey: 'freellmapi-test-key',
  profile: 'default',
  homeDir: '/home/tester',
  models: [
    {
      id: 'fast-coder',
      name: 'Fast Coder',
      available: true,
      context_window: 131072,
    },
    {
      id: 'reasoning-model',
      name: 'Reasoning Model',
      available: true,
      context_window: 262144,
    },
  ],
};

describe('tool generators', () => {
  it('defaults to auto, never fusion, when the live catalog lists virtual models first', () => {
    const liveContext: GenerateContext = {
      ...context,
      models: [
        { id: 'auto', name: 'Auto', available: true, context_window: 200_000 },
        { id: 'fusion', name: 'Fusion', available: true, context_window: 2_000_000 },
        ...context.models,
      ],
    };
    const claude = tools.find(tool => tool.id === 'claude')!.generate(liveContext);
    const settings = claude.files[0].value as { env: Record<string, string> };
    expect(settings.env.ANTHROPIC_MODEL).toBe('auto');
    const codex = tools.find(tool => tool.id === 'codex')!.generate(liveContext);
    expect(codex.files[0].content).toContain('model = "auto"');
    expect(codex.files[0].content).not.toContain('"fusion"');
  });

  for (const tool of tools) {
    it(`${tool.command} has stable golden output`, () => {
      expect(tool.generate(context)).toMatchSnapshot();
    });
  }

  it('honours an explicit --model instead of the default-model heuristic', () => {
    // `--model` was parsed into CliOptions and then dropped: it never reached
    // GenerateContext, so `setup-claude --model X` wrote whatever
    // primaryModel() preferred and said nothing about ignoring the flag.
    const pinned = { ...context, requestedModelId: 'reasoning-model' };
    const claude = tools.find(tool => tool.id === 'claude')!.generate(pinned);
    expect(JSON.stringify(claude.files)).toContain('reasoning-model');
  });

  it('pins a requested model that the available-roster does not carry', () => {
    // Validated against the UNFILTERED catalog upstream, so an id missing from
    // ctx.models here is registered-but-out-of-quota, not a typo. Writing a
    // different model into the user's config would be the wrong repair.
    const pinned = { ...context, requestedModelId: 'benched-model' };
    const claude = tools.find(tool => tool.id === 'claude')!.generate(pinned);
    expect(JSON.stringify(claude.files)).toContain('benched-model');
  });

  it('setup-codex with a named profile has stable golden output', () => {
    const generation = tools.find(tool => tool.id === 'codex')!
      .generate({ ...context, profile: 'work' });
    expect(generation).toMatchSnapshot();
  });

  it('writes named Codex profiles as [profiles.NAME] inside config.toml', () => {
    const generation = tools.find(tool => tool.id === 'codex')!
      .generate({ ...context, profile: 'work' });
    expect(generation.files).toHaveLength(1);
    const file = generation.files[0];
    // Codex only reads ~/.codex/config.toml; per-profile files are ignored.
    expect(file.path).toBe('/home/tester/.codex/config.toml');
    expect(file.content).toContain('[profiles.work]');
    expect(file.content).toContain('model = "fast-coder"');
    expect(file.content).toContain('model_provider = "freellmapi"');
    expect(file.content).toContain('[model_providers.freellmapi]');
    // A named profile must not hijack the root/default model selection.
    expect(file.content!.split('\n').findIndex(line => line.startsWith('model =')))
      .toBeGreaterThan(file.content!.split('\n').indexOf('[profiles.work]'));
    expect(generation.notes.join('\n')).toContain('codex --profile work');
  });

  it('generates Cline current provider settings with repeatable selection', () => {
    const file = tools.find(tool => tool.id === 'cline')!.generate(context).files[0];
    const state = file.value as any;
    expect(file.path).toBe('/home/tester/.cline/data/settings/providers.json');
    expect(state).toMatchObject({
      version: 1,
      lastUsedProvider: 'openai-compatible',
    });
    expect(state.providers['openai-compatible']).toMatchObject({
      settings: {
        provider: 'openai-compatible',
        protocol: 'openai-chat',
        client: 'openai-compatible',
        model: 'fast-coder',
        baseUrl: 'http://localhost:3000/v1',
        apiKey: 'freellmapi-test-key',
        contextWindow: 131072,
        capabilities: ['streaming', 'tools'],
      },
      tokenSource: 'manual',
    });
  });

  it('generates a complete Continue v1 config with Agent tool support', () => {
    const config = tools.find(tool => tool.id === 'continue')!
      .generate(context).files[0].content!;
    expect(config).toContain('name: FreeLLMAPI');
    expect(config).toContain('version: 1.0.0');
    expect(config).toContain('schema: v1');
    expect(config).toContain('      - tool_use');
    expect(config).toContain('    apiKey: ${{ secrets.FREELLMAPI_API_KEY }}');
  });

  it('generates Goose custom-provider registration without persisting the key', () => {
    const generation = tools.find(tool => tool.id === 'goose')!.generate(context);
    const provider = generation.files.find(file => file.path.endsWith('freellmapi.json'))!.value as any;
    const selection = generation.files.find(file => file.path.endsWith('config.yaml'))!.content!;
    expect(provider).toMatchObject({
      name: 'freellmapi',
      engine: 'openai',
      api_key_env: 'FREELLMAPI_API_KEY',
      base_url: 'http://localhost:3000/v1',
      requires_auth: true,
      dynamic_models: false,
    });
    expect(provider.models.map((model: any) => model.name)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    expect(selection).toContain('GOOSE_PROVIDER: freellmapi');
    expect(JSON.stringify(generation)).not.toContain('freellmapi-test-key');
  });

  it('generates Qwen Code provider catalogs using a supported auth type', () => {
    const generation = tools.find(tool => tool.id === 'qwen')!.generate(context);
    const settings = generation.files.find(file => file.path.endsWith('settings.json'))!.value as any;
    expect(settings.security.auth.selectedType).toBe('openai');
    expect(settings.model).toEqual({ name: 'fast-coder' });
    expect(settings.modelProviders.openai.protocol).toBe('openai');
    expect(settings.modelProviders.openai.models).toHaveLength(2);
    expect(settings.modelProviders.openai.models[0]).toMatchObject({
      id: 'fast-coder',
      envKey: 'FREELLMAPI_API_KEY',
      baseUrl: 'http://localhost:3000/v1',
      generationConfig: { contextWindowSize: 131072 },
    });
    expect(settings.modelProviders).not.toHaveProperty('freellmapi');
  });

  it('wraps Roo Code imports in the documented provider profile envelope', () => {
    const config = tools.find(tool => tool.id === 'roo')!
      .generate(context).files[0].value as any;
    expect(config.providerProfiles.currentApiConfigName).toBe('freellmapi');
    expect(config.providerProfiles.apiConfigs.freellmapi).toMatchObject({
      apiProvider: 'openai',
      openAiBaseUrl: 'http://localhost:3000/v1',
      openAiModelId: 'fast-coder',
    });
    expect(config.globalSettings).toEqual({});
  });

  it('writes Kilo trusted global config with every catalog model', () => {
    const file = tools.find(tool => tool.id === 'kilo')!.generate(context).files[0];
    const config = file.value as any;
    expect(file.path).toBe('/home/tester/.config/kilo/kilo.jsonc');
    expect(config.$schema).toBe('https://app.kilo.ai/config.json');
    expect(config.model).toBe('openai-compatible/fast-coder');
    expect(config.provider['openai-compatible'].options).toEqual({
      apiKey: '{env:FREELLMAPI_API_KEY}',
      baseURL: 'http://localhost:3000/v1',
    });
    expect(Object.keys(config.provider['openai-compatible'].models)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    expect(config.provider['openai-compatible'].models['fast-coder']).toMatchObject({
      tool_call: true,
      limit: { context: 131072, output: 8192 },
    });
    expect(JSON.stringify(config)).not.toContain('freellmapi-test-key');
  });

  it('uses Crush openai-compat schema, lists every catalog model, and selects the default', () => {
    const config = tools.find(tool => tool.id === 'crush')!
      .generate(context).files[0].value as any;
    expect(config.$schema).toBe('https://charm.land/crush.json');
    expect(config.providers.freellmapi.type).toBe('openai-compat');
    expect(config.providers.freellmapi.models.map((model: any) => model.id)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
    // A provider entry alone is never used: Crush auto-detects from whatever
    // credentials it finds on the machine unless `models.large`/`small` name it.
    expect(config.models).toEqual({
      large: { provider: 'freellmapi', model: 'fast-coder' },
      small: { provider: 'freellmapi', model: 'fast-coder' },
    });
    for (const model of config.providers.freellmapi.models) {
      expect(model).toMatchObject({
        cost_per_1m_in: 0,
        cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0,
        cost_per_1m_out_cached: 0,
        can_reason: false,
        supports_attachments: false,
      });
    }
  });

  it('keeps `auto` in the OpenCode, Crush and Goose rosters when it is the default', () => {
    // OpenCode resolves `freellmapi/auto` only if `auto` is a declared model,
    // and Crush's `models.large` must name a listed model; with `auto` in the
    // live catalog all three generators put it first rather than filter it out.
    const liveContext: GenerateContext = {
      ...context,
      models: [{ id: 'auto', name: 'Auto', available: true, context_window: 200_000 }, ...context.models],
    };
    const opencode = tools.find(tool => tool.id === 'opencode')!.generate(liveContext).files[0].value as any;
    expect(opencode.model).toBe('freellmapi/auto');
    expect(Object.keys(opencode.provider.freellmapi.models)).toEqual(['auto', 'fast-coder', 'reasoning-model']);
    const crush = tools.find(tool => tool.id === 'crush')!.generate(liveContext).files[0].value as any;
    expect(crush.models.large.model).toBe('auto');
    expect(crush.providers.freellmapi.models[0].id).toBe('auto');
    const goose = tools.find(tool => tool.id === 'goose')!.generate(liveContext);
    const provider = goose.files.find(file => file.path.endsWith('freellmapi.json'))!.value as any;
    expect(provider.models[0].name).toBe('auto');
    // Qwen Code silently falls back to the first listed model when the selected
    // one is missing (it picked `fusion`); Kilo refuses to start outright.
    const qwen = tools.find(tool => tool.id === 'qwen')!.generate(liveContext).files[0].value as any;
    expect(qwen.modelProviders.openai.models[0].id).toBe('auto');
    const kilo = tools.find(tool => tool.id === 'kilo')!.generate(liveContext).files[0].value as any;
    expect(kilo.model).toBe('openai-compatible/auto');
    expect(Object.keys(kilo.provider['openai-compatible'].models)[0]).toBe('auto');
  });

  it('delivers the Continue secret through ~/.continue/.env', () => {
    const generation = tools.find(tool => tool.id === 'continue')!.generate(context);
    const env = generation.files.find(file => file.path.endsWith('.env'))!;
    expect(env.path).toBe('/home/tester/.continue/.env');
    expect(env.sensitive).toBe(true);
    expect(env.content).toBe('FREELLMAPI_API_KEY=freellmapi-test-key\n');
    const config = generation.files.find(file => file.path.endsWith('config.yaml'))!.content!;
    expect(config).not.toContain('freellmapi-test-key');
  });

  it('gives Roo an openai profile for the extension and a separate CLI import with an openrouter one', () => {
    const files = tools.find(tool => tool.id === 'roo')!.generate(context).files;
    const value = files[0].value as any;
    const configs = value.providerProfiles.apiConfigs;
    expect(value.providerProfiles.currentApiConfigName).toBe('freellmapi');
    // The CLI forces its provider onto the CURRENT profile of the file it
    // imports, so its file must make the openrouter-type profile current.
    const cli = files[1].value as any;
    expect(files[1].path).toBe('/home/tester/.roo/freellmapi-cli.json');
    expect(cli.providerProfiles.currentApiConfigName).toBe('freellmapi-cli');
    expect(cli.providerProfiles.apiConfigs['freellmapi-cli']).toEqual(configs['freellmapi-cli']);
    expect(files[2].path).toBe('/home/tester/.roo/cli-settings.json');
    expect(files[2].value).toEqual({ provider: 'openrouter', model: 'fast-coder' });
    expect(configs.freellmapi).toMatchObject({
      apiProvider: 'openai',
      openAiBaseUrl: 'http://localhost:3000/v1',
      openAiModelId: 'fast-coder',
      openAiCustomModelInfo: { contextWindow: 131072, maxTokens: 8192 },
    });
    expect(configs['freellmapi-cli']).toEqual({
      apiProvider: 'openrouter',
      openRouterBaseUrl: 'http://localhost:3000/v1',
      openRouterApiKey: 'freellmapi-test-key',
      openRouterModelId: 'fast-coder',
    });
  });

  it('declares a complete DeepSeek Harness route and claims the default model', () => {
    const dsh = tools.find(tool => tool.id === 'dsh')!;
    const generation = dsh.generate(context);
    const [settings, env] = generation.files;
    expect(settings.path).toBe('/home/tester/.dsh/settings.yaml');
    expect(settings.format).toBe('yaml');
    const value = settings.value as {
      'llm-pi-ai': { providers: Record<string, { api: string; baseURL: string; apiKeyEnv: string; models: { id: string }[] }> };
      'agent-default-model': { provider: string; model: string; reasoningEffort?: string };
    };
    const route = value['llm-pi-ai'].providers.freellmapi;
    // A hand-declared route must carry api, baseURL, and a non-empty models
    // list, or DSH refuses the whole section where it is written.
    expect(route.api).toBe('openai-completions');
    expect(route.baseURL).toBe('http://localhost:3000/v1');
    expect(route.apiKeyEnv).toBe('FREELLMAPI_API_KEY');
    expect(route.models.map(model => model.id)).toEqual(['fast-coder', 'reasoning-model']);
    expect(value['agent-default-model']).toEqual({
      provider: 'freellmapi',
      model: 'fast-coder',
      reasoningEffort: undefined,
    });
    expect('reasoningEffort' in value['agent-default-model']).toBe(true);
    // DSH loads $DSH_HOME/.env as its user environment layer, which is how
    // `apiKeyEnv` resolves without an export.
    expect(env).toMatchObject({
      path: '/home/tester/.dsh/.env',
      format: 'env',
      sensitive: true,
      content: 'FREELLMAPI_API_KEY=freellmapi-test-key\n',
    });
  });

  it('adds a named DeepSeek Harness profile as a second route without moving the default', () => {
    const dsh = tools.find(tool => tool.id === 'dsh')!;
    const value = dsh.generate({ ...context, profile: 'Work Laptop' }).files[0].value as Record<string, unknown>;
    const providers = (value['llm-pi-ai'] as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(['freellmapi-work-laptop']);
    expect(value['agent-default-model']).toBeUndefined();
  });

  it('writes MiMo Code a custom provider its own schema accepts', () => {
    const mimo = tools.find(tool => tool.id === 'mimo')!;
    const [config] = mimo.generate(context).files;
    // The global config directory is XDG-based, and `config.json` is the
    // weakest of the three names it merges, so a hand-written
    // `mimocode.json` still wins.
    expect(config.path).toBe('/home/tester/.config/mimocode/config.json');
    const value = config.value as {
      model: string;
      provider: {
        freellmapi: {
          npm: string;
          options: Record<string, string>;
          models: Record<string, { limit: Record<string, number> }>;
        };
      };
    };
    const provider = value.provider.freellmapi;
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.options).toEqual({
      baseURL: 'http://localhost:3000/v1',
      apiKey: '{env:FREELLMAPI_API_KEY}',
    });
    // `provider.<id>.models.<id>.limit` requires context AND output.
    expect(provider.models['fast-coder'].limit).toEqual({ context: 131072, output: 8192 });
    // The default model has to name an entry that exists in that map.
    expect(value.model).toBe('freellmapi/fast-coder');
    expect(Object.keys(provider.models)).toContain(value.model.split('/')[1]);
    // MIMOCODE_API_KEY and MIMOCODE_BASE_URL do not exist.
    expect(JSON.stringify(mimo.generate(context))).not.toContain('MIMOCODE_');
  });

  it('keeps the MiMo Code default model in its own provider map when auto leads', () => {
    const liveContext: GenerateContext = {
      ...context,
      models: [
        { id: 'auto', name: 'Auto', available: true, context_window: 200_000 },
        ...context.models,
      ],
    };
    const value = tools.find(tool => tool.id === 'mimo')!
      .generate(liveContext).files[0].value as {
        model: string;
        provider: { freellmapi: { models: Record<string, unknown> } };
      };
    expect(value.model).toBe('freellmapi/auto');
    expect(Object.keys(value.provider.freellmapi.models)).toContain('auto');
  });

  it('writes OpenClaw as a custom provider plus the default model ref, key via its own .env', () => {
    // OpenClaw resolves `${VAR}` in openclaw.json from the global
    // ~/.openclaw/.env it loads itself, so the pair works with nothing
    // exported. A custom origin gets no attribution header from OpenClaw, so
    // the provider carries a static User-Agent the gateway can classify.
    const [config, env] = tools.find(tool => tool.id === 'openclaw')!.generate(context).files;
    expect(config.path).toBe('/home/tester/.openclaw/openclaw.json');
    expect(config.format).toBe('json');
    const value = config.value as {
      agents: { defaults: { model: { primary: string } } }
      models: { providers: Record<string, { baseUrl: string; apiKey: string; api: string; headers: Record<string, string>; models: { id: string }[] }> }
    };
    expect(value.agents.defaults.model.primary).toBe('freellmapi/fast-coder');
    const provider = value.models.providers.freellmapi;
    expect(provider.baseUrl).toBe('http://localhost:3000/v1');
    expect(provider.apiKey).toBe('${FREELLMAPI_API_KEY}');
    expect(provider.api).toBe('openai-completions');
    expect(provider.headers).toEqual({ 'User-Agent': 'openclaw' });
    expect(provider.models.map(model => model.id)).toEqual(['fast-coder', 'reasoning-model']);
    expect(env.path).toBe('/home/tester/.openclaw/.env');
    expect(env.sensitive).toBe(true);
    expect(env.content).toBe('FREELLMAPI_API_KEY=freellmapi-test-key\n');
  });

  it('gives a named OpenClaw profile its own provider without touching the default model', () => {
    const generation = tools.find(tool => tool.id === 'openclaw')!.generate({ ...context, profile: 'Work Box' });
    const value = generation.files[0].value as { agents?: unknown; models: { providers: Record<string, unknown> } };
    expect(value.agents).toBeUndefined();
    expect(Object.keys(value.models.providers)).toEqual(['freellmapi-work-box']);
  });

  it('honours OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR the way OpenClaw does', () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', '/srv/claw');
    const [config, env] = tools.find(tool => tool.id === 'openclaw')!.generate(context).files;
    expect(config.path).toBe('/srv/claw/openclaw.json');
    expect(env.path).toBe('/srv/claw/.env');
    vi.stubEnv('OPENCLAW_CONFIG_PATH', '/etc/openclaw.json');
    expect(tools.find(tool => tool.id === 'openclaw')!.generate(context).files[0].path).toBe('/etc/openclaw.json');
  });

  it('writes Hermes Agent as a custom model block with the key routed through its .env', () => {
    // config.yaml is Hermes's single source of truth for the endpoint:
    // OPENAI_BASE_URL is ignored for non-OpenAI hosts and OPENAI_API_KEY is only
    // sent to OpenAI hosts, so both go in the `model` block, the key as the
    // `${VAR}` form Hermes expands from ~/.hermes/.env. Leftover key_env keys
    // from the wizard are retired so they cannot shadow api_key.
    const [config, env] = tools.find(tool => tool.id === 'hermes')!.generate(context).files;
    expect(config.path).toBe('/home/tester/.hermes/config.yaml');
    expect(config.format).toBe('yaml');
    expect(config.value).toEqual({
      model: {
        provider: 'custom',
        default: 'fast-coder',
        base_url: 'http://localhost:3000/v1',
        api_key: '${FREELLMAPI_API_KEY}',
        api_mode: 'chat_completions',
        context_length: 131072,
        default_headers: { 'User-Agent': 'hermes-agent' },
        key_env: undefined,
        api_key_env: undefined,
      },
    });
    expect(env.path).toBe('/home/tester/.hermes/.env');
    expect(env.sensitive).toBe(true);
    expect(env.content).toBe('FREELLMAPI_API_KEY=freellmapi-test-key\n');
  });

  it('gives a named Hermes profile a providers entry instead of the default model', () => {
    vi.stubEnv('HERMES_HOME', '/srv/hermes');
    const [config] = tools.find(tool => tool.id === 'hermes')!.generate({ ...context, profile: 'lab' }).files;
    expect(config.path).toBe('/srv/hermes/config.yaml');
    const value = config.value as { model?: unknown; providers: Record<string, { api: string; default_model: string }> };
    expect(value.model).toBeUndefined();
    expect(value.providers['freellmapi-lab'].api).toBe('http://localhost:3000/v1');
    expect(value.providers['freellmapi-lab'].default_model).toBe('fast-coder');
  });

  it('writes AtomCode as default_provider plus a typed [providers.freellmapi] table', () => {
    // AtomCode ignores a bare `[provider]` table: it looks up the table named
    // by the root `default_provider` key, and only a `type = "openai"` table
    // speaks the OpenAI-compatible wire. `context_window` is its own key.
    const [config] = tools.find(tool => tool.id === 'atomcode')!.generate(context).files;
    expect(config.path).toBe('/home/tester/.atomcode/config.toml');
    expect(config.format).toBe('toml');
    expect(config.sensitive).toBe(true);
    const lines = (config.content ?? '').split('\n');
    expect(lines[0]).toBe('default_provider = "freellmapi"');
    expect(lines).toContain('[providers.freellmapi]');
    expect(lines.indexOf('[providers.freellmapi]')).toBeGreaterThan(0);
    expect(lines).toContain('type = "openai"');
    expect(lines).toContain('base_url = "http://localhost:3000/v1"');
    expect(lines).toContain('api_key = "freellmapi-test-key"');
    expect(lines).toContain('model = "fast-coder"');
    expect(lines).toContain('context_window = 131072');
    expect(config.content).not.toContain('[provider]');
  });

  it('uses /v1 for every OpenAI-compatible generated base URL', () => {
    for (const tool of tools.filter(entry => entry.protocol.startsWith('OpenAI'))) {
      expect(tool.baseUrlSupport, tool.id).toBe('/v1');
    }
    expect(tools.find(tool => tool.id === 'claude')!.baseUrlSupport).toBe('root');
  });

  it('keeps the dashboard metadata export in sync with the tool catalog', () => {
    const expected = tools.map(({ generate: _generate, ...tool }) => tool);
    const packageMetadata = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, '../tools.json'),
      'utf8',
    ));
    const dashboardMetadata = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, '../../client/src/data/agent-tools.json'),
      'utf8',
    ));
    expect(packageMetadata).toEqual(expected);
    expect(dashboardMetadata).toEqual(expected);
  });
});
