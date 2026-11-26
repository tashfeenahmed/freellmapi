/** Plain-text table: columns padded to their widest cell, `right` columns right-aligned. */
export function formatTable(headers: string[], rows: string[][], right: number[] = []): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));
  const line = (cells: string[]): string => cells
    .map((cell, i) => (right.includes(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
    .join('  ')
    .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** Server-supplied text on one line: control characters dropped, whitespace collapsed, truncated. */
export function oneLine(value: unknown, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '-';
}

export function ms(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '-';
}

export function percent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '-';
}
