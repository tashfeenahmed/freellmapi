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
      'The same /v1 router also speaks the OpenAI Responses API and the Anthropic Messages API.',
    license: { name: 'MIT', url: 'https://github.com/tashfeenahmed/freellmapi/blob/main/LICENSE' },
  },
  servers: [
    { url: '/v1', description: 'This proxy instance' },
  ],
  security: [
    { bearerAuth: [] },
    { apiKeyAuth: [] },
  ],
  tags: [
    { name: 'Chat', description: 'OpenAI-compatible chat and completion endpoints' },
    { name: 'Media', description: 'Image generation and text-to-speech' },
    { name: 'Responses', description: 'OpenAI Responses API (Codex CLI wire format)' },
    { name: 'Anthropic', description: 'Anthropic Messages API (Claude Code and the Anthropic SDKs)' },
    { name: 'Models', description: 'Model discovery' },
  ],
  paths: {
    '/chat/completions': {
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
    '/completions': {
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
    '/embeddings': {
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
    '/images/generations': {
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
    '/audio/speech': {
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
    '/responses': {
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
    '/messages': {
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
    '/messages/count_tokens': {
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
    '/models': {
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
      SpeechRequest: {
        type: 'object',
        required: ['input'],
        properties: {
          model: { type: 'string', default: 'auto' },
          input: { type: 'string', minLength: 1 },
          voice: { type: 'string' },
          response_format: { type: 'string', example: 'mp3' },
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
