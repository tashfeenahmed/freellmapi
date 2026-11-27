import { describe, it, expect } from 'vitest';
import { messageHasImage } from '../../lib/content.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

describe('messageHasImage vs old hasImages (#32)', () => {
  it('messageHasImage detects both image_url and image types', () => {
    const messagesWithImageUrl: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }];

    const messagesWithImageType: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    }];

    // messageHasImage catches both image_url and image types
    expect(messageHasImage(messagesWithImageUrl)).toBe(true);
    expect(messageHasImage(messagesWithImageType)).toBe(true);
  });

  it('messageHasImage is false for text-only messages', () => {
    expect(messageHasImage([{ role: 'user', content: 'hello' }])).toBe(false);
    expect(messageHasImage([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])).toBe(false);
    expect(messageHasImage([{ role: 'assistant', content: null }])).toBe(false);
  });
});