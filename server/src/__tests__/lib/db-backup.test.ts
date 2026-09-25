import { describe, expect, it } from 'vitest';
import { parseHuggingFaceTarget } from '../../lib/db-backup.js';

describe('parseHuggingFaceTarget', () => {
  it('maps a dataset download URL onto the commit API', () => {
    expect(parseHuggingFaceTarget('https://huggingface.co/datasets/acme/state/resolve/main/backups/freeapi.db.enc')).toEqual({
      commitUrl: 'https://huggingface.co/api/datasets/acme/state/commit/main',
      filePath: 'backups/freeapi.db.enc',
    });
  });

  it('treats the prefix-less repo path as a model repo', () => {
    expect(parseHuggingFaceTarget('https://huggingface.co/acme/state/resolve/main/freeapi.db.enc')).toEqual({
      commitUrl: 'https://huggingface.co/api/models/acme/state/commit/main',
      filePath: 'freeapi.db.enc',
    });
  });

  it('maps a space download URL', () => {
    expect(parseHuggingFaceTarget('https://huggingface.co/spaces/acme/app/resolve/main/data/freeapi.db.enc')?.commitUrl)
      .toBe('https://huggingface.co/api/spaces/acme/app/commit/main');
  });

  it('leaves every other target alone', () => {
    expect(parseHuggingFaceTarget('https://example.com/acme/state/resolve/main/freeapi.db.enc')).toBeNull();
    expect(parseHuggingFaceTarget('https://huggingface.co/acme/state')).toBeNull();
    expect(parseHuggingFaceTarget('/var/backups/freeapi.db.enc')).toBeNull();
  });
});
