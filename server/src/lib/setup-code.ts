import crypto from 'crypto';

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

// Uppercase letters + digits, minus the visually ambiguous I, O, 0 and 1, so
// the code is easy to read from a log and type by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

let currentCode: string | null = null;

function generate(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

// Mint a fresh code and log it prominently. Call once at boot when there are
// zero accounts. Returns the code (handy for tests).
export function generateSetupCode(): string {
  currentCode = generate();
  console.log('');
  console.log('  First-run setup code: ' + currentCode);
  console.log('  A browser on this machine can finish setup without it. From any');
  console.log('  other device, enter this code to create the first account.');
  console.log('');
  return currentCode;
}

export function getSetupCode(): string | null {
  return currentCode;
}

export function clearSetupCode(): void {
  currentCode = null;
}

// Constant-time comparison against the active code. Returns false when no code
// is active or the input is not a matching string.
export function setupCodeMatches(provided: unknown): boolean {
  if (!currentCode || typeof provided !== 'string') return false;
  const a = Buffer.from(currentCode);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
