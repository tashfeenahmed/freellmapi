export { validateUsername, normalizeUserIdentifier } from '@freellmapi/shared/validate-username.js';

/** Mirrors server `passwords` policy for first-run UX. */
export function validatePasswordPolicy(pwd: string): string | null {
  if (pwd.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

export function passwordStrength(pwd: string) {
  return {
    length: pwd.length >= 10,
    letter: /[a-zA-Z]/.test(pwd),
    number: /\d/.test(pwd),
  };
}
