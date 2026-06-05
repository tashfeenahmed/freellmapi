export type ProviderAccountForDiscovery = {
  id: string;
  providerSlug: string;
  displayName: string;
  apiKey?: string;
  baseUrl?: string | null;
};

export type DiscoveredModel = {
  provider_slug: string;
  provider_model_id: string;
  display_name?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_streaming?: boolean;
  supports_json?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  raw_metadata_json?: unknown;
};

export type CatalogAdapter = {
  providerSlug: string;
  discoverModels(account: ProviderAccountForDiscovery): Promise<DiscoveredModel[]>;
};
