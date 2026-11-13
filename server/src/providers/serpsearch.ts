import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const SERPSEARCH_BASE_URL = 'https://api.serpsearch.com/api/v1';

export class SerpSearchProvider extends SearchOnlyProvider {
  readonly platform = 'serpsearch' as const;
  readonly name = 'SerpSearch';

  /** #1599: SerpSearch has no account or usage endpoint, so the only possible
   * key check is a search with no query, and its maintainer asked that we send
   * none at all (empty searches flag accounts as bots). No health pass, cooldown
   * probe or "Check now" validates a SerpSearch key: it stays 'unknown' until a
   * real search succeeds (markKeyHealthyFromRequest), and a 401/403 on a real
   * search benches it like any other search key. */
  override get supportsKeyValidation(): boolean {
    return false;
  }

  override get supportsKeyPolling(): boolean {
    return false;
  }

  async validateKey(): Promise<KeyValidationResult> {
    // Never turn this into a request: an empty search is what got accounts
    // revoked (#1599), and a real search would spend the user's credits.
    throw new Error('SerpSearch keys are not validated with a request; the first real search confirms the key (no request sent)');
  }
}
