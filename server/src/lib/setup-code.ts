import { createOneTimeCode } from './one-time-code.js';

// One-time first-run setup code.
//
// POST /api/auth/setup creates the first admin account while there are zero
// users. The server binds all interfaces by default, so an exposed fresh
// install could be claimed by whoever reaches it first. To gate that without
// hurting the local/desktop first-run experience, we mint a random code at boot
// when the dashboard is unclaimed and log it. A browser on the same machine
// (a loopback socket) never needs the code; a request from any other address
// must present it. The code is regenerated once per boot and cleared as soon as
// an account exists.

const _code = createOneTimeCode();

// Mint a fresh code and log it prominently. Call once at boot when there are
// zero accounts. Returns the code (handy for tests).
export function generateSetupCode(): string {
  const code = _code.generate();
  console.log('');
  console.log('  First-run setup code: ' + code);
  console.log('  A browser on this machine can finish setup without it. From any');
  console.log('  other device, enter this code to create the first account.');
  console.log('');
  return code;
}

export function getSetupCode(): string | null {
  return _code.get();
}

export function clearSetupCode(): void {
  _code.clear();
}

// Constant-time comparison against the active code. Returns false when no code
// is active or the input is not a matching string.
export function setupCodeMatches(provided: unknown): boolean {
  return _code.matches(provided);
}
