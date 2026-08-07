import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SQLite stores timestamps as `YYYY-MM-DD HH:MM:SS` with no timezone marker, so
// passing them straight to `new Date(...)` makes the browser read them as LOCAL
// time when they are actually UTC — shifting every displayed time by the
// viewer's offset. These helpers tag the value as UTC before parsing. (#170)

/** Convert a SQLite UTC datetime string into an ISO-8601 UTC string. */
export function sqliteUtcToIso(value: string): string {
  // Already carries an explicit timezone marker (Z or ±hh:mm)? Leave it alone.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.replace(' ', 'T') + 'Z';
}

/** Format a SQLite UTC datetime string as the viewer's local time-of-day. */
export function formatSqliteUtcToLocalTime(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' },
): string {
  if (!value) return '—';
  const date = new Date(sqliteUtcToIso(value));
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], options);
}
