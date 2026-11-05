import { SearchOnlyProvider } from './search-only.js';

/** TinyFish is a Search API provider, not a chat-completion endpoint. Search
 * and Fetch have a documented $0 price and do not draw from its wallet. */
export class TinyFishProvider extends SearchOnlyProvider {
  readonly platform = 'tinyfish' as const;
  readonly name = 'TinyFish';

  override get supportsKeyValidation(): boolean { return false; }
  override get supportsKeyPolling(): boolean { return false; }

  async validateKey(): Promise<never> {
    throw new Error('TinyFish key validation sends no search request; the first real search confirms the key');
  }
}
