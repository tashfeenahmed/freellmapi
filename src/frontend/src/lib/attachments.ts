// Playground file attachments (#325). Two kinds only, on purpose:
//
//   - images (png/jpeg/webp/gif) → downscaled in the browser and sent as an
//     OpenAI `image_url` data-URI content part, which the server already
//     accepts and routes to a vision-capable model (server/src/lib/content.ts).
//   - text-like files (txt/md/csv/tsv/json/log) → inlined into the message text
//     as a fenced block labelled with the filename.
//
// Binary documents (pdf/xlsx/docx) are deliberately NOT handled here: extracting
// their text needs a parser, and that is a separate piece of work.
//
// The caps below exist because every request leaves through a FREE-TIER
// provider: base64 images inflate the prompt ~33%, and free tiers have small
// per-request body limits and tight token budgets. They are intentionally
// conservative — a 1024px edge is enough for a model to read a screenshot.

/** Longest edge, in pixels, an attached image is downscaled to. */
export const MAX_IMAGE_EDGE = 1024
/** Cap for one encoded image data URI (~1.2 MB ≈ 0.9 MB of pixels). */
export const MAX_IMAGE_BYTES = 1_200_000
/** Cap for all images on a single message. */
export const MAX_TOTAL_IMAGE_BYTES = 3_000_000
/** Cap for one text-like file, before inlining it into the prompt. */
export const MAX_TEXT_BYTES = 128_000
/** Attachments allowed on a single message. */
export const MAX_ATTACHMENTS = 5

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log']

/** `accept` for the file input — mirrors what classifyFile() lets through. */
export const ACCEPT_ATTRIBUTE = [...IMAGE_MIME_TYPES, ...TEXT_EXTENSIONS.map(e => `.${e}`)].join(',')

export type AttachmentKind = 'image' | 'text'

export interface Attachment {
  id: string
  kind: AttachmentKind
  name: string
  /** Downscaled data URI — images only. */
  dataUrl?: string
  /** Decoded UTF-8 contents — text-like files only. */
  text?: string
}

/** OpenAI multimodal content parts, exactly as the proxy expects them. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

// Type sniffing is extension-first because browsers report inconsistent MIME
// types for text-like files (empty string for .md, application/vnd.ms-excel for
// .csv on Windows). Anything we don't recognize is rejected loudly rather than
// guessed at.
export function classifyFile(file: { name: string; type?: string }): AttachmentKind | null {
  const type = (file.type ?? '').toLowerCase()
  if (IMAGE_MIME_TYPES.includes(type)) return 'image'
  const ext = fileExtension(file.name)
  if (TEXT_EXTENSIONS.includes(ext)) return 'text'
  if (!type && ext === '') return null
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json') return 'text'
  return null
}

/** Scale (w, h) down so the longest edge is at most `maxEdge`; never scales up. */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

const FENCE_LANGUAGE: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', json: 'json', csv: 'csv', tsv: 'tsv', log: 'text', txt: 'text',
}

export function fenceLanguage(name: string): string {
  return FENCE_LANGUAGE[fileExtension(name)] ?? 'text'
}

// Inlined as a fenced block so the model sees the filename AND a boundary; the
// fence is widened past any run of backticks inside the file so pasted markdown
// can't break out of it.
export function inlineTextAttachment(name: string, text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${name}:\n${fence}${fenceLanguage(name)}\n${text.replace(/\s+$/, '')}\n${fence}`
}

/**
 * The user-visible message text: what was typed, followed by one fenced block
 * per text-like attachment. Text files live in the prompt itself, so the chat
 * transcript shows exactly what the model was given.
 */
export function composeText(text: string, attachments: Attachment[] = []): string {
  return [
    text.trim(),
    ...attachments.filter(a => a.kind === 'text').map(a => inlineTextAttachment(a.name, a.text ?? '')),
  ].filter(Boolean).join('\n\n')
}

/** The data URIs of the attachments that made it through image encoding. */
export function attachmentImages(attachments: Attachment[] = []): string[] {
  return attachments.flatMap(a => (a.kind === 'image' && a.dataUrl ? [a.dataUrl] : []))
}

/**
 * Build the `content` field for a message. Stays a plain string when there are
 * no images (the shape the Playground has always sent); becomes the OpenAI
 * multimodal array as soon as one image is attached — which is exactly what
 * server/src/lib/content.ts normalizes and what the vision router keys on.
 */
export function toMessageContent(text: string, images: string[] = []): string | ContentPart[] {
  if (images.length === 0) return text
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
  ]
}

/** Approximate decoded byte size of a data URI (base64 is 4 chars per 3 bytes). */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const payload = comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
  return Math.floor((payload.length * 3) / 4)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.round(bytes / 100_000) / 10} MB`
  return `${Math.round(bytes / 1000)} KB`
}

// ── Browser-only readers ────────────────────────────────────────────────────
// Kept in this module so the Playground page stays a view: everything below
// touches the DOM (canvas/FileReader) and is exercised by hand, while the pure
// helpers above carry the unit tests.

export type AttachmentErrorReason = 'unsupported' | 'too-large' | 'unreadable'

export class AttachmentError extends Error {
  reason: AttachmentErrorReason

  constructor(reason: AttachmentErrorReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

async function encode(canvas: HTMLCanvasElement, sourceType: string): Promise<string> {
  // PNG/WebP sources keep an alpha-preserving encode first; if that lands over
  // the per-image cap we fall back to progressively cheaper JPEG (a flattened
  // screenshot is far better than a rejected attachment).
  const attempts: [string, number | undefined][] = sourceType === 'image/png' || sourceType === 'image/webp'
    ? [['image/png', undefined], ['image/jpeg', 0.82], ['image/jpeg', 0.6]]
    : [['image/jpeg', 0.82], ['image/jpeg', 0.6]]
  let last = ''
  for (const [type, quality] of attempts) {
    last = canvas.toDataURL(type, quality)
    if (dataUrlBytes(last) <= MAX_IMAGE_BYTES) return last
  }
  throw new AttachmentError('too-large')
}

/** Downscale an image file to MAX_IMAGE_EDGE and return it as a data URI. */
export async function readImageAttachment(file: File): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AttachmentError('unreadable')
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AttachmentError('unreadable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  return encode(canvas, (file.type ?? '').toLowerCase())
}

/** Read a text-like file, rejecting anything over MAX_TEXT_BYTES. */
export async function readTextAttachment(file: File): Promise<string> {
  if (file.size > MAX_TEXT_BYTES) throw new AttachmentError('too-large')
  try {
    return await file.text()
  } catch {
    throw new AttachmentError('unreadable')
  }
}
