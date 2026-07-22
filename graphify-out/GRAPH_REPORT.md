# Graph Report - .  (2026-07-13)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2312 nodes · 5641 edges · 124 communities (105 shown, 19 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.68)
- Token cost: 5,473 input · 1,463 output

## Graph Freshness
- Built from commit: `e3fdd3bd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Project Infrastructure and Throttling
- Authentication UI and Keys
- API Key Parsing Utilities
- Server Application and Middleware
- Client Context and Logging
- Main UI Layout Components
- Frontend Core and Navigation
- Model Selection and Weighting
- Encryption and Security Utilities
- Database Schema Migrations
- Error Classification and Handling
- Tool Argument Repair
- Google Gemini Provider Integration
- Server Hosting and Setup
- Model Fusion and Judging
- Migration Templates and Defaults
- Desktop App Build Dependencies
- Proxy Request Schemas
- API Usage and Markdown UI
- Desktop Configuration and Localization
- Message Content Processing
- Provider and Quota UI
- Response Processing and Redaction
- Response Caching System
- Project Build and Test Scripts
- Cohere Provider Integration
- Provider Quota Management
- Database Connection and Initialization
- Network Proxy Configuration
- Analytics Page and Tables
- Routing Simulation and Scoring
- Analytics Data and Routing
- AI Horde Provider Integration
- Common API Type Definitions
- App TypeScript Configuration
- API Server and Rate Limiting
- Proxy and MCP Integration Tests
- Declarative Configuration Management
- Model Grouping and Resolution
- Frontend Development Tooling
- Interactive UI Components
- Fallback Routing and Chain UI
- Migration Runner Logic
- UI Styling and Libraries
- API Mocking and Profiles
- Library TypeScript Configuration
- UI Component Registry Config
- Database CLI Tools
- Node TypeScript Configuration
- Server Backend Dependencies
- Model Context Protocol Implementation
- Error Boundaries and Localization
- Icon Generation and Assets
- Database and Test Tooling
- Model Catalog Export and Quirks
- Model Catalog Synchronization
- Database Backup and Encryption
- Environment Variable Drift Detection
- Model State and Overrides
- Routing Scoring and Bandits
- Toast Notification System
- LLM Sampling Parameter Management
- Tool Call Parsing and Rescue
- Base TypeScript Configuration
- Model and Provider Testing
- Database Migration Testing
- Frontend Package Scripts
- Project Management Scripts
- Request Guardrails and Budgets
- Provider Health Monitoring
- Embeddings API Integration
- Anthropic Model Mapping
- Routing Penalty Inspection
- Anthropic Integration Tests
- Fallback Hardening Tests
- Premium Features and Licensing
- Process Error Handling
- Task Scheduling System
- Anthropic Fallback Tests
- Catalog Settings and Tests
- Application Entry and Config
- Routing Budget and Fallback
- System Wake Detection
- Auth Rotation Tests
- Empty Completion Tests
- Penalty Inspector UI
- Tailwind CSS Framework
- TypeScript Path Aliases
- Package Metadata
- Multi-key Penalty Tests
- Tool Argument Repair Tests
- Model Tool Support Migration
- Migration Runner Tests
- Provider Modalities Migration
- Max Token Routing Tests
- Tool Routing Tests
- Shared Package Metadata
- Desktop Preload Script
- Request Aggregation Migration
- Client Staging Script
- Server Type Definitions
- Base UI Components
- Drag and Drop Utilities
- Font and Typography
- Lucide Icon Library
- React Core Library
- Markdown Rendering
- Data Visualization Charts
- Markdown GFM Support
- Tailwind Animation Utilities
- Server Bundling Logic
- Shell Install Scripts
- Docker Build Workflow
- Analytics Dashboard UI
- Desktop App UI
- Playground UI

## God Nodes (most connected - your core abstractions)
1. `getDb()` - 161 edges
2. `useI18n()` - 84 edges
3. `cn()` - 71 edges
4. `initDb()` - 69 edges
5. `apiFetch()` - 50 edges
6. `express` - 48 edges
7. `createApp()` - 43 edges
8. `getUnifiedApiKey()` - 43 edges
9. `isGatedApiPath()` - 38 edges
10. `up()` - 36 edges

## Surprising Connections (you probably didn't know these)
- `CacheKeyInput` --references--> `ChatMessage`  [EXTRACTED]
  server/src/services/cache.ts → shared/types.ts
- `FusionResult` --references--> `ChatCompletionResponse`  [EXTRACTED]
  server/src/services/fusion.ts → shared/types.ts
- `QuotaObservationView` --inherits--> `ProviderQuotaState`  [EXTRACTED]
  server/src/services/provider-quota.ts → shared/types.ts
- `CI Workflow` --references--> `FreeLLMAPI README`  [INFERRED]
  .github/workflows/ci.yml → README.md
- `seedProfiles()` --indirect_call--> `score()`  [INFERRED]
  server/src/routes/profiles.ts → client/dev/mockApi.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Core Request Routing Flow** — server_src_services_router, server_src_services_ratelimit, server_src_providers_index, server_src_services_health [EXTRACTED 0.95]
- **Deployment and Distribution** — docker_compose, desktop_readme, github_workflows_docker, github_workflows_desktop_release [EXTRACTED 0.90]

## Communities (124 total, 19 thin omitted)

### Community 0 - "Project Infrastructure and Throttling"
Cohesion: 0.06
Nodes (61): Contributing Guide, Desktop App Guide, Docker Compose Configuration, CI Workflow, Desktop Release Workflow, FreeLLMAPI README, Database Migrations Guide, createThrottler() (+53 more)

### Community 1 - "Authentication UI and Keys"
Cohesion: 0.10
Nodes (35): AuthForm(), AuthStatus, AnthropicMap, ClaudeFamily, FAMILY_ORDER, MappableModel, Button(), FieldError() (+27 more)

### Community 2 - "API Key Parsing Utilities"
Cohesion: 0.07
Nodes (44): RFC-1918, AUTH_JSON_PROVIDER_MAP, detectPlatform(), extractPrefix(), looksLikeApiKey(), parseAuthJson(), parseCsv(), ParsedKey (+36 more)

### Community 3 - "Server Application and Middleware"
Cohesion: 0.10
Nodes (33): express, express, createApp(), createSession(), isGatedApiPath(), mintDashboardToken(), req(), request() (+25 more)

### Community 4 - "Client Context and Logging"
Cohesion: 0.08
Nodes (42): ClientContext, clientContextMiddleware(), clientLoggingEnabled(), getClientContext(), resolveClientIp(), storage, hourKey(), incrementSetting() (+34 more)

### Community 5 - "Main UI Layout Components"
Cohesion: 0.07
Nodes (37): getPreferredDarkMode(), LanguageSubMenu(), modelItems, Navbar(), navItems, queryClient, useDarkMode(), openCommandPalette() (+29 more)

### Community 6 - "Frontend Core and Navigation"
Cohesion: 0.09
Nodes (38): apiBaseUrl(), AuthGate(), Command, CommandPalette(), GettingStarted(), readFlag(), writeFlag(), AddKeyDialog() (+30 more)

### Community 7 - "Model Selection and Weighting"
Cohesion: 0.10
Nodes (37): CustomWeightsPopover(), WEIGHT_AXES, ModelComboOption, GroupHeaderCells(), ModelTableHead(), RowContent(), SortableGroupRow(), ModelsTabs() (+29 more)

### Community 8 - "Encryption and Security Utilities"
Cohesion: 0.08
Nodes (29): RFC-5116, decrypt(), encrypt(), getEncryptionKey(), initEncryptionKey(), isDevFallbackAllowed(), isEncryptionKeyInitialized(), keyFilePathFor() (+21 more)

### Community 9 - "Database Schema Migrations"
Cohesion: 0.09
Nodes (41): backfillFallback(), createTables(), ensureApiKeysBaseUrlColumn(), ensureModelsKeyIdColumn(), ensureRequestKeyIdColumn(), ensureRequestRequestedModelColumn(), ensureRequestTtfbColumn(), ensureUnifiedKey() (+33 more)

### Community 10 - "Error Classification and Handling"
Cohesion: 0.11
Nodes (40): isDailyQuotaExhaustedError(), isKeyAuthError(), isModelAccessForbiddenError(), isModelNotFoundError(), isPaymentRequiredError(), isProviderBadRequestError(), isRetryableError(), sanitizeProviderErrorMessage() (+32 more)

### Community 11 - "Tool Argument Repair"
Cohesion: 0.07
Nodes (37): AttemptRecord, ExhaustionBody, setFallbackHeaders(), JsonSchemaish, repairToolArguments(), stripSchemaKeys(), toolSchemaMap(), AnthropicMessageResponse (+29 more)

### Community 12 - "Google Gemini Provider Integration"
Cohesion: 0.10
Nodes (30): canonicalThoughtSigArgs(), extractImageUrl(), extractText(), extractToolCalls(), GEMINI_UNSUPPORTED_SCHEMA_KEYS, GeminiCandidate, GeminiPart, GeminiResponse (+22 more)

### Community 13 - "Server Hosting and Setup"
Cohesion: 0.09
Nodes (27): ensureSessionToken(), listenWithScan(), ServerHandle, StartOptions, startServer(), tryListen(), hashPassword(), verifyPassword() (+19 more)

### Community 14 - "Model Fusion and Judging"
Cohesion: 0.10
Nodes (35): addUsage(), buildJudgeMessages(), CallOutcome, defaultSavedConfig(), diversifyChain(), familyKey(), FusionConfig, fusionConfigSchema (+27 more)

### Community 15 - "Migration Templates and Defaults"
Cohesion: 0.08
Nodes (12): DEFAULT_MIGRATIONS, DefaultMigration, MigrationModule, MigrationRecord, down(), hasColumn(), up(), MODEL_PRICING (+4 more)

### Community 16 - "Desktop App Build Dependencies"
Cohesion: 0.06
Nodes (34): dependencies, better-sqlite3, description, devDependencies, electron, electron-builder, @electron/rebuild, esbuild (+26 more)

### Community 17 - "Proxy Request Schemas"
Cohesion: 0.06
Nodes (26): assistantMessageSchema, chatCompletionSchema, CompletionBody, completionIdFromChat(), contentBlockSchema, contentSchema, developerMessageSchema, EmbeddingsBody (+18 more)

### Community 18 - "API Usage and Markdown UI"
Cohesion: 0.10
Nodes (25): ApiUsageBlock(), CopyButton(), CopyButtonProps, components, Markdown, MarkdownInner(), MarkdownProps, nodeText() (+17 more)

### Community 19 - "Desktop Configuration and Localization"
Cohesion: 0.11
Nodes (23): configPath(), DesktopConfig, loadConfig(), saveConfig(), dt(), NATIVE_LOCALES, NativeLocale, nativeStrings() (+15 more)

### Community 20 - "Message Content Processing"
Cohesion: 0.11
Nodes (28): ContentBlock, contentHasImage(), ContentTextBlock, contentToString(), flattenMessageContent(), messageHasImage(), normalizeOutboundContent(), sanitizeResponse() (+20 more)

### Community 21 - "Provider and Quota UI"
Cohesion: 0.12
Nodes (25): EmptyState(), ProviderList(), StatusFilter, formatQuotaNumber(), formatResetAt(), QuotaSignalsSection(), CUSTOM_GROUP, CUSTOM_MODEL_KIND_LABEL (+17 more)

### Community 22 - "Response Processing and Redaction"
Cohesion: 0.08
Nodes (25): REDACTIONS, enforceJsonContent(), JsonEnforcement, outermostJsonSlice(), parses(), getRequestGroupId(), buildResponseObject(), contentPartSchema (+17 more)

### Community 23 - "Response Caching System"
Cohesion: 0.12
Nodes (28): cacheRouter, cacheActive(), CacheDirective, CachedResponse, CacheEntry, CacheKeyInput, cacheMaxEntries(), cacheMaxTemperature() (+20 more)

### Community 24 - "Project Build and Test Scripts"
Cohesion: 0.06
Nodes (30): concurrently, dependencies, vitest, devDependencies, concurrently, engines, node, npm (+22 more)

### Community 25 - "Cohere Provider Integration"
Cohesion: 0.20
Nodes (11): extendedBodyParams(), CompletionOptions, ProviderHttpError, COHERE_UNSUPPORTED_SCHEMA_KEYS, CohereProvider, sanitizeCohereTools(), normalizeChoices(), OpenAICompatProvider (+3 more)

### Community 26 - "Provider Quota Management"
Cohesion: 0.11
Nodes (28): parseRetryAfterMs(), contextStore, DEFAULT_CONFIDENCE, extractContext(), getQuotaObservationContext(), getQuotaStateForKeys(), HEADER_SPECS, HeaderSpec (+20 more)

### Community 27 - "Database Connection and Initialization"
Cohesion: 0.09
Nodes (15): Keys Management UI, connectDb(), DB_PATH, __dirname, getDefaultDbPath(), initDb(), regenerateUnifiedKey(), call() (+7 more)

### Community 28 - "Network Proxy Configuration"
Cohesion: 0.13
Nodes (25): abortError(), applyProxyBypass(), applyProxyEnabled(), applyProxyUrl(), _bypassPlatforms, Ctor, describeAbort(), dispatchFetch() (+17 more)

### Community 29 - "Analytics Page and Tables"
Cohesion: 0.09
Nodes (24): Skeleton(), Table(), TableBody(), TableCaption(), TableCell(), TableFooter(), TableHead(), TableHeader() (+16 more)

### Community 30 - "Routing Simulation and Scoring"
Cohesion: 0.15
Nodes (26): routingInfo(), distribution(), main(), pct(), printDistribution(), printScores(), Profile, PROFILES (+18 more)

### Community 31 - "Analytics Data and Routing"
Cohesion: 0.12
Nodes (19): getDb(), analyticsRouter, getSinceTimestamp(), readAggregateSince(), readLifetimeSettings(), toSqliteDateTime(), tier(), tiersForFamily() (+11 more)

### Community 32 - "AI Horde Provider Integration"
Cohesion: 0.17
Nodes (8): AIHordeProvider, estimateTokens(), BaseProvider, CloudflareProvider, providers, ChatCompletionChunk, ChatCompletionResponse, Platform

### Community 33 - "Common API Type Definitions"
Cohesion: 0.08
Nodes (25): ImportRow, ConvertedRequest, AnalyticsSummary, ApiKeyCreate, ChatCompletionRequest, ChatContent, ChatContentBlock, ChatToolCallFunction (+17 more)

### Community 34 - "App TypeScript Configuration"
Cohesion: 0.08
Nodes (25): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+17 more)

### Community 35 - "API Server and Rate Limiting"
Cohesion: 0.10
Nodes (12): DEFAULT_DASHBOARD_ORIGINS, __dirname, openapiSpec, errorHandler(), createProxyRateLimiter(), parseLimit(), WindowState, docsRouter (+4 more)

### Community 36 - "Proxy and MCP Integration Tests"
Cohesion: 0.09
Nodes (14): getUnifiedApiKey(), authHeaders(), rpc(), authHeaders(), authHeaders(), request(), seedGroqKey(), addKey() (+6 more)

### Community 37 - "Declarative Configuration Management"
Cohesion: 0.13
Nodes (23): applyDeclarativeConfig(), applyDeclarativeConfigFromEnv(), applyFallback(), customProviderSchema, DeclarativeConfig, DeclarativeConfigResult, declarativeConfigSchema, encryptedKey() (+15 more)

### Community 38 - "Model Grouping and Resolution"
Cohesion: 0.15
Nodes (23): assignCanonicalIds(), EMPTY_OVERRIDES, getModelGroups(), getUnifyOverrides(), GroupableRow, groupRows(), isUnifyEnabled(), memberId() (+15 more)

### Community 39 - "Frontend Development Tooling"
Cohesion: 0.08
Nodes (25): devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, @types/node, @types/react (+17 more)

### Community 40 - "Interactive UI Components"
Cohesion: 0.11
Nodes (18): ButtonSize, ButtonVariant, ConfirmButton(), FloatingBar(), groupMedia(), MediaData, MediaGroup, MediaModelsView() (+10 more)

### Community 41 - "Fallback Routing and Chain UI"
Cohesion: 0.11
Nodes (22): Fallback Chain UI, ChainRow, formatResetEta(), getActiveChain(), getChainByGlobalSort(), getChainByProfileName(), getModelChainRow(), GLOBAL_SORT_ALIASES (+14 more)

### Community 42 - "Migration Runner Logic"
Cohesion: 0.15
Nodes (24): AppliedMigrationRow, DEFAULT_MIGRATIONS_DIR, __dirname, ensureMigrationsTable(), getAppliedMigrations(), getDefaultMigrationRecords(), getMigrationFileExtension(), getMigrationFilenames() (+16 more)

### Community 43 - "UI Styling and Libraries"
Cohesion: 0.09
Nodes (23): class-variance-authority, dependencies, class-variance-authority, clsx, @dnd-kit/core, @dnd-kit/utilities, @fontsource-variable/geist, react-dom (+15 more)

### Community 44 - "API Mocking and Profiles"
Cohesion: 0.09
Nodes (16): activeWeights(), customWeights, MockModel, models, PRESETS, score(), createSchema, getBudgetScore() (+8 more)

### Community 45 - "Library TypeScript Configuration"
Cohesion: 0.09
Nodes (22): dist, ES2022, node_modules, src/__tests__, compilerOptions, declaration, declarationMap, esModuleInterop (+14 more)

### Community 46 - "UI Component Registry Config"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 47 - "Database CLI Tools"
Cohesion: 0.16
Nodes (20): Command, createMigrationFile(), DEFAULTS_PATH, __dirname, dropAllUserTables(), formatDate(), formatTimestamp(), getMigrationName() (+12 more)

### Community 48 - "Node TypeScript Configuration"
Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+12 more)

### Community 49 - "Server Backend Dependencies"
Cohesion: 0.10
Nodes (21): cors, dotenv, drizzle-orm, @freellmapi/shared, helmet, multer, dependencies, better-sqlite3 (+13 more)

### Community 50 - "Model Context Protocol Implementation"
Cohesion: 0.14
Nodes (20): authenticate(), sendError(), authenticate(), handleRpc(), JsonRpcRequest, mcpRouter, McpTool, providerHealth() (+12 more)

### Community 51 - "Error Boundaries and Localization"
Cohesion: 0.14
Nodes (14): CrashScreen(), ErrorBoundary, ErrorBoundaryState, detectLocale(), dictionaries, Dictionary, I18nContext, I18nContextValue (+6 more)

### Community 52 - "Icon Generation and Assets"
Cohesion: 0.14
Nodes (17): appShapes, assets, BG, BLACK, chunk(), circle(), crc32(), CRC_TABLE (+9 more)

### Community 53 - "Database and Test Tooling"
Cohesion: 0.11
Nodes (19): drizzle-kit, devDependencies, drizzle-kit, tsx, @types/better-sqlite3, @types/cors, @types/express, @types/multer (+11 more)

### Community 54 - "Model Catalog Export and Quirks"
Cohesion: 0.18
Nodes (16): getAllProviders(), arg(), dateVersion(), __dirname, flag(), main(), ModelRow, SUITE_ROOT (+8 more)

### Community 55 - "Model Catalog Synchronization"
Cohesion: 0.18
Nodes (17): hasProvider(), applyCatalog(), Catalog, CatalogModel, CatalogQuirk, CatalogSyncState, isCatalog(), LicenseStatus (+9 more)

### Community 56 - "Database Backup and Encryption"
Cohesion: 0.24
Nodes (14): backupDbNow(), backupIntervalMs(), backupTarget(), DbBackupResult, decryptBackup(), encryptBackup(), isDbBackupConfigured(), isHttpTarget() (+6 more)

### Community 57 - "Environment Variable Drift Detection"
Cohesion: 0.22
Nodes (15): checkEnvDrift(), compactList(), compareEnvText(), defaultEnvDriftPaths(), __dirname, EnvDriftPaths, EnvDriftReport, formatEnvDriftReport() (+7 more)

### Community 58 - "Model State and Overrides"
Cohesion: 0.15
Nodes (14): fetchModelRow(), MODEL_FIELD_COLUMNS, ModelRow, modelsRouter, modelUpdateSchema, CatalogModelKind, cleanPatch(), getModelOverrides() (+6 more)

### Community 59 - "Routing Scoring and Bandits"
Cohesion: 0.26
Nodes (15): scoreChainEntry(), BANDIT_PRESETS, combineScore(), expectedReliability(), headroomFactor(), intelligenceScore(), randomNormal(), reliabilityPosterior() (+7 more)

### Community 60 - "Toast Notification System"
Cohesion: 0.20
Nodes (14): ICON_CLASS, ICONS, Toast(), Toaster(), dismissToast(), emit(), getToasts(), items (+6 more)

### Community 61 - "LLM Sampling Parameter Management"
Cohesion: 0.17
Nodes (14): ANY_OBJECT_SCHEMA, EXTENDED_SAMPLING_KEYS, ExtendedSamplingKey, ExtendedSamplingOptions, ParsedSamplingBody, pickSamplingParams(), PLATFORM_PARAM_POLICIES, platformDropsResponseFormat() (+6 more)

### Community 62 - "Tool Call Parsing and Rescue"
Cohesion: 0.27
Nodes (14): callFromNamedJson(), containsDialectMarker(), couldBecomeDialectMarker(), DIALECT_MARKERS, extractBalancedJson(), isKnownTool(), parseFunctionTagDialect(), parseTokenDialect() (+6 more)

### Community 63 - "Base TypeScript Configuration"
Cohesion: 0.13
Nodes (14): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noEmit, skipLibCheck, strict (+6 more)

### Community 64 - "Model and Provider Testing"
Cohesion: 0.15
Nodes (11): getProvider(), db, Key, keyStmt, models, results, Row, del() (+3 more)

### Community 65 - "Database Migration Testing"
Cohesion: 0.22
Nodes (11): DatabaseSnapshot, getAppliedMigrationNames(), getAppTableNames(), getLatestAppliedMigrationName(), getPendingMigrationNames(), quoteIdentifier(), runDownToBaseline(), SchemaRow (+3 more)

### Community 66 - "Frontend Package Scripts"
Cohesion: 0.15
Nodes (12): engines, node, npm, name, private, scripts, build, dev (+4 more)

### Community 67 - "Project Management Scripts"
Cohesion: 0.15
Nodes (13): scripts, build, db:migration:create, db:migration:down, db:migration:fresh, db:migration:status, db:migration:up, dev (+5 more)

### Community 68 - "Request Guardrails and Budgets"
Cohesion: 0.27
Nodes (11): applyTokenBudget(), BreakerState, getMaxConsecutiveUpstreamFails(), getRequestMaxTokensBudget(), newBreaker(), readGuardrailValue(), recordBreakerFailure(), tokenBudgetMessage() (+3 more)

### Community 69 - "Provider Health Monitoring"
Cohesion: 0.24
Nodes (9): healthRouter, quotaContextForRoute(), checkAllKeys(), checkKeyHealth(), failureCount, startHealthChecker(), stopHealthChecker(), inferQuotaPoolKey() (+1 more)

### Community 70 - "Embeddings API Integration"
Cohesion: 0.26
Nodes (12): callProvider(), EmbeddingsResult, estimateTokens(), getDefaultFamily(), listEmbeddingModels(), logEmbeddingRequest(), openAiStyleEmbed(), probeEmbeddingDimensions() (+4 more)

### Community 71 - "Anthropic Model Mapping"
Cohesion: 0.23
Nodes (10): AnthropicModelMap, anthropicModelMapSchema, classifyClaudeFamily(), CLAUDE_FAMILIES, ClaudeFamily, DEFAULT_MAP, getClaudeModelMap(), resolveAnthropicModel() (+2 more)

### Community 72 - "Routing Penalty Inspection"
Cohesion: 0.26
Nodes (11): addReason(), ensureInspectorRow(), getPenaltyInspector(), InspectorReason, InspectorRow, PenaltyInspectorSnapshot, rowKey(), toSqliteDateTime() (+3 more)

### Community 73 - "Anthropic Integration Tests"
Cohesion: 0.17
Nodes (4): anthropicHeaders(), request(), send(), WEATHER_TOOL

### Community 74 - "Fallback Hardening Tests"
Cohesion: 0.17
Nodes (6): chatCompletion, fakeProvider, GOOD_RESULT, NO_USAGE_RESULT, post(), streamChatCompletion

### Community 75 - "Premium Features and Licensing"
Cohesion: 0.40
Nodes (10): getSetting(), maskKey(), premiumRouter, statusPayload(), catalogBaseUrl(), catalogPublicKey(), getCachedLicenseStatus(), getSyncState() (+2 more)

### Community 76 - "Process Error Handling"
Cohesion: 0.38
Nodes (9): classifyProcessError(), describeError(), handleProcessError(), isTransportError(), ProcessErrorDecision, SafetyNetHooks, TRANSPORT_ERROR_CODES, TRANSPORT_MESSAGE_HINTS (+1 more)

### Community 77 - "Task Scheduling System"
Cohesion: 0.25
Nodes (4): NodeScheduler, Scheduler, startCatalogSync(), stopCatalogSync()

### Community 78 - "Anthropic Fallback Tests"
Cohesion: 0.18
Nodes (3): { mockRouteRequest }, post(), WEATHER_TOOL

### Community 79 - "Catalog Settings and Tests"
Cohesion: 0.24
Nodes (8): setSetting(), setUnifyEnabled(), setUnifyOverrides(), recordCatalogModelTombstone(), AnyCatalog, baseModel(), cacheCatalog(), existingAsCatalogModels()

### Community 80 - "Application Entry and Config"
Cohesion: 0.33
Nodes (7): main(), Config, loadConfig(), parseRateLimitRpm(), installProcessSafetyNet(), flushProxyCache(), ENV_KEYS

### Community 81 - "Routing Budget and Fallback"
Cohesion: 0.24
Nodes (6): parseBudget(), fallbackRouter, routingSchema, SORT_PRESETS, updateSchema, RoutingStrategy

### Community 82 - "System Wake Detection"
Cohesion: 0.38
Nodes (8): handleSignal(), invokeHooks(), _resetForTests(), startWakeDetect(), stopWakeDetect(), tick(), WakeEvent, WakeHooks

### Community 83 - "Auth Rotation Tests"
Cohesion: 0.20
Nodes (7): chatCompletion, fakeProvider, GOOD_RESULT, { mockCheckKeyHealth }, post(), Setup, streamChatCompletion

### Community 84 - "Empty Completion Tests"
Cohesion: 0.20
Nodes (6): chatCompletion, EMPTY_RESULT, fakeProvider, GOOD_RESULT, post(), streamChatCompletion

### Community 85 - "Penalty Inspector UI"
Cohesion: 0.33
Nodes (8): formatDuration(), formatTime(), InspectorReason, penaltyClass(), PenaltyInspector(), PenaltyInspectorData, PenaltyInspectorRow, readCollapsed()

### Community 87 - "TypeScript Path Aliases"
Cohesion: 0.25
Nodes (7): compilerOptions, baseUrl, paths, files, ./src/*, @/*, references

### Community 88 - "Package Metadata"
Cohesion: 0.25
Nodes (7): engines, node, npm, name, private, type, version

### Community 89 - "Multi-key Penalty Tests"
Cohesion: 0.25
Nodes (6): chatCompletion, fakeProvider, GOOD_RESULT, post(), Setup, streamChatCompletion

### Community 90 - "Tool Argument Repair Tests"
Cohesion: 0.25
Nodes (6): BROKEN_ARGS, chatCompletion, fakeProvider, post(), streamChatCompletion, UPDATE_PLAN_TOOL

### Community 91 - "Model Tool Support Migration"
Cohesion: 0.38
Nodes (3): down(), up(), dbs

### Community 92 - "Migration Runner Tests"
Cohesion: 0.33
Nodes (3): hasColumn(), quoteIdentifier(), tempDirs

### Community 93 - "Provider Modalities Migration"
Cohesion: 0.60
Nodes (5): addKeyIdColumn(), down(), dropKeyIdColumn(), hasColumn(), up()

### Community 94 - "Max Token Routing Tests"
Cohesion: 0.33
Nodes (5): chatCompletion, fakeProvider, GOOD_RESULT, post(), streamChatCompletion

### Community 95 - "Tool Routing Tests"
Cohesion: 0.33
Nodes (5): BUILTIN_TOOL_RESPONSES, post(), TOOLS_CHAT, TOOLS_RESPONSES, WEATHER_TOOL

### Community 96 - "Shared Package Metadata"
Cohesion: 0.33
Nodes (5): main, name, private, types, version

### Community 99 - "Client Staging Script"
Cohesion: 0.50
Nodes (3): dest, __dirname, src

## Knowledge Gaps
- **654 isolated node(s):** `$schema`, `style`, `rsc`, `tsx`, `config` (+649 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `express` connect `Server Application and Middleware` to `Model and Provider Testing`, `API Server and Rate Limiting`, `Proxy and MCP Integration Tests`, `Anthropic Integration Tests`, `Fallback Hardening Tests`, `Server Hosting and Setup`, `Anthropic Fallback Tests`, `Server Backend Dependencies`, `Auth Rotation Tests`, `Empty Completion Tests`, `Multi-key Penalty Tests`, `Tool Argument Repair Tests`, `Database Connection and Initialization`, `Max Token Routing Tests`, `Tool Routing Tests`?**
  _High betweenness centrality (0.109) - this node is a cross-community bridge._
- **Why does `getDb()` connect `Analytics Data and Routing` to `Project Infrastructure and Throttling`, `API Key Parsing Utilities`, `Server Application and Middleware`, `Client Context and Logging`, `Encryption and Security Utilities`, `Error Classification and Handling`, `Server Hosting and Setup`, `Model Fusion and Judging`, `Proxy Request Schemas`, `Response Processing and Redaction`, `Provider Quota Management`, `Database Connection and Initialization`, `Routing Simulation and Scoring`, `API Server and Rate Limiting`, `Proxy and MCP Integration Tests`, `Declarative Configuration Management`, `Model Grouping and Resolution`, `Fallback Routing and Chain UI`, `API Mocking and Profiles`, `Model Context Protocol Implementation`, `Model Catalog Export and Quirks`, `Model Catalog Synchronization`, `Model State and Overrides`, `Model and Provider Testing`, `Provider Health Monitoring`, `Embeddings API Integration`, `Anthropic Model Mapping`, `Routing Penalty Inspection`, `Anthropic Integration Tests`, `Premium Features and Licensing`, `Anthropic Fallback Tests`, `Catalog Settings and Tests`, `Application Entry and Config`, `Routing Budget and Fallback`, `Tool Routing Tests`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Why does `useI18n()` connect `Frontend Core and Navigation` to `Authentication UI and Keys`, `Main UI Layout Components`, `Model Selection and Weighting`, `Interactive UI Components`, `API Usage and Markdown UI`, `Error Boundaries and Localization`, `Provider and Quota UI`, `Penalty Inspector UI`, `Toast Notification System`, `Analytics Page and Tables`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **What connects `$schema`, `style`, `rsc` to the rest of the system?**
  _654 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Project Infrastructure and Throttling` be split into smaller, more focused modules?**
  _Cohesion score 0.0601404741000878 - nodes in this community are weakly interconnected._
- **Should `Authentication UI and Keys` be split into smaller, more focused modules?**
  _Cohesion score 0.1033182503770739 - nodes in this community are weakly interconnected._
- **Should `API Key Parsing Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.07088989441930618 - nodes in this community are weakly interconnected._