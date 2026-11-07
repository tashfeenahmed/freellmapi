import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';
import { isAnonymousCredential } from '../lib/credential.js';

export const KEENABLE_BASE_URL = 'https://api.keenable.ai/v1';
/** Keenable identifies keyless callers by app name and refuses a keyless call
 *  without it (400). */
export const KEENABLE_APP_TITLE = 'freellmapi';

// Keenable (keenable.ai): keyless web search. POST /v1/search/public answers
// with no account (10 requests/second and 1,000/hour per IP), so the Keys page
// stores the `no-key` sentinel and search runs there. A real API key switches
// to POST /v1/search, which drops the hourly cap.
//
// Validation runs no search either way: both probes send an empty body, which
// the API answers 400 (no query). Authentication runs first, so a bad key gets
// 401 instead. A keyless probe still counts as one request toward the hourly
// limit, about 12 an hour at the health checker's pace.
export class KeenableProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'keenable';
  readonly name = 'Keenable';
  keyless = true;

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const anonymous = isAnonymousCredential(apiKey);
    return this.probe(`${KEENABLE_BASE_URL}/search${anonymous ? '/public' : ''}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Keenable-Title': KEENABLE_APP_TITLE,
        ...(anonymous ? {} : { 'X-API-Key': apiKey.trim() }),
      },
      body: '{}',
    });
  }
}
