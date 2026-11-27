import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { imagePlacement, noVisionModelMessage } from '../../lib/vision-gate.js';

const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

describe('imagePlacement (#2061)', () => {
  it('finds an image that only sits in earlier history', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, img] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and now?' },
    ] as ChatMessage[];
    expect(imagePlacement(messages)).toEqual({ images: 1, inHistory: true, inLatest: false });
  });

  it('finds an image in the latest user turn and counts every block', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [img, { type: 'image', source: {} }] },
    ] as unknown as ChatMessage[];
    expect(imagePlacement(messages)).toEqual({ images: 2, inHistory: false, inLatest: true });
  });

  it('reports no images for a text-only conversation', () => {
    expect(imagePlacement([{ role: 'user', content: 'hi' }] as ChatMessage[]))
      .toEqual({ images: 0, inHistory: false, inLatest: false });
  });
});

describe('noVisionModelMessage', () => {
  it('says the image is in history and that no vision model is enabled', () => {
    const m = noVisionModelMessage(0, { images: 1, inHistory: true, inLatest: false });
    expect(m).toMatch(/earlier turn of the conversation history/);
    expect(m).toMatch(/no vision-capable model is enabled/);
  });

  it('says enabled vision models lack a key when some are enabled', () => {
    expect(noVisionModelMessage(3)).toMatch(/none of the 3 enabled vision-capable models has a usable API key/);
  });
});
