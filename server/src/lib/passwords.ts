import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;
const DUMMY_BCRYPT = bcrypt.hashSync('__enrollment_dummy__', BCRYPT_ROUNDS);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Constant-time path when the user does not exist: compare against a static dummy hash. */
export function dummyPasswordHashForTiming(): string {
  return DUMMY_BCRYPT;
}

export function validatePasswordPolicy(pwd: string): string | null {
  if (pwd.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}
