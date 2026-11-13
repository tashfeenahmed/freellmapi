import { createOneTimeCode } from './one-time-code.js';

// One-time password-reset code.
//
// POST /api/auth/forgot-password mints a reset code and logs it. The operator
// reads the code from the server logs and enters it on the reset form to set a
// new password without an active session. Requesting a code while one is live
// prints the same code again, and only an expired code is replaced: the route
// is unauthenticated, so replacing it on every request let anyone void the
// code the operator was typing. The code is cleared after a successful reset.

const _code = createOneTimeCode();
const RESET_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let mintedAtMs = 0;

// Log the live reset code (minting one if none is live) prominently, with the
// account email: the operator who forgot the password may have forgotten which
// email signs in too (#1477), and whoever can read this log can already reset
// the account. Returns the code.
export function generateResetCode(accountEmail?: string | null): string {
  let code = _code.get();
  if (!code || Date.now() - mintedAtMs > RESET_CODE_TTL_MS) {
    code = _code.generate();
    mintedAtMs = Date.now();
  }
  console.log('');
  console.log('  Password-reset code: ' + code);
  if (accountEmail) console.log('  Account email: ' + accountEmail);
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
