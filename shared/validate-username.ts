import { z } from 'zod';

const LOOSE_NAME = /^[a-zA-Z0-9_.-]+$/;

/**
 * User identifier: either a classic username (3–32, alnum/._-) or a valid email (≤254, RFC per zod `email()`).
 */
export function validateUsername(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) {
    return 'Enter a username or email.';
  }
  if (t.includes('@')) {
    if (t.length > 254) {
      return 'Email is too long (max 254 characters).';
    }
    if (!z.string().email().safeParse(t).success) {
      return 'Invalid email address.';
    }
    return null;
  }
  if (t.length < 3 || t.length > 32) {
    return 'Username must be between 3 and 32 characters.';
  }
  if (!LOOSE_NAME.test(t)) {
    return 'Username may only contain letters, numbers, and _ . -';
  }
  return null;
}

/** Use after `validateUsername` passes: persist and look up with this so spaces around emails don’t break login. */
export function normalizeUserIdentifier(value: string): string {
  return value.trim();
}
