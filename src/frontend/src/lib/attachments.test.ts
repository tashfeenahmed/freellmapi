import { describe, it, expect } from 'vitest'
import {
  MAX_IMAGE_EDGE,
  attachmentImages,
  classifyFile,
  composeText,
  dataUrlBytes,
  fenceLanguage,
  fitWithin,
  inlineTextAttachment,
  toMessageContent,
  type Attachment,
} from './attachments'

/** What PlaygroundPage sends: the composed text plus its image data URIs. */
const contentFor = (text: string, attachments: Attachment[] = []) =>
  toMessageContent(composeText(text, attachments), attachmentImages(attachments))

const png = (name = 'shot.png'): Attachment => ({
  id: name, kind: 'image', name, dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
})

describe('classifyFile', () => {
  it('accepts the four image types the composer offers', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(classifyFile({ name: 'a.bin', type })).toBe('image')
    }
  })

  it('accepts text-like files by extension even when the browser reports no MIME type', () => {
    for (const name of ['notes.txt', 'README.md', 'rows.csv', 'rows.tsv', 'body.json', 'server.log']) {
      expect(classifyFile({ name, type: '' })).toBe('text')
    }
  })

  it('rejects the document formats left for the follow-up', () => {
    expect(classifyFile({ name: 'book.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBeNull()
    expect(classifyFile({ name: 'paper.pdf', type: 'application/pdf' })).toBeNull()
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBeNull()
    expect(classifyFile({ name: 'clip.mp4', type: 'video/mp4' })).toBeNull()
  })
})

describe('fitWithin', () => {
  it('never scales up', () => {
    expect(fitWithin(320, 200)).toEqual({ width: 320, height: 200 })
  })

  it('caps the longest edge and preserves the aspect ratio', () => {
    expect(fitWithin(4000, 2000)).toEqual({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE / 2 })
    expect(fitWithin(2000, 4000)).toEqual({ width: MAX_IMAGE_EDGE / 2, height: MAX_IMAGE_EDGE })
  })
})

describe('inlineTextAttachment', () => {
  it('labels the block with the filename and a language hint', () => {
    expect(fenceLanguage('rows.csv')).toBe('csv')
    expect(inlineTextAttachment('rows.csv', 'a,b\n1,2')).toBe('rows.csv:\n```csv\na,b\n1,2\n```')
  })

  it('widens the fence so a markdown file cannot break out of it', () => {
    const inlined = inlineTextAttachment('doc.md', 'text\n```js\ncode()\n```')
    expect(inlined.startsWith('doc.md:\n````markdown\n')).toBe(true)
    expect(inlined.endsWith('\n````')).toBe(true)
  })
})

describe('message content', () => {
  it('stays a plain string when nothing is attached', () => {
    expect(contentFor('hello')).toBe('hello')
    expect(contentFor('hello', [])).toBe('hello')
  })

  it('inlines text files into the string, still without an array envelope', () => {
    expect(contentFor('summarize', [
      { id: '1', kind: 'text', name: 'notes.txt', text: 'line one' },
    ])).toBe('summarize\n\nnotes.txt:\n```text\nline one\n```')
  })

  it('emits the OpenAI multimodal array once an image is attached', () => {
    expect(contentFor('what is this?', [png()])).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ])
  })

  it('omits the text part when the message is images only', () => {
    expect(contentFor('   ', [png()])).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ])
  })

  it('keeps every image, in attach order, alongside inlined text files', () => {
    const content = contentFor('compare', [
      png('a.png'),
      { id: 't', kind: 'text', name: 'notes.md', text: 'ctx' },
      png('b.png'),
    ]) as Exclude<ReturnType<typeof contentFor>, string>
    expect(content.map(p => p.type)).toEqual(['text', 'image_url', 'image_url'])
    expect((content[0] as { text: string }).text).toBe('compare\n\nnotes.md:\n```markdown\nctx\n```')
  })

  it('drops images that never finished encoding', () => {
    expect(contentFor('hi', [{ id: 'x', kind: 'image', name: 'x.png' }])).toBe('hi')
  })

  it('rebuilds history turns from the stored text + image URIs', () => {
    // How PlaygroundPage replays earlier turns: the transcript keeps the text
    // and the data URIs, and the request envelope is rebuilt from them.
    expect(toMessageContent('earlier turn', ['data:image/jpeg;base64,zz'])).toEqual([
      { type: 'text', text: 'earlier turn' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,zz' } },
    ])
    expect(toMessageContent('plain turn')).toBe('plain turn')
  })
})

describe('dataUrlBytes', () => {
  it('measures the decoded payload, not the URI', () => {
    // 4 base64 chars per 3 bytes; the "data:...;base64," prefix is excluded.
    expect(dataUrlBytes(`data:image/png;base64,${'A'.repeat(400)}`)).toBe(300)
  })
})
