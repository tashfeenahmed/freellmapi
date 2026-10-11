import fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  clientNotes,
  desktopAppPath,
  detectChatGptClient,
} from './detect.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('desktopAppPath', () => {
  it('points at /Applications/ChatGPT.app on macOS only', () => {
    expect(desktopAppPath('darwin')).toBe('/Applications/ChatGPT.app');
    expect(desktopAppPath('linux')).toBeUndefined();
    expect(desktopAppPath('win32')).toBeUndefined();
  });
});

describe('detectChatGptClient', () => {
  it('detects the CLI when a codex binary is on PATH', () => {
    vi.stubEnv('PATH', '/opt/tools/bin');
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const found = detectChatGptClient('linux');
    expect(found).toEqual({ kind: 'cli', cliPath: '/opt/tools/bin/codex' });
  });

  it('ignores PATH directories that merely shadow the binary name', () => {
    vi.stubEnv('PATH', '/opt/shadow');
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => false } as fs.Stats);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(detectChatGptClient('linux')).toBeUndefined();
  });

  it('detects the desktop app alone on macOS', () => {
    vi.stubEnv('PATH', '');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const found = detectChatGptClient('darwin');
    expect(found).toEqual({ kind: 'desktop', desktopPath: '/Applications/ChatGPT.app' });
  });

  it('reports both when the CLI and the desktop app coexist', () => {
    vi.stubEnv('PATH', '/usr/bin');
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const found = detectChatGptClient('darwin');
    expect(found?.kind).toBe('both');
  });

  it('returns undefined when nothing is installed', () => {
    vi.stubEnv('PATH', '');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(detectChatGptClient('darwin')).toBeUndefined();
  });
});

describe('clientNotes', () => {
  it('offers the install command when no client exists', () => {
    const notes = clientNotes(undefined);
    expect(notes.join('\n')).toContain('npm install -g @openai/codex');
  });

  it('explains that the desktop app cannot use a custom gateway', () => {
    const notes = clientNotes({ kind: 'desktop', desktopPath: '/Applications/ChatGPT.app' });
    expect(notes.join('\n')).toContain('does not support custom API gateways');
  });

  it('names the CLI path when it is detected', () => {
    const notes = clientNotes({ kind: 'cli', cliPath: '/usr/local/bin/codex' });
    expect(notes.join('\n')).toContain('/usr/local/bin/codex');
  });
});
