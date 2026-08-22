export interface CatalogModel {
  id: string;
  name?: string;
  context_window?: number | null;
  context_length?: number | null;
  available?: boolean;
}

export interface GeneratedFile {
  path: string;
  format: 'json' | 'toml' | 'yaml' | 'env';
  value?: Record<string, unknown>;
  content?: string;
  sensitive?: boolean;
}

export interface GenerateContext {
  url: string;
  apiKey: string;
  profile: string;
  models: CatalogModel[];
  homeDir: string;
  /** An explicit `--model`. Overrides each generator's default-model
   *  heuristic; validated against the unfiltered catalog by the caller. */
  requestedModelId?: string;
}

export interface Generation {
  files: GeneratedFile[];
  notes: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  // Plain-language one-liner shown on the Agents page card so a new user can
  // tell the tools apart without having heard of them. Locale-independent by
  // design, like the copied setup snippets.
  description: string;
  category: 'code' | 'agent';
  configType: 'env' | 'file' | 'guide';
  protocol: string;
  baseUrlSupport: 'root' | '/v1';
  command: string;
  docsUrl: string;
  generate(ctx: GenerateContext): Generation;
}
