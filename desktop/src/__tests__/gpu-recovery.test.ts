import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GPU_SANDBOX_CRASH_EXIT_CODE,
  aclGrantArgs,
  currentState,
  isGpuCrash,
  launchFlags,
  nextStepAfterCrash,
  type GpuRecoveryState,
} from '../gpu-recovery.js';

// #1759: the Windows GPU process dies in its LPAC sandbox when the app folder
// ACL lacks S-1-15-2-2. The Windows branch never runs on the mac this repo is
// developed on, so the state machine and installer hook are asserted here.

const yaml = createRequire(import.meta.url)('js-yaml');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const at = (step: GpuRecoveryState['step']): GpuRecoveryState => ({ version: '1.0.0', step });
const gone = (over: Partial<{ type: string; reason: string; exitCode: number }> = {}) => ({
  type: 'GPU',
  reason: 'crashed',
  exitCode: GPU_SANDBOX_CRASH_EXIT_CODE,
  ...over,
});

describe('gpu recovery state', () => {
  it('ignores state saved by another version', () => {
    expect(currentState(at('no-gpu'), '1.0.1')).toBeNull();
    expect(currentState(at('no-gpu'), '1.0.0')).toEqual(at('no-gpu'));
    expect(currentState(undefined, '1.0.0')).toBeNull();
  });

  it('escalates repair -> no-gpu, repaired -> no-sandbox -> no-gpu, then stops', () => {
    expect(nextStepAfterCrash(null)).toBe('repair');
    expect(nextStepAfterCrash(at('repair'))).toBe('no-gpu');
    expect(nextStepAfterCrash(at('repaired'))).toBe('no-sandbox');
    expect(nextStepAfterCrash(at('no-sandbox'))).toBe('no-gpu');
    expect(nextStepAfterCrash(at('no-gpu'))).toBeNull();
  });

  it('maps each step to launch switches on Windows only', () => {
    expect(launchFlags('win32', null)).toEqual({ disableGpuSandbox: false, disableHardwareAcceleration: false, repairAcl: false });
    expect(launchFlags('win32', at('repair'))).toEqual({ disableGpuSandbox: true, disableHardwareAcceleration: false, repairAcl: true });
    expect(launchFlags('win32', at('repaired'))).toEqual({ disableGpuSandbox: false, disableHardwareAcceleration: false, repairAcl: false });
    expect(launchFlags('win32', at('no-sandbox'))).toEqual({ disableGpuSandbox: true, disableHardwareAcceleration: false, repairAcl: false });
    expect(launchFlags('win32', at('no-gpu'))).toEqual({ disableGpuSandbox: true, disableHardwareAcceleration: true, repairAcl: false });
    expect(launchFlags('darwin', at('no-gpu')).disableHardwareAcceleration).toBe(false);
  });

  it('only treats abnormal Windows GPU exits as crashes', () => {
    expect(isGpuCrash('win32', gone())).toBe(true);
    expect(isGpuCrash('win32', gone({ reason: 'launch-failed' }))).toBe(true);
    expect(isGpuCrash('win32', gone({ reason: 'clean-exit' }))).toBe(false);
    expect(isGpuCrash('win32', gone({ type: 'Utility' }))).toBe(false);
    expect(isGpuCrash('darwin', gone())).toBe(false);
  });

  it('grants ALL RESTRICTED APPLICATION PACKAGES inheritable read/execute', () => {
    expect(aclGrantArgs('C:\\App')).toEqual(['C:\\App', '/grant', '*S-1-15-2-2:(OI)(CI)(RX)', '/T', '/C', '/Q']);
  });
});

describe('NSIS installer hook', () => {
  it('is wired into electron-builder and grants the same SID on $INSTDIR', () => {
    const cfg = yaml.load(readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8'));
    expect(cfg.nsis.include).toBe('installer/installer.nsh');
    const nsh = readFileSync(join(desktopRoot, cfg.nsis.include), 'utf8');
    expect(nsh).toMatch(/!macro customInstall[\s\S]*icacls\.exe" "\$INSTDIR" \/grant \*S-1-15-2-2:\(OI\)\(CI\)\(RX\)[\s\S]*!macroend/);
  });
});
