function messageText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

function hasAny(message: string, needles: string[]): boolean {
  const lower = message.toLowerCase();
  return needles.some(n => lower.includes(n.toLowerCase()));
}

export function isRetryableError(err: unknown): boolean {
  const msg = messageText(err);
  if (hasAny(msg, ['429', 'rate limit', 'quota exhausted', 'too many requests', 'insufficient_quota'])) return true;
  if (hasAny(msg, ['503', '500', '502', '504', 'etimedout', 'econnrefused', 'network error'])) return true;
  if (hasAny(msg, ['413', 'payload too large', 'request body too large', 'request entity too large', 'content too large'])) return true;
  if (hasAny(msg, ['404', 'model not found', 'not found', 'no endpoints found'])) return true;
  if (hasAny(msg, ['402', 'payment required', 'insufficient credit', 'insufficient balance'])) return true;
  if (hasAny(msg, ['api error 400', 'failed to call a function'])) return true;
  return false;
}

export function isPaymentRequiredError(err: unknown): boolean {
  const msg = messageText(err);
  return hasAny(msg, ['402', 'payment required', 'insufficient credit', 'insufficient balance', 'insufficient_quota']);
}

export function isModelNotFoundError(err: unknown): boolean {
  const msg = messageText(err);
  return hasAny(msg, ['404', 'model not found', 'not found', 'no endpoints found']);
}

export function isModelAccessForbiddenError(err: unknown): boolean {
  const msg = messageText(err);
  return hasAny(msg, ['403', 'forbidden', 'access forbidden', 'authentication error']);
}

export function isProviderAuthFailoverError(err: unknown): boolean {
  const msg = messageText(err);
  return hasAny(msg, ['401', '403', 'authentication error', 'invalid authentication', 'access forbidden']);
}
