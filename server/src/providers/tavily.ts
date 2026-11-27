import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const TAVILY_BASE_URL = 'https://api.tavily.com';

// Tavily (tavily.com): 1,000 free credits a month. Validation reads GET /usage,
// which costs no credits (a search probe would spend one per check).
export class TavilyProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'tavily';
  readonly name = 'Tavily';
  override get apiBaseUrl(): string { return TAVILY_BASE_URL; }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${TAVILY_BASE_URL}/usage`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }
}
