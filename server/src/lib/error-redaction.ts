const MAX_PROVIDER_ERROR_LENGTH = 240;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  // Quote-tolerant so JSON bodies like {"api_key": "..."} are caught too.
  [/(["']?)\b(api[_-]?key|access[_-]?token|token|secret|authorization)\b\1(\s*[:=]\s*)(["']?)[^"',\s}\]]+/gi, '$1$2$1$3$4[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bgsk_[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bfreellmapi-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]'],
  // Bare high-entropy tokens with no known prefix: any unbroken alphanumeric
  // run of 32+ chars is overwhelmingly a credential, never prose.
  [/\b[A-Za-z0-9]{32,}\b/g, '[redacted-token]'],
  [/\bhttps?:\/\/[^\s"'<>)]*/gi, '[redacted-url]'],
];

export function sanitizeProviderErrorMessage(message: unknown): string {
  let sanitized = typeof message === 'string' ? message : String(message ?? '');
  sanitized = sanitized.trim();

  if (!sanitized) return 'Provider error';

  for (const [pattern, replacement] of REDACTIONS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  if (sanitized.length > MAX_PROVIDER_ERROR_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_PROVIDER_ERROR_LENGTH - 3).trimEnd()}...`;
  }

  return sanitized;
}
