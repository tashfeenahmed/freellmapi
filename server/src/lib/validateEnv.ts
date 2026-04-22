const MIN_SESSION_PASSWORD_LEN = 32;

/**
 * Exits the process with a message if `SESSION_PASSWORD` is missing or too short.
 * Must run before the HTTP server and DB access that assumes a valid app config.
 */
export function validateSessionPasswordOrExit(): void {
  const pw = process.env.SESSION_PASSWORD;
  if (!pw || pw.length < MIN_SESSION_PASSWORD_LEN) {
    console.error(
      '[FATAL] SESSION_PASSWORD is missing or too short. Set it to a secret of at least 32 characters, e.g.:\n' +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }
}
