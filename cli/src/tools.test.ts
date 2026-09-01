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

  it('uses Crush openai-compat schema and lists every catalog model', () => {
    const config = tools.find(tool => tool.id === 'crush')!
      .generate(context).files[0].value as any;
    expect(config.$schema).toBe('https://charm.land/crush.json');
    expect(config.providers.freellmapi.type).toBe('openai-compat');
    expect(config.providers.freellmapi.models.map((model: any) => model.id)).toEqual([
      'fast-coder',
      'reasoning-model',
    ]);
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
