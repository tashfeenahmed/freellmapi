import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2';

// Firecrawl (firecrawl.dev): 1,000 free credits a month. Validation reads the
// team's credit balance, which spends nothing.
export class FirecrawlProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'firecrawl';
  readonly name = 'Firecrawl';
  override get apiBaseUrl(): string { return FIRECRAWL_BASE_URL; }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${FIRECRAWL_BASE_URL}/team/credit-usage`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }
}
