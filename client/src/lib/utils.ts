import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function sqliteUtcToIso(value: string | null | undefined): string | null | undefined {
  if (!value) return value;

  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

// Converts SQLite UTC datetime text to the client's local time
export function formatSqliteUtcToLocalTime(
  value: string | null | undefined,
): string {
  const dateString = sqliteUtcToIso(value);

  if (!dateString) return '';

  const date = new Date(dateString);

  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
}
