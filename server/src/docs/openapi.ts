// Hand-written OpenAPI 3.0 description of the public `/v1` surface.
//
// Why a TypeScript module and not a raw `openapi.json`: the server ships three
// ways — `tsc` build then `node dist/index.js` (Docker / npm), `tsx` (dev), and
// an esbuild single-file bundle for the desktop app (which carries no server
// `node_modules`). A raw `.json` served from disk breaks the compiled and
// bundled targets (tsc does not copy `.json` into `dist/`, and the bundle has
// no file to read). Exporting the spec from a `.ts` module compiles, bundles,
// and type-checks in every one of those targets with zero extra build wiring.
//
// Served as JSON at `GET /v1/openapi.json`. Keep it in sync with the routers in
// `routes/proxy.ts`, `routes/responses.ts`, and `routes/anthropic.ts` — the
// docs route test asserts every path here resolves to a real route.

// A relative server URL keeps the docs correct on any host or port (localhost,
// LAN, container) and avoids baking an address into the repo.
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'FreeLLMAPI',
    version: '0.4.1',
    description:
      'OpenAI-compatible proxy that aggregates free LLM provider tiers behind a single /v1 endpoint. ' +
      'A router picks an available model per request and fails over when a provider is rate-limited. ' +
      'The gateway also speaks OpenAI Responses, Anthropic Messages, native Gemini, and Ollama wire formats.',
    license: { name: 'MIT', url: 'https://github.com/tashfeenahmed/freellmapi/blob/main/LICENSE' },
  },
  servers: [
    { url: '/', description: 'This proxy instance' },
  ],
  security: [
    { bearerAuth: [] },
    { apiKeyAuth: [] },
  ],
  tags: [
    { name: 'Chat', description: 'OpenAI-compatible chat and completion endpoints' },
    { name: 'Media', description: 'Image generation and text-to-speech' },
    { name: 'Search', description: 'Web search over Parallel and Keenable (keyless) and your Tavily, Exa, Firecrawl and Linkup keys' },
    { name: 'Decisions', description: 'Decision models (choice, yes/no, score) over your Cloudflare and OpenRouter keys' },
    { name: 'Responses', description: 'OpenAI Responses API (Codex CLI wire format)' },
    { name: 'Anthropic', description: 'Anthropic Messages API (Claude Code and the Anthropic SDKs)' },
    { name: 'Models', description: 'Model discovery' },
    { name: 'Gemini', description: 'Native Gemini generateContent wire format' },
    { name: 'Ollama', description: 'Opt-in Ollama-compatible local-client surface' },
    { name: 'URL tokens', description: 'Headerless-client aliases using separately revocable URL tokens' },
  ],
  paths: {
    '/v1/chat/completions': {
      post: {
        tags: ['Chat'],
        operationId: 'createChatCompletion',
        summary: 'Create a chat completion',
        description:
          'OpenAI-compatible chat completions. Set `model` to `auto` (the default) to let the router ' +
          'pick a free model, or pass a specific model id. Supports streaming, tools, and vision.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description:
              'A chat completion. When `stream: true`, the body is a `text/event-stream` of ' +
              'OpenAI-style `chat.completion.chunk` events terminated by `data: [DONE]`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/completions': {
      post: {
        tags: ['Chat'],
        operationId: 'createCompletion',
        summary: 'Create a legacy text completion',
        description:
          'OpenAI-compatible legacy completions. Editor ghost-text clients still send `prompt`/`suffix` ' +
          'here; requests are routed through chat models while preserving the `text_completion` shape.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CompletionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'A text completion (`object: "text_completion"`), or an SSE stream when `stream: true`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CompletionResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/embeddings': {
      post: {
        tags: ['Chat'],
        operationId: 'createEmbedding',
        summary: 'Create embeddings',
        description: 'OpenAI-compatible embeddings. `input` accepts a string or an array of strings.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EmbeddingRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'A list of embedding vectors.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EmbeddingResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/images/generations': {
      post: {
        tags: ['Media'],
        operationId: 'createImage',
        summary: 'Generate images',
        description:
          'OpenAI-compatible image generation, routed through the media catalog. Omit `model` (or set ' +
          '`auto`) to try every enabled image provider in order; pass a provider model id to pin one.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ImageRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Generated image(s), as URLs or base64 depending on `response_format`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImageResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/search': {
      post: {
        tags: ['Search'],
        operationId: 'createSearch',
        summary: 'Search the web',
        description:
          'Web search routed over the search engines in the catalog (Parallel, Tavily, Exa, Firecrawl, Linkup, Keenable) and any ' +
          'custom search relay. Omit `engine` (or set `auto`) to fail over across engines that have a key; ' +
          'rate-limited or out-of-credit keys cool down and the next one is tried.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', example: 'latest Node.js LTS release' },
                  max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                  topic: { type: 'string', enum: ['general', 'news'] },
                  include_answer: { type: 'boolean', description: 'Ask engines that support it (Tavily, Linkup) for a short answer.' },
                  engine: { type: 'string', description: 'Pin one engine id from GET /v1/search/engines, or `auto`.' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Search hits from the first engine that answered.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    answer: { type: 'string' },
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          title: { type: 'string' },
                          url: { type: 'string' },
                          content: { type: 'string' },
                          score: { type: 'number' },
                        },
                      },
                    },
                    provider: { type: 'string', example: 'tavily' },
                    engine: { type: 'string', example: 'tavily-search' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/search/engines': {
      get: {
        tags: ['Search'],
        operationId: 'listSearchEngines',
        summary: 'List search engines',
        description: 'The enabled search engines, in failover order, and whether each has a usable key.',
        responses: {
          '200': {
            description: 'Search engines.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', example: 'tavily-search' },
                          object: { type: 'string', example: 'search_engine' },
                          provider: { type: 'string', example: 'tavily' },
                          name: { type: 'string' },
                          available: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/decisions': {
      post: {
        tags: ['Decisions'],
        operationId: 'createDecision',
        summary: 'Ask a decision model',
        description:
          'Ask typed questions about `state` and get probabilities back instead of generated text: pick one option ' +
          '(`choice`), yes/no (`noul`) or a rating on a rubric (`score`). Served by the decision models in the catalog ' +
          '(Cloudflare Clef Flash, OpenRouter Mercury Decide) on your Cloudflare and OpenRouter keys. Omit `model` (or set ' +
          '`auto`) to fail over across models that have a key. `POST /v1/systemone` is an alias. Chat routing never uses these models.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['state', 'questions'],
                properties: {
                  model: { type: 'string', description: 'A model id from GET /v1/decisions/models, or `auto`.' },
                  state: { description: 'The text or structured data (object/array) to decide about.', example: 'my react useEffect runs twice, why?' },
                  questions: {
                    type: 'object',
                    description: '1 to 64 questions keyed by your own id; answers come back under the same ids.',
                    additionalProperties: {
                      type: 'object',
                      required: ['type', 'instructions'],
                      properties: {
                        type: { type: 'string', enum: ['choice', 'noul', 'score'] },
                        instructions: { description: 'The question to answer.' },
                        criteria: {
                          description: 'choice: a map of option id to description. score: an ordered array of levels, lowest first. noul: optional { true, false } descriptions.',
                        },
                      },
                    },
                    example: { tier: { type: 'choice', instructions: 'Which model tier should answer this?', criteria: { light: 'Casual chat', code: 'Coding' } } },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Answers from the first decision model that responded.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'decision' },
                    model: { type: 'string', example: '@cf/cloudflare/clef-flash' },
                    provider: { type: 'string', example: 'cloudflare' },
                    answers: {
                      type: 'object',
                      additionalProperties: { type: 'object' },
                      example: { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.01, code: 0.99 }, confidence: 0.95 } },
                    },
                    usage: {
                      type: 'object',
                      properties: { input_tokens: { type: 'integer' }, output_tokens: { type: 'integer' } },
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/decisions/models': {
      get: {
        tags: ['Decisions'],
        operationId: 'listDecisionModels',
        summary: 'List decision models',
        description: 'The enabled decision models, in failover order, and whether each has a usable key.',
        responses: {
          '200': {
            description: 'Decision models.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', example: '@cf/cloudflare/clef-flash' },
                          object: { type: 'string', example: 'decision_model' },
                          provider: { type: 'string', example: 'cloudflare' },
                          name: { type: 'string' },
                          context_window: { type: 'integer', nullable: true },
                          available: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/videos/generations': {
      post: {
        tags: ['Media'],
        operationId: 'createVideo',
        summary: 'Generate video',
        description:
          'Text-to-video generation routed through the dedicated video catalog. Omit `model` (or set ' +
          '`auto`) to fail over across configured providers. The completed video is returned as MP4 bytes; ' +
          'provider-specific options that are unsupported by the selected model are ignored.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VideoRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'The generated video.',
            content: {
              'video/mp4': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/audio/speech': {
      post: {
        tags: ['Media'],
        operationId: 'createSpeech',
        summary: 'Generate speech (text-to-speech)',
        description:
          'OpenAI-compatible text-to-speech, routed through the media catalog. Returns raw audio bytes; ' +
          'the `Content-Type` reflects the chosen `response_format`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SpeechRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Raw audio bytes.',
            content: {
              'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/audio/transcriptions': {
      post: {
        tags: ['Media'],
        operationId: 'createTranscription',
        summary: 'Transcribe audio (speech-to-text)',
        description:
          'OpenAI-compatible speech-to-text over free whisper deployments (Groq, Cloudflare Workers AI), ' +
          'with failover across providers. Multipart upload, held in memory only; maximum file size 25 MB. ' +
          "response_format 'vtt' is only available from providers that produce it natively; 'srt' is not " +
          'supported and returns 400 unsupported_format. The model registry is delivered by catalog sync; ' +
          "an install that has not yet synced any transcription models returns 503 with code 'no_transcription_models'.",
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/TranscriptionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'The transcription in the requested format.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                },
              },
              'text/plain': { schema: { type: 'string' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '413': {
            description: 'The uploaded audio exceeds the 25 MB limit.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
          '503': {
            description:
              "No transcription models synced yet (code 'no_transcription_models'): the registry arrives via catalog sync.",
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/v1/responses': {
      post: {
        tags: ['Responses'],
        operationId: 'createResponse',
        summary: 'Create a model response (OpenAI Responses API)',
        description:
          'The OpenAI Responses wire format that current Codex CLI versions require, implemented as a ' +
          'translating shim over the same router. Supports streaming events and tool calls. Image input ' +
          'is not supported here; use /chat/completions with an image_url content part instead.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResponseRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'A response object, or an SSE stream of Responses events when `stream: true`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ResponseObject' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/messages': {
      post: {
        tags: ['Anthropic'],
        operationId: 'createMessage',
        summary: 'Create a message (Anthropic Messages API)',
        description:
          "Anthropic's Messages wire format over the same router, so Claude Code and the official " +
          'Anthropic SDKs run against your free pool. Claude family names (opus / sonnet / haiku / ' +
          'default) map to `auto` or a pinned model on the Keys page. Send the key via the `x-api-key` ' +
          'header (Anthropic style) or an Authorization bearer token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AnthropicMessageRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'An Anthropic message, or an SSE stream of Anthropic events when `stream: true`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnthropicMessageResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { $ref: '#/components/responses/UpstreamError' },
        },
      },
    },
    '/v1/messages/count_tokens': {
      post: {
        tags: ['Anthropic'],
        operationId: 'countTokens',
        summary: 'Count input tokens (Anthropic Messages API)',
        description: 'Estimates the input token count for an Anthropic Messages request without running it.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AnthropicMessageRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'An estimated input token count.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CountTokensResponse' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/models': {
      get: {
        tags: ['Models'],
        operationId: 'listModels',
        summary: 'List available models',
        description:
          'Lists the catalog, one row per model id, each tagged with whether it is usable right now, ' +
          'plus the virtual `auto` id. Content-negotiated: sending an `anthropic-version` header returns ' +
          'the Anthropic model-list shape; otherwise the OpenAI shape is returned. `?available=true` ' +
          'filters to models that can serve a request now.',
        parameters: [
          {
            name: 'available',
            in: 'query',
            required: false,
            description: 'When `true`, return only models that are currently usable.',
            schema: { type: 'boolean' },
          },
        ],
        responses: {
          '200': {
            description: 'The model list.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ModelList' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/models/{id}': {
      get: {
        tags: ['Models'],
        operationId: 'retrieveModel',
        summary: 'Retrieve a single model (OpenAI models.retrieve)',
        description:
          'Returns one catalog entry by id in the OpenAI model shape, so ' +
          'OpenAI-SDK clients (``client.models.retrieve(id)``) can resolve a ' +
          'model before routing. Includes the virtual `auto` and `fusion` ids ' +
          'and any catalog id with a slash (URL-encode the slash). Served from ' +
          'the same builder as the list, so the two never disagree.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Model id (e.g. `auto`, or `vendor/model` — slash URL-encoded).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'The model.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Model' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'No model with this id (OpenAI error shape: `model_not_found`).' },
        },
      },
    },
    '/v1/usage': {
      get: {
        tags: ['Models'],
        operationId: 'getUsage',
        summary: 'Month-to-date consumption for this gateway',
        description:
          'Unified API key only (client-profile keys get 403). ' +
          'Returns the current calendar month\'s successful requests and tokens, split by provider ' +
          'platform, plus the UTC instant when the monthly window resets. Read from the same ledger ' +
          'the per-key monthly caps enforce, so these numbers always agree with a 429 quota_exceeded ' +
          'response. Mirrors OpenRouter GET /api/v1/auth/key and LiteLLM /key/info.',
        responses: {
          '200': { description: 'Usage roll-up: month, resetsAt, requests, tokens, byPlatform[], byKey[] (per provider key: label, enabled, requests, tokens, requestCap, tokenCap; null cap = unlimited).' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Called with a client-profile key; usage is install-wide, so only the unified key may read it.' },
        },
      },
    },
    '/v1beta/models': {
      get: {
        tags: ['Gemini'],
        operationId: 'listGeminiModels',
        summary: 'List models in Gemini format',
        security: [{ googleApiKeyHeader: [] }, { googleApiKeyQuery: [] }, { bearerAuth: [] }],
        responses: {
          '200': { description: 'Gemini-shaped model list.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1beta/models/{model}': {
      get: {
        tags: ['Gemini'],
        operationId: 'getGeminiModel',
        summary: 'Get Gemini-shaped model metadata',
        security: [{ googleApiKeyHeader: [] }, { googleApiKeyQuery: [] }, { bearerAuth: [] }],
        parameters: [{
          name: 'model',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        responses: {
          '200': { description: 'Gemini-shaped model metadata.' },
          '404': { description: 'Model not found.' },
        },
      },
    },
    '/v1beta/models/{model}:generateContent': {
      post: {
        tags: ['Gemini'],
        operationId: 'generateGeminiContent',
        summary: 'Generate content using the native Gemini wire format',
        security: [{ googleApiKeyHeader: [] }, { googleApiKeyQuery: [] }, { bearerAuth: [] }],
        parameters: [{
          name: 'model',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GeminiGenerateRequest' } } },
        },
        responses: {
          '200': { description: 'Gemini candidates and usage metadata.' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1beta/models/{model}:streamGenerateContent': {
      post: {
        tags: ['Gemini'],
        operationId: 'streamGeminiContent',
        summary: 'Stream native Gemini content',
        description: 'Use `?alt=sse` for Gemini CLI SSE. Without it, the response is a streamed JSON array.',
        security: [{ googleApiKeyHeader: [] }, { googleApiKeyQuery: [] }, { bearerAuth: [] }],
        parameters: [
          { name: 'model', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'alt', in: 'query', required: false, schema: { type: 'string', enum: ['sse'] } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GeminiGenerateRequest' } } },
        },
        responses: {
          '200': { description: 'SSE or JSON-array Gemini stream.' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1beta/models/{model}:countTokens': {
      post: {
        tags: ['Gemini'],
        operationId: 'countGeminiTokens',
        summary: 'Estimate tokens for Gemini content',
        security: [{ googleApiKeyHeader: [] }, { googleApiKeyQuery: [] }, { bearerAuth: [] }],
        parameters: [{
          name: 'model',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GeminiGenerateRequest' } } },
        },
        responses: {
          '200': { description: 'Heuristic token count.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/tags': {
      get: {
        tags: ['Ollama'],
        operationId: 'listOllamaModels',
        summary: 'List models in Ollama format',
        'x-optional-surface': true,
        responses: { '200': { description: 'Ollama model list.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/api/chat': {
      post: {
        tags: ['Ollama'],
        operationId: 'ollamaChat',
        summary: 'Create an Ollama chat response',
        description: 'Streaming defaults to NDJSON, matching Ollama.',
        'x-optional-surface': true,
        responses: { '200': { description: 'Ollama chat response or NDJSON stream.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/api/generate': {
      post: {
        tags: ['Ollama'],
        operationId: 'ollamaGenerate',
        summary: 'Create an Ollama legacy prompt response',
        'x-optional-surface': true,
        responses: { '200': { description: 'Ollama generation response or NDJSON stream.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/api/show': {
      post: {
        tags: ['Ollama'],
        operationId: 'showOllamaModel',
        summary: 'Show Ollama model metadata',
        'x-optional-surface': true,
        responses: { '200': { description: 'Ollama model metadata.' }, '404': { description: 'Emulation disabled or model missing.' } },
      },
    },
    '/api/version': {
      get: {
        tags: ['Ollama'],
        operationId: 'getOllamaVersion',
        summary: 'Get emulated Ollama version',
        'x-optional-surface': true,
        responses: { '200': { description: 'Emulation version.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/api/embed': {
      post: {
        tags: ['Ollama'],
        operationId: 'ollamaEmbed',
        summary: 'Create Ollama embeddings',
        'x-optional-surface': true,
        responses: { '200': { description: 'Ollama embedding vectors.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/api/embeddings': {
      post: {
        tags: ['Ollama'],
        operationId: 'ollamaLegacyEmbed',
        summary: 'Create a legacy Ollama embedding',
        description: 'A valid dashboard session falls through to the dashboard embeddings API.',
        'x-optional-surface': true,
        responses: { '200': { description: 'Legacy Ollama embedding.' }, '404': { description: 'Emulation disabled.' } },
      },
    },
    '/v1/t/{token}/models': {
      get: {
        tags: ['URL tokens'],
        operationId: 'listModelsWithUrlToken',
        summary: 'Headerless model discovery',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        security: [],
        responses: { '200': { description: 'OpenAI-shaped model list.' }, '401': { description: 'Invalid or revoked URL token.' } },
      },
    },
    '/v1/t/{token}/chat/completions': {
      post: {
        tags: ['URL tokens'],
        operationId: 'chatWithUrlToken',
        summary: 'Headerless OpenAI chat completions',
        description: 'URL tokens are separately revocable and are never the unified API key. URLs can leak into history and logs.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        security: [],
        responses: { '200': { description: 'OpenAI chat completion.' }, '401': { description: 'Invalid or revoked URL token.' } },
      },
    },
    '/v1/t/{token}/responses': {
      post: {
        tags: ['URL tokens'],
        operationId: 'responsesWithUrlToken',
        summary: 'Headerless OpenAI Responses API',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        security: [],
        responses: { '200': { description: 'OpenAI Responses response.' }, '401': { description: 'Invalid or revoked URL token.' } },
      },
    },
    '/v1/t/{token}/api/chat': {
      post: {
        tags: ['URL tokens'],
        operationId: 'ollamaChatWithUrlToken',
        summary: 'Headerless Ollama chat',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        security: [],
        responses: { '200': { description: 'Ollama response or NDJSON stream.' }, '401': { description: 'Invalid or revoked URL token.' } },
      },
    },
    '/v1/t/{token}/api/tags': {
      get: {
        tags: ['URL tokens'],
        operationId: 'ollamaTagsWithUrlToken',
        summary: 'Headerless Ollama model discovery',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        security: [],
        responses: { '200': { description: 'Ollama model list.' }, '401': { description: 'Invalid or revoked URL token.' } },
      },
    },
  },
  components: {
    securitySchemes: {
      // The unified API key from the Keys page. Send it as either an OpenAI-style
      // bearer token or an Anthropic-style x-api-key header — both are accepted.
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Unified API key as `Authorization: Bearer <key>`.',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Unified API key as `x-api-key: <key>` (Anthropic-style clients).',
      },
      googleApiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-goog-api-key',
        description: 'Unified API key in Gemini SDK format.',
      },
      googleApiKeyQuery: {
        type: 'apiKey',
        in: 'query',
        name: 'key',
        description: 'Gemini compatibility fallback. Prefer the header because URLs leak into history and logs.',
      },
    },
    responses: {
      BadRequest: {
        description: 'The request was malformed.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'Missing or invalid API key.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Rate limit exceeded.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      UpstreamError: {
        description: 'Every candidate provider failed to serve the request.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      GeminiGenerateRequest: {
        type: 'object',
        required: ['contents'],
        properties: {
          contents: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'model'] },
                parts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    description: 'A text, inlineData, functionCall, or functionResponse part.',
                  },
                },
              },
            },
          },
          systemInstruction: { type: 'object' },
          tools: { type: 'array', items: { type: 'object' } },
          toolConfig: { type: 'object' },
          generationConfig: {
            type: 'object',
            properties: {
              temperature: { type: 'number' },
              topP: { type: 'number' },
              topK: { type: 'integer' },
              maxOutputTokens: { type: 'integer' },
              stopSequences: { type: 'array', items: { type: 'string' } },
              responseMimeType: { type: 'string' },
              responseSchema: { type: 'object' },
              thinkingConfig: { type: 'object' },
            },
          },
        },
      },
      ChatCompletionRequest: {
        type: 'object',
        required: ['messages'],
        properties: {
          model: { type: 'string', description: "Model id, or 'auto' for automatic routing.", default: 'auto' },
          messages: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/Message' } },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          max_tokens: { type: 'integer', description: 'Values <= 0 are treated as "no limit".' },
          top_p: { type: 'number', minimum: 0, maximum: 1 },
          stop: {
            description: 'Up to a few stop sequences.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          stream: { type: 'boolean', default: false },
          tools: { type: 'array', items: { $ref: '#/components/schemas/Tool' }, nullable: true },
          tool_choice: {
            nullable: true,
            oneOf: [
              { type: 'string', enum: ['none', 'auto', 'required', 'any'] },
              { $ref: '#/components/schemas/ToolChoiceObject' },
            ],
          },
          parallel_tool_calls: { type: 'boolean', nullable: true },
        },
      },
      Message: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool', 'function'] },
          content: {
            description: 'A string, or an array of content parts (text and image_url) for vision.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
            nullable: true,
          },
          name: { type: 'string' },
          tool_calls: { type: 'array', items: { $ref: '#/components/schemas/ToolCall' } },
          tool_call_id: { type: 'string' },
        },
      },
      Tool: {
        type: 'object',
        required: ['type', 'function'],
        properties: {
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object', description: 'JSON Schema for the function arguments.' },
              strict: { type: 'boolean' },
            },
          },
        },
      },
      ToolChoiceObject: {
        type: 'object',
        required: ['type', 'function'],
        properties: {
          type: { type: 'string', enum: ['function'] },
          function: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
      },
      ToolCall: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              arguments: { type: 'string', description: 'JSON-encoded arguments.' },
            },
          },
        },
      },
      ChatCompletionResponse: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string', example: 'chat.completion' },
          created: { type: 'integer' },
          model: { type: 'string' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                message: { $ref: '#/components/schemas/Message' },
                finish_reason: { type: 'string', nullable: true },
              },
            },
          },
          usage: { $ref: '#/components/schemas/Usage' },
        },
      },
      CompletionRequest: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { type: 'string', default: 'auto' },
          prompt: { type: 'string' },
          suffix: { type: 'string', description: 'Text after the cursor, for fill-in-the-middle clients.' },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          max_tokens: { type: 'integer' },
          top_p: { type: 'number', minimum: 0, maximum: 1 },
          stop: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          stream: { type: 'boolean', default: false },
        },
      },
      CompletionResponse: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string', example: 'text_completion' },
          created: { type: 'integer' },
          model: { type: 'string' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                index: { type: 'integer' },
                logprobs: { nullable: true },
                finish_reason: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      EmbeddingRequest: {
        type: 'object',
        required: ['input'],
        properties: {
          model: { type: 'string', default: 'auto' },
          input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          dimensions: { type: 'integer', minimum: 1, description: 'Requested output dimensionality, if the model supports it.' },
        },
      },
      EmbeddingResponse: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['list'] },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                object: { type: 'string', enum: ['embedding'] },
                index: { type: 'integer' },
                embedding: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          model: { type: 'string' },
          provider: { type: 'string' },
          usage: { $ref: '#/components/schemas/Usage' },
        },
      },
      ImageRequest: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { type: 'string', default: 'auto' },
          prompt: { type: 'string', minLength: 1 },
          n: { type: 'integer', minimum: 1, maximum: 4 },
          size: { type: 'string', example: '1024x1024' },
          response_format: { type: 'string', enum: ['url', 'b64_json'] },
        },
      },
      ImageResponse: {
        type: 'object',
        properties: {
          created: { type: 'integer' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                b64_json: { type: 'string' },
              },
            },
          },
          model: { type: 'string' },
          provider: { type: 'string' },
        },
      },
      VideoRequest: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { type: 'string', default: 'auto' },
          prompt: { type: 'string', minLength: 1 },
          duration: {
            type: 'integer',
            minimum: 1,
            maximum: 120,
            description: 'Requested duration in seconds. Supported values are model-specific; nova-reel accepts multiples of 6.',
          },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
          image: { type: 'string', format: 'uri', description: 'Optional starting-frame image URL.' },
          seed: { type: 'integer', minimum: -1, maximum: 2147483647 },
          audio: { type: 'boolean', description: 'Request generated audio when the selected model supports it.' },
        },
      },
      SpeechRequest: {
        type: 'object',
        required: ['input'],
        properties: {
          model: { type: 'string', default: 'auto' },
          input: { type: 'string', minLength: 1 },
          voice: {
            type: 'string',
            description:
              'OpenAI voice names are translated to the selected provider voice. Native Gemini and SiliconFlow names are also accepted; unknown names use the provider default.',
          },
          response_format: { type: 'string', example: 'mp3' },
        },
      },
      TranscriptionRequest: {
        type: 'object',
        required: ['file', 'model'],
        properties: {
          file: { type: 'string', format: 'binary', description: 'The audio file to transcribe (max 25 MB).' },
          model: {
            type: 'string',
            description: "'whisper-1' or 'auto' lets the router pick; a provider model id (e.g. 'whisper-large-v3-turbo', '@cf/openai/whisper') pins to that deployment.",
          },
          language: { type: 'string', description: 'ISO-639-1 hint forwarded to the provider.' },
          prompt: { type: 'string', description: 'Optional context/spelling hint forwarded to the provider.' },
          temperature: { type: 'number', minimum: 0, maximum: 1 },
          response_format: {
            type: 'string',
            enum: ['json', 'text', 'verbose_json', 'vtt'],
            default: 'json',
            description:
              "'verbose_json' includes segments when the provider returns them (falls back to the plain json shape otherwise). " +
              "'vtt' is only served by providers that produce it natively (Cloudflare Workers AI whisper). " +
              "'srt' is not supported and returns 400 unsupported_format.",
          },
        },
      },
      ResponseRequest: {
        type: 'object',
        required: ['input'],
        properties: {
          model: { type: 'string', default: 'auto' },
          instructions: { type: 'string', nullable: true, description: 'System-level guidance, sent as a system message.' },
          input: {
            description: 'A string, or an array of Responses input items.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
          },
          stream: { type: 'boolean', default: false },
          max_output_tokens: { type: 'integer', minimum: 1, nullable: true },
          tools: { type: 'array', items: { type: 'object' } },
        },
      },
      ResponseObject: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string', example: 'response' },
          created_at: { type: 'integer' },
          model: { type: 'string' },
          status: { type: 'string', example: 'completed' },
          output: { type: 'array', items: { type: 'object' } },
          output_text: { type: 'string' },
          usage: { type: 'object' },
        },
      },
      AnthropicMessageRequest: {
        type: 'object',
        required: ['messages'],
        properties: {
          model: { type: 'string', description: 'Anthropic model name; mapped to your free pool. Defaults to `auto`.' },
          max_tokens: { type: 'integer', description: 'Anthropic-required; non-positive values fall back to a default.' },
          messages: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                content: {
                  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
                },
              },
            },
          },
          system: {
            description: 'System prompt, as a string or an array of content blocks.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
          },
          temperature: { type: 'number', minimum: 0, maximum: 2 },
          top_p: { type: 'number', minimum: 0, maximum: 1 },
          stream: { type: 'boolean', default: false },
          stop_sequences: { type: 'array', items: { type: 'string' } },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                input_schema: { type: 'object' },
              },
            },
          },
          tool_choice: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['auto', 'any', 'tool', 'none'] },
              name: { type: 'string' },
            },
          },
        },
      },
      AnthropicMessageResponse: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['message'] },
          role: { type: 'string', enum: ['assistant'] },
          model: { type: 'string' },
          content: { type: 'array', items: { type: 'object' } },
          stop_reason: {
            type: 'string',
            nullable: true,
            enum: ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'],
          },
          stop_sequence: { type: 'string', nullable: true },
          usage: {
            type: 'object',
            properties: {
              input_tokens: { type: 'integer' },
              output_tokens: { type: 'integer' },
            },
          },
        },
      },
      CountTokensResponse: {
        type: 'object',
        properties: {
          input_tokens: { type: 'integer' },
        },
      },
      Usage: {
        type: 'object',
        properties: {
          prompt_tokens: { type: 'integer' },
          completion_tokens: { type: 'integer' },
          total_tokens: { type: 'integer' },
        },
      },
      ModelList: {
        type: 'object',
        properties: {
          object: { type: 'string', enum: ['list'] },
          data: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
        },
      },
      Model: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string', enum: ['model'] },
          created: { type: 'integer' },
          owned_by: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              type: { type: 'string' },
              param: { type: 'string', nullable: true },
              code: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openapiSpec;
