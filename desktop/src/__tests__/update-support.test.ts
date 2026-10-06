import { describe, expect, it } from 'vitest';
import { updateSupport } from '../update-support.js';

const base = { isPackaged: true, execPath: '/Applications/FreeLLMAPI.app/Contents/MacOS/FreeLLMAPI', productName: 'FreeLLMAPI' };

describe('updateSupport', () => {
  it('leaves a dev build alone unless a test feed is configured', () => {
    expect(updateSupport({ ...base, isPackaged: false, platform: 'darwin' })).toEqual({ phase: 'unsupported', reason: 'dev' });
    expect(updateSupport({ ...base, isPackaged: false, platform: 'darwin', feed: 'http://127.0.0.1:8099/' })).toBeNull();
  });

  it('updates an installed mac app but not one running from the mounted dmg', () => {
    expect(updateSupport({ ...base, platform: 'darwin' })).toBeNull();
    expect(updateSupport({ ...base, platform: 'darwin', execPath: '/Volumes/FreeLLMAPI/FreeLLMAPI.app/Contents/MacOS/FreeLLMAPI' }))
      .toEqual({ phase: 'unsupported', reason: 'package' });
  });

  it('updates the NSIS install on Windows but not the portable zip', () => {
    const execPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe';
    const installed = (file: string) => file.endsWith('Uninstall FreeLLMAPI.exe');
    expect(updateSupport({ ...base, platform: 'win32', execPath }, installed)).toBeNull();
    expect(updateSupport({ ...base, platform: 'win32', execPath }, () => false)).toEqual({ phase: 'unsupported', reason: 'package' });
  });

  it('updates the AppImage on Linux and leaves deb/rpm to the package manager', () => {
    expect(updateSupport({ ...base, platform: 'linux', execPath: '/tmp/.mount_x/freellmapi-desktop', appImage: '/home/me/FreeLLMAPI.AppImage' })).toBeNull();
    expect(updateSupport({ ...base, platform: 'linux', execPath: '/opt/FreeLLMAPI/freellmapi-desktop' })).toEqual({ phase: 'unsupported', reason: 'package' });
  });
});
