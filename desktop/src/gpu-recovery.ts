// Windows GPU-process recovery (#1759).
//
// On some Windows 11 machines every Electron app dies at launch with
//   GPU process exited unexpectedly: exit_code=-2147483645
//   GPU process isn't usable. Goodbye.
// The GPU process runs in Chromium's LPAC sandbox, and LPAC can only read the
// app folder when its ACL grants ALL RESTRICTED APPLICATION PACKAGES
// (S-1-15-2-2). When the folder (or a parent it inherits from) carries an
// orphaned S-1-15-... SID, that read fails, ICU data cannot load, and the GPU
// process hits a CHECK (STATUS_BREAKPOINT, 0x80000003) over and over until
// Chromium gives up. Upstream: electron/electron#51761. The portable zip works
// for the reporter because it was unpacked into a folder with a clean ACL.
//
// The NSIS installer grants S-1-15-2-2 on the install folder (installer.nsh),
// which is the real fix. This module is the safety net for copies that the
// installer did not touch (portable zip, older installs, a parent folder whose
// ACL changes later): when the GPU process dies, persist a recovery step and
// relaunch.
//
//   1. 'repair'      relaunch with --disable-gpu-sandbox so the app works now,
//                    and grant S-1-15-2-2 on the app folder in the background.
//   2. 'repaired'    the grant succeeded: next launch runs fully sandboxed.
//   3. 'no-sandbox'  the sandbox crashed again after a repair: keep
//                    --disable-gpu-sandbox for the rest of this version.
//   4. 'no-gpu'      the GPU process crashed even without its sandbox (a bad
//                    driver): disable hardware acceleration for this version.
//
// The state is keyed to the app version, so every update starts clean on the
// default, fully sandboxed path.
//
// Kept free of electron imports so the state machine is unit-tested on any OS.

export type GpuRecoveryStep = 'repair' | 'repaired' | 'no-sandbox' | 'no-gpu';

export interface GpuRecoveryState {
  version: string;
  step: GpuRecoveryStep;
}

/** STATUS_BREAKPOINT as a signed 32-bit exit code: the LPAC/ICU CHECK failure. */
export const GPU_SANDBOX_CRASH_EXIT_CODE = -2147483645;

/** ALL RESTRICTED APPLICATION PACKAGES, the SID LPAC needs on the app folder. */
export const RESTRICTED_APP_PACKAGES_SID = 'S-1-15-2-2';

export interface ChildProcessGone {
  type: string;
  reason: string;
  exitCode: number;
}

/** The state that applies to this run, or null when there is none or it is stale. */
export function currentState(
  saved: GpuRecoveryState | undefined,
  version: string,
): GpuRecoveryState | null {
  if (!saved || saved.version !== version) return null;
  return saved;
}

export interface LaunchFlags {
  disableGpuSandbox: boolean;
  disableHardwareAcceleration: boolean;
  /** Grant the ACL in the background this run. */
  repairAcl: boolean;
}

export function launchFlags(platform: string, state: GpuRecoveryState | null): LaunchFlags {
  const none = { disableGpuSandbox: false, disableHardwareAcceleration: false, repairAcl: false };
  if (platform !== 'win32' || !state) return none;
  switch (state.step) {
    case 'repair':
      return { disableGpuSandbox: true, disableHardwareAcceleration: false, repairAcl: true };
    case 'no-sandbox':
      return { disableGpuSandbox: true, disableHardwareAcceleration: false, repairAcl: false };
    case 'no-gpu':
      return { disableGpuSandbox: true, disableHardwareAcceleration: true, repairAcl: false };
    case 'repaired':
      return none;
  }
}

/** Only an abnormal GPU process exit on Windows is ours to handle. */
export function isGpuCrash(platform: string, details: ChildProcessGone): boolean {
  if (platform !== 'win32' || details.type !== 'GPU') return false;
  return details.reason === 'crashed' || details.reason === 'launch-failed' || details.reason === 'abnormal-exit';
}

/**
 * The step to persist after a GPU crash in a run that used `state`, or null
 * when there is nothing left to try (the crash is then left to Chromium).
 */
export function nextStepAfterCrash(state: GpuRecoveryState | null): GpuRecoveryStep | null {
  switch (state?.step) {
    case undefined:
      return 'repair';
    case 'repaired':
      // The grant went through but the sandboxed GPU process still dies.
      return 'no-sandbox';
    case 'repair':
    case 'no-sandbox':
      // Crashed with the sandbox already off: not an ACL problem.
      return 'no-gpu';
    case 'no-gpu':
      return null;
  }
}

/**
 * icacls arguments that grant LPAC read/execute on `dir`, inherited by every
 * file and folder below it. /T applies it to existing children whose
 * inheritance is broken; /C keeps going past a locked file; /Q is quiet.
 */
export function aclGrantArgs(dir: string): string[] {
  return [dir, '/grant', `*${RESTRICTED_APP_PACKAGES_SID}:(OI)(CI)(RX)`, '/T', '/C', '/Q'];
}
