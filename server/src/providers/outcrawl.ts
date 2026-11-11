import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const OUTCRAWL_BASE_URL = 'https://api.outcrawl.ai/v1';

// Outcrawl (outcrawl.ai): 1,000 free credits a month, no card. The key is a
// bearer token. Validation reads the account's credit balance, which spends
// nothing.
export class OutcrawlProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'outcrawl';
  readonly name = 'Outcrawl';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${OUTCRAWL_BASE_URL}/credits`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }
}
