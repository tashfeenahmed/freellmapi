const LIMIT = 2000; // Discord message character limit

/** Split text into Discord-sized chunks, preferring newline/space boundaries and keeping code fences balanced. */
export function splitMessage(text, limit = LIMIT) {
  const chunks = [];
  let rest = text;
  let openFence = null;

  while (rest.length > 0) {
    const prefix = openFence ? `${openFence}\n` : '';
    const budget = limit - prefix.length - 4; // room for a closing ```
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }
    let cut = rest.lastIndexOf('\n', budget);
    if (cut < budget / 2) cut = rest.lastIndexOf(' ', budget);
    if (cut < budget / 2) cut = budget;

    let piece = prefix + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');

    // Track whether we're inside a ``` block so each chunk renders correctly.
    const fences = piece.match(/^```.*$/gm) || [];
    let inside = null;
    for (const f of fences) inside = inside ? null : f;
    if (inside) piece += '\n```';
    openFence = inside;

    chunks.push(piece);
  }
  return chunks;
}
