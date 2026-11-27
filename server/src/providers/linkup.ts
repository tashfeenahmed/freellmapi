import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const LINKUP_BASE_URL = 'https://api.linkup.so/v1';

// Linkup (linkup.so): monthly free credit top-up. Validation reads the credit
// balance, which spends nothing.
export class LinkupProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'linkup';
  readonly name = 'Linkup';
  override get apiBaseUrl(): string { return LINKUP_BASE_URL; }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${LINKUP_BASE_URL}/credits/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }
}
