import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const EXA_BASE_URL = 'https://api.exa.ai';

// Exa (exa.ai): recurring monthly free credits. Exa has no free "who am I"
// endpoint, so a real search probe would spend credits. Instead the probe
// sends a search with no query: Exa authenticates first, so a bad key answers
// 401 while a good one fails body validation with a 400 and spends nothing.
// Empty searches every few minutes look like abuse (#1599), so the health pass
// sends this once per key, not on its schedule.
export class ExaProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'exa';
  readonly name = 'Exa';

  /** #1599: validation is an empty search, so the health pass checks a key
   * once instead of every few minutes. */
  override get supportsKeyPolling(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${EXA_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({}),
    });
  }
}
