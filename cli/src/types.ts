import type { DetectedClient } from './detect.js';

export interface CatalogModel {
  id: string;
  name?: string;
  context_window?: number | null;
  context_length?: number | null;
  /** `auto` only: the largest prompt the router can still serve for a
   *  tool-calling request (#2122). Larger than context_window when the pool
   *  holds a few big-window models; sized to only on request. */
  max_context_window?: number | null;
  available?: boolean;
}

/** `--context-window`: a token count, or `max` for the largest window the
 *  gateway says it can serve for the chosen model. */
export type ContextWindowChoice = number | 'max';

export interface GeneratedFile {
  path: string;
  format: 'json' | 'toml' | 'yaml' | 'yaml-entries' | 'env';
  /** Structured patch, deep-merged into the existing document (json, yaml). */
  value?: Record<string, unknown>;
  /** Literal text, merged as a marked `# freellmapi:start/end` block (toml, yaml, env). */
  content?: string;
  sensitive?: boolean;
  /** json only: arrays merged item by item instead of replaced whole, keyed by
   *  the array's dotted path. `ownedBy` drops the existing items whose fields
   *  all match it, then appends the patch's items; `union` keeps the existing
   *  values and appends the patch's missing ones. */
  arrays?: Record<string, JsonArrayMerge>;
}

export type JsonArrayMerge = { ownedBy: Record<string, string> } | { union: true };

export interface GenerateContext {
  url: string;
  apiKey: string;
  profile: string;
  models: CatalogModel[];
  homeDir: string;
  /** An explicit `--model`. Overrides each generator's default-model
   *  heuristic; validated against the unfiltered catalog by the caller. */
  requestedModelId?: string;
  /** An explicit `--context-window` (Claude Code only). Absent: the model's
   *  advertised context_window, the window most of the pool can hold. */
  contextWindow?: ContextWindowChoice;
  /** Result of `detectChatGptClient()`. Injected by the CLI entry point;
   *  when the property is absent generators probe the real machine, which
   *  golden-output tests must avoid (the snapshot must not depend on the
   *  host's installed clients). */
  detectedClient?: DetectedClient;
}

export interface Generation {
  files: GeneratedFile[];
  notes: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  category: 'code' | 'agent';
  configType: 'env' | 'file' | 'guide';
  protocol: string;
  baseUrlSupport: 'root' | '/v1';
  command: string;
  docsUrl: string;
  generate(ctx: GenerateContext): Generation;
}
