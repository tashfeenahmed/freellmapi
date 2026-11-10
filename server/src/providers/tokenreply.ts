import { OpenAICompatProvider } from './openai-compat.js';

/** Only signed catalog rows for the provider's Free routes are published.
 * The public model roster also contains trial, wallet and paid routes. */
export class TokenReplyProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'tokenreply', name: 'TokenReply', baseUrl: 'https://api.tokenreply.com/v1' });
  }
}
