import path from 'node:path';
import type {
  CatalogModel,
  GenerateContext,
  Generation,
  ToolDefinition,
} from './types.js';

function rootUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function v1Url(url: string): string {
  return `${rootUrl(url)}/v1`;
}

function primaryModel(models: CatalogModel[], requestedId?: string): CatalogModel {
  // An explicit --model wins over every heuristic below. It is validated
  // against the UNFILTERED catalog before we get here, so an id absent from
  // `models` (the available-only roster) is a real, registered model that is
  // merely out of quota right now — pin it anyway rather than silently writing
  // a different model into the user's config.
  if (requestedId) return models.find(model => model.id === requestedId) ?? { id: requestedId };
  // `auto` — the router picking the best model per request — is the whole
  // point of the gateway and the right default for a generated config. Never
  // fall back to `fusion` (multi-model fan-out) by accident.
  return models.find(model => model.id === 'auto')
    ?? models.find(model => model.id !== 'fusion' && model.available !== false)
    ?? models.find(model => model.id !== 'fusion')
    ?? { id: 'auto', name: 'Auto', context_window: 128_000 };
}

function catalogModels(models: CatalogModel[]): CatalogModel[] {
  const available = models.filter(model => model.id !== 'auto' && model.available !== false);
  if (available.length) return available;
  const nonAuto = models.filter(model => model.id !== 'auto');
  return nonAuto.length ? nonAuto : [primaryModel(models)];
}

function contextWindow(model: CatalogModel): number {
  return model.context_window ?? model.context_length ?? 128_000;
}

function outputLimit(model: CatalogModel): number {
  return Math.min(8192, contextWindow(model));
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function tomlString(value: string): string {
  // TOML basic strings use the same escaping as JSON strings.
  return JSON.stringify(value);
}

function claude(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const directory = ctx.profile === 'default'
    ? path.join(ctx.homeDir, '.claude')
    : path.join(ctx.homeDir, '.claude', 'profiles', ctx.profile);
  return {
    files: [{
      path: path.join(directory, 'settings.json'),
      format: 'json',
      sensitive: true,
      value: {
        env: {
          ANTHROPIC_BASE_URL: rootUrl(ctx.url),
          ANTHROPIC_AUTH_TOKEN: ctx.apiKey,
          ANTHROPIC_MODEL: model.id,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow(model)),
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        },
      },
    }],
    notes: [
      ctx.profile === 'default'
        ? 'Claude Code will read this configuration automatically.'
        : `Launch with CLAUDE_CONFIG_DIR=${directory} claude`,
      'For zero-persistence credentials, prefer: freellmapi launch',
    ],
  };
}

function codex(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const compact = Math.max(16_000, Math.floor(contextWindow(model) * 0.9));
  const providerTable = [
    '[model_providers.freellmapi]',
    'name = "FreeLLMAPI"',
    `base_url = ${JSON.stringify(v1Url(ctx.url))}`,
    'wire_api = "responses"',
    'env_key = "FREELLMAPI_API_KEY"',
    'requires_openai_auth = false',
  ];
  // Codex reads exactly one file, ~/.codex/config.toml. Named profiles are
  // `[profiles.NAME]` tables in that same file, selected with
  // `codex --profile NAME`; separate per-profile files are never read.
  const content = ctx.profile === 'default'
    ? [
      '# freellmapi:start',
      `model = ${JSON.stringify(model.id)}`,
      'model_provider = "freellmapi"',
      `model_context_window = ${contextWindow(model)}`,
      `model_auto_compact_token_limit = ${compact}`,
      'tool_output_token_limit = 20000',
      '',
      ...providerTable,
      '# freellmapi:end',
      '',
    ]
    : [
      '# freellmapi:start',
      ...providerTable,
      '',
      `[profiles.${/^[A-Za-z0-9_-]+$/.test(ctx.profile) ? ctx.profile : JSON.stringify(ctx.profile)}]`,
      `model = ${JSON.stringify(model.id)}`,
      'model_provider = "freellmapi"',
      '# freellmapi:end',
      '',
    ];
  return {
    files: [{
      path: path.join(ctx.homeDir, '.codex', 'config.toml'),
      format: 'toml',
      content: content.join('\n'),
    }],
    notes: [
      'Export FREELLMAPI_API_KEY before running codex; the key is not written to config.toml.',
      ...(ctx.profile === 'default'
        ? []
        : [`Activate this profile with: codex --profile ${ctx.profile}`]),
      `Selected ${model.id} with a ${contextWindow(model)} token context window.`,
    ],
  };
}

function cline(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.cline', 'data', 'settings', 'providers.json'),
      format: 'json',
      sensitive: true,
      value: {
        version: 1,
        lastUsedProvider: 'openai-compatible',
        providers: {
          'openai-compatible': {
            settings: {
              provider: 'openai-compatible',
              protocol: 'openai-chat',
              client: 'openai-compatible',
              model: model.id,
              baseUrl: v1Url(ctx.url),
              apiKey: ctx.apiKey,
              contextWindow: contextWindow(model),
              capabilities: ['streaming', 'tools'],
            },
            // The field is required by Cline's persisted schema. Keeping it
            // deterministic makes repeated setup runs idempotent.
            updatedAt: '2026-07-27T00:00:00.000Z',
            tokenSource: 'manual',
          },
        },
      },
    }],
    notes: ['Cline will use the generated OpenAI Compatible provider immediately.'],
  };
}

function continueDev(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.continue', 'config.yaml'),
      format: 'yaml',
      content: [
        '# freellmapi:start',
        'name: FreeLLMAPI',
        'version: 1.0.0',
        'schema: v1',
        'models:',
        '  - name: FreeLLMAPI',
        '    provider: openai',
        `    model: ${yamlString(model.id)}`,
        `    apiBase: ${yamlString(v1Url(ctx.url))}`,
        '    apiKey: ${{ secrets.FREELLMAPI_API_KEY }}',
        '    capabilities:',
        '      - tool_use',
        '    defaultCompletionOptions:',
        `      contextLength: ${contextWindow(model)}`,
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: ['Add FREELLMAPI_API_KEY to Continue secrets; no raw key was written.'],
  };
}

function aider(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.aider.conf.yml'),
      format: 'yaml',
      sensitive: true,
      content: [
        '# freellmapi:start',
        `openai-api-base: ${yamlString(v1Url(ctx.url))}`,
        `openai-api-key: ${yamlString(ctx.apiKey)}`,
        `model: ${yamlString(`openai/${model.id}`)}`,
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: [
      `Environment-only alternative: OPENAI_API_BASE=${v1Url(ctx.url)} OPENAI_API_KEY=… aider --model openai/${model.id}`,
    ],
  };
}

function opencode(ctx: GenerateContext): Generation {
  const modelEntries = Object.fromEntries(ctx.models
    .filter(model => model.id !== 'auto')
    .map(model => [model.id, {
      name: model.name ?? model.id,
      limit: { context: contextWindow(model) },
    }]));
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'opencode', 'opencode.json'),
      format: 'json',
      value: {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          freellmapi: {
            npm: '@ai-sdk/openai-compatible',
            name: 'FreeLLMAPI',
            options: {
              baseURL: v1Url(ctx.url),
              apiKey: '{env:FREELLMAPI_API_KEY}',
            },
            models: modelEntries,
          },
        },
      },
    }],
    notes: ['Export FREELLMAPI_API_KEY before starting OpenCode.'],
  };
}

function goose(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const models = catalogModels(ctx.models).map(entry => ({
    name: entry.id,
    context_limit: contextWindow(entry),
  }));
  return {
    files: [
      {
        path: path.join(
          ctx.homeDir,
          '.config',
          'goose',
          'custom_providers',
          'freellmapi.json',
        ),
        format: 'json',
        value: {
          name: 'freellmapi',
          engine: 'openai',
          display_name: 'FreeLLMAPI',
          description: 'FreeLLMAPI OpenAI-compatible gateway',
          api_key_env: 'FREELLMAPI_API_KEY',
          base_url: v1Url(ctx.url),
          models,
          supports_streaming: true,
          requires_auth: true,
          dynamic_models: false,
          preserves_thinking: true,
        },
      },
      {
        path: path.join(ctx.homeDir, '.config', 'goose', 'config.yaml'),
        format: 'yaml',
        content: [
          '# freellmapi:start',
          'GOOSE_PROVIDER: freellmapi',
          `GOOSE_MODEL: ${yamlString(model.id)}`,
          '# freellmapi:end',
          '',
        ].join('\n'),
      },
    ],
    notes: ['Export FREELLMAPI_API_KEY before starting Goose.'],
  };
}

function qwen(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const dir = path.join(ctx.homeDir, '.qwen');
  const models = catalogModels(ctx.models).map(entry => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    envKey: 'FREELLMAPI_API_KEY',
    baseUrl: v1Url(ctx.url),
    generationConfig: {
      contextWindowSize: contextWindow(entry),
    },
  }));
  return {
    files: [
      {
        path: path.join(dir, 'settings.json'),
        format: 'json',
        value: {
          model: { name: model.id },
          modelProviders: {
            openai: {
              protocol: 'openai',
              models,
            },
          },
          security: { auth: { selectedType: 'openai' } },
        },
      },
      {
        path: path.join(dir, '.env'),
        format: 'env',
        sensitive: true,
        content: `FREELLMAPI_API_KEY=${ctx.apiKey}\n`,
      },
    ],
    notes: [
      `Native Gemini mode is also available at ${rootUrl(ctx.url)}/v1beta with GEMINI_API_KEY.`,
    ],
  };
}

function roo(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const importPath = path.join(ctx.homeDir, '.roo', 'freellmapi.json');
  return {
    files: [{
      path: importPath,
      format: 'json',
      sensitive: true,
      value: {
        providerProfiles: {
          currentApiConfigName: 'freellmapi',
          apiConfigs: {
            freellmapi: {
              apiProvider: 'openai',
              openAiBaseUrl: v1Url(ctx.url),
              openAiApiKey: ctx.apiKey,
              openAiModelId: model.id,
            },
          },
        },
        globalSettings: {},
      },
    }],
    notes: [`Set Roo Code's autoImportSettingsPath to ${importPath}.`],
  };
}

function kilo(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  const models = Object.fromEntries(catalogModels(ctx.models).map(entry => [
    entry.id,
    {
      name: entry.name ?? entry.id,
      tool_call: true,
      limit: {
        context: contextWindow(entry),
        output: outputLimit(entry),
      },
    },
  ]));
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'kilo', 'kilo.jsonc'),
      format: 'json',
      value: {
        $schema: 'https://app.kilo.ai/config.json',
        model: `openai-compatible/${model.id}`,
        provider: {
          'openai-compatible': {
            options: {
              apiKey: '{env:FREELLMAPI_API_KEY}',
              baseURL: v1Url(ctx.url),
            },
            models,
          },
        },
      },
    }],
    notes: [
      'Export FREELLMAPI_API_KEY before starting Kilo; global config is trusted for {env:…} expansion.',
    ],
  };
}

function crush(ctx: GenerateContext): Generation {
  const models = catalogModels(ctx.models).map(entry => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    cost_per_1m_in: 0,
    cost_per_1m_out: 0,
    cost_per_1m_in_cached: 0,
    cost_per_1m_out_cached: 0,
    context_window: contextWindow(entry),
    default_max_tokens: outputLimit(entry),
    can_reason: false,
    supports_attachments: false,
  }));
  return {
    files: [{
      path: path.join(ctx.homeDir, '.config', 'crush', 'crush.json'),
      format: 'json',
      value: {
        $schema: 'https://charm.land/crush.json',
        providers: {
          freellmapi: {
            name: 'FreeLLMAPI',
            type: 'openai-compat',
            base_url: v1Url(ctx.url),
            api_key: '$FREELLMAPI_API_KEY',
            models,
          },
        },
      },
    }],
    notes: ['Export FREELLMAPI_API_KEY before starting Crush.'],
  };
}

function cursor(ctx: GenerateContext): Generation {
  return {
    files: [],
    notes: [
      'Cursor sends model traffic through its cloud service, so localhost is not reachable from Cursor.',
      `Expose the gateway through a trusted HTTPS tunnel, then open Cursor Settings → Models, enable Override OpenAI Base URL, and enter <public-url>/v1.`,
      'Cursor only documents custom keys for standard chat models; custom base-URL overrides may not support Responses-based or built-in models.',
      'The override affects Cursor globally while enabled, so disable it before switching back to built-in providers.',
      'Use a separately revocable URL token if the client cannot set an Authorization header.',
    ],
  };
}

function generic(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models, ctx.requestedModelId);
  return {
    files: [],
    notes: [
      `OPENAI_BASE_URL=${v1Url(ctx.url)}`,
      `OPENAI_API_KEY=${ctx.apiKey || '<unified-key>'}`,
      `OPENAI_MODEL=${model.id}`,
      `curl ${v1Url(ctx.url)}/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" -d '{"model":"${model.id}","messages":[{"role":"user","content":"Hello"}]}'`,
    ],
  };
}

// AtomCode (#799): Rust terminal coding agent. TOML config at
// ~/.atomcode/config.toml (or per-project .atomcode/); `base_url` + `api_key`
// point at the unified /v1 endpoint.
function atomcode(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.atomcode', 'config.toml'),
      format: 'toml',
      sensitive: true,
      content: [
        '# freellmapi:start',
        `base_url = ${tomlString(v1Url(ctx.url))}`,
        `api_key = ${tomlString(ctx.apiKey)}`,
        `model = ${tomlString(model.id)}`,
        '# freellmapi:end',
        '',
      ].join('\n'),
    }],
    notes: [
      `Environment-only alternative: ATOMCODE_API_KEY=${ctx.apiKey || '<unified-key>'} ATOMCODE_BASE_URL=${v1Url(ctx.url)} atomcode --model ${model.id}`,
    ],
  };
}

// MiMo Code (#800): Xiaomi's terminal agent, Claude Code compatible. JSON
// config under ~/.mimocode/ (or MIMOCODE_CONFIG); provider options accept
// apiKey + baseURL.
function mimo(ctx: GenerateContext): Generation {
  const model = primaryModel(ctx.models);
  return {
    files: [{
      path: path.join(ctx.homeDir, '.mimocode', 'config.json'),
      format: 'json',
      sensitive: true,
      value: {
        provider: {
          freellmapi: {
            apiKey: ctx.apiKey,
            baseURL: v1Url(ctx.url),
          },
        },
        model: model.id,
      },
    }],
    notes: [
      `Environment-only alternative: MIMOCODE_API_KEY=${ctx.apiKey || '<unified-key>'} MIMOCODE_BASE_URL=${v1Url(ctx.url)} mimocode --model ${model.id}`,
    ],
  };
}

const metadata = [
  ['claude', 'Claude Code', 'code', 'file', 'Anthropic Messages', 'root', 'setup-claude', 'https://docs.anthropic.com/en/docs/claude-code', "Anthropic's terminal coding agent; a good default choice.", claude],
  ['codex', 'Codex CLI', 'code', 'file', 'OpenAI Responses', '/v1', 'setup-codex', 'https://developers.openai.com/codex', "OpenAI's CLI coding agent.", codex],
  ['cline', 'Cline', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-cline', 'https://docs.cline.bot', 'VS Code extension that turns your editor into an AI pair programmer.', cline],
  ['continue', 'Continue', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-continue', 'https://docs.continue.dev', 'Open-source autopilot for VS Code and JetBrains.', continueDev],
  ['aider', 'Aider', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-aider', 'https://aider.chat/docs', 'Terminal pair-programming agent for git repos.', aider],
  ['opencode', 'OpenCode', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-opencode', 'https://opencode.ai/docs', 'Open-source terminal AI coding agent.', opencode],
  ['atomcode', 'AtomCode', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-atomcode', 'https://atomcode.atomgit.com/docs/zh/', 'Open-source terminal AI coding agent (Rust).', atomcode],
  ['mimo', 'MiMo Code', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-mimo', 'https://mimo.xiaomi.com/zh/mimocode', "Xiaomi's terminal coding agent (Claude Code compatible).", mimo],
  ['goose', 'Goose', 'agent', 'file', 'OpenAI Chat', '/v1', 'setup-goose', 'https://block.github.io/goose', "Block's open-source coding agent for desktop and CLI.", goose],
  ['qwen', 'Qwen Code', 'code', 'file', 'OpenAI or Gemini', '/v1', 'setup-qwen', 'https://qwenlm.github.io/qwen-code-docs', 'Alibaba\'s terminal coding agent (Qwen models).', qwen],
  ['roo', 'Roo Code', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-roo', 'https://docs.roocode.com', 'VS Code extension that turns your editor into an AI pair programmer.', roo],
  ['kilo', 'Kilo Code', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-kilo', 'https://kilocode.ai/docs', 'VS Code extension that turns your editor into an AI pair programmer.', kilo],
  ['crush', 'Crush', 'code', 'file', 'OpenAI Chat', '/v1', 'setup-crush', 'https://github.com/charmbracelet/crush', 'VS Code extension that turns your editor into an AI pair programmer.', crush],
  ['cursor', 'Cursor', 'code', 'guide', 'OpenAI Chat', '/v1', 'setup-cursor', 'https://docs.cursor.com', 'AI-first code editor.', cursor],
  ['generic', 'Generic OpenAI client', 'agent', 'guide', 'OpenAI Chat', '/v1', 'setup-generic', 'https://github.com/tashfeenahmed/freellmapi', 'Any OpenAI-compatible client.', generic],
] as const;

export const tools: ToolDefinition[] = metadata.map(([
  id,
  name,
  category,
  configType,
  protocol,
  baseUrlSupport,
  command,
  docsUrl,
  description,
  generate,
]) => ({
  id,
  name,
  description,
  category,
  configType,
  protocol,
  baseUrlSupport,
  command,
  docsUrl,
  generate,
}));

export function getTool(id: string): ToolDefinition | undefined {
  return tools.find(tool => tool.id === id);
}
