// Electron wiring for the Windows GPU-process recovery in gpu-recovery.ts (#1759).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import { loadConfig, saveConfig } from './config.js';
import {
  GPU_SANDBOX_CRASH_EXIT_CODE,
  aclGrantArgs,
  currentState,
  isGpuCrash,
  launchFlags,
  nextStepAfterCrash,
  type GpuRecoveryStep,
} from './gpu-recovery.js';

// A GPU crash with another exit code may be a one-off that Chromium recovers
// from by itself, so only a burst of them at startup triggers a relaunch.
const STARTUP_WINDOW_MS = 60_000;
const CRASHES_BEFORE_RELAUNCH = 3;

function persistStep(step: GpuRecoveryStep): void {
  saveConfig({ ...loadConfig(), gpuRecovery: { version: app.getVersion(), step } });
}

/** Call once, before app 'ready'. A no-op on macOS and Linux. */
export function installGpuRecovery(): void {
  if (process.platform !== 'win32') return;

  const version = app.getVersion();
  const state = currentState(loadConfig().gpuRecovery, version);
  const flags = launchFlags(process.platform, state);

  if (flags.disableGpuSandbox) {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    console.log(`[gpu] recovery step "${state?.step}": GPU sandbox disabled for this run`);
  }
  if (flags.disableHardwareAcceleration) {
    app.disableHardwareAcceleration();
    console.log('[gpu] recovery step "no-gpu": hardware acceleration disabled for this run');
  }

  if (flags.repairAcl && app.isPackaged) {
    const dir = path.dirname(process.execPath);
    app.whenReady().then(() => {
      execFile('icacls', aclGrantArgs(dir), { windowsHide: true, timeout: 120_000 }, (err, _out, stderr) => {
        if (err) {
          console.warn(`[gpu] could not grant the GPU sandbox read access to ${dir}:`, stderr || err.message);
          persistStep('no-sandbox');
          return;
        }
        console.log(`[gpu] granted the GPU sandbox read access to ${dir}; the next launch runs sandboxed`);
        persistStep('repaired');
      });
    });
  }

  const startedAt = Date.now();
  let crashes = 0;
  let handled = false;
  app.on('child-process-gone', (_event, details) => {
    if (handled || !isGpuCrash(process.platform, details)) return;
    crashes += 1;
    const sandboxCrash = details.exitCode === GPU_SANDBOX_CRASH_EXIT_CODE;
    const burst = Date.now() - startedAt < STARTUP_WINDOW_MS && crashes >= CRASHES_BEFORE_RELAUNCH;
    if (!sandboxCrash && !burst) return;

    const next = nextStepAfterCrash(state);
    console.warn(
      `[gpu] GPU process gone (reason=${details.reason}, exit_code=${details.exitCode}); ` +
        (next ? `relaunching with recovery step "${next}"` : 'no recovery step left'),
    );
    if (!next) return;
    handled = true;
    persistStep(next);
    app.relaunch();
    app.exit(0);
  });
}
