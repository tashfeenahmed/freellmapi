import { createOneTimeCode } from './one-time-code.js';

// One-time password-reset code.
//
// POST /api/auth/forgot-password mints a reset code and logs it. The operator
// reads the code from the server logs and enters it on the reset form to set a
// new password without an active session. Requesting a new code invalidates any
// previous one. The code is cleared after a successful reset.

const _code = createOneTimeCode();
const RESET_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let mintedAtMs = 0;

// Mint a fresh reset code and log it prominently. Returns the code.
export function generateResetCode(): string {
  const code = _code.generate();
  mintedAtMs = Date.now();
  console.log('');
  console.log('  Password-reset code: ' + code);
  console.log('  Enter this code on the reset form to set a new password.');
  console.log('');
  return code;
}

export function getResetCode(): string | null {
  return _code.get();
}

export function clearResetCode(): void {
  _code.clear();
  mintedAtMs = 0;
}

// Constant-time comparison against the active code. Returns false when no code
// is active or the input is not a matching string.
export function resetCodeMatches(provided: unknown): boolean {
  if (!mintedAtMs) return false;
  if (Date.now() - mintedAtMs > RESET_CODE_TTL_MS) {
    clearResetCode();
    return false;
  }
  return _code.matches(provided);
}
