import { useState } from 'react'

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    copyToClipboard(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="prose-code-block">
      <div className="flex items-center justify-between px-3 py-1 text-[0.6875rem] text-muted-foreground bg-[oklch(0.13_0_0)] rounded-t-lg border-b border-white/5">
        <span>{language || 'code'}</span>
      </div>
      <pre className="!rounded-t-none !mt-0">
        <code>{code}</code>
      </pre>
      <button
        className="copy-button px-2 py-1 rounded text-[0.6875rem] bg-white/10 text-muted-foreground hover:text-foreground transition-colors"
        onClick={handleCopy}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function tokenizeInline(text: string): (string | { type: 'bold' | 'italic' | 'code' | 'link'; content: string; href?: string })[] {
  const tokens: (string | { type: 'bold' | 'italic' | 'code' | 'link'; content: string; href?: string })[] = []
  let remaining = text

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/^`([^`]+)`/)
    if (codeMatch) {
      tokens.push({ type: 'code', content: codeMatch[1] })
      remaining = remaining.slice(codeMatch[0].length)
      continue
    }

    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      tokens.push({ type: 'link', content: linkMatch[1], href: linkMatch[2] })
      remaining = remaining.slice(linkMatch[0].length)
      continue
    }

    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/)
    if (boldMatch) {
      tokens.push({ type: 'bold', content: boldMatch[1] })
      remaining = remaining.slice(boldMatch[0].length)
      continue
    }

    const italicMatch = remaining.match(/^\*([^*]+)\*/)
    if (italicMatch) {
      tokens.push({ type: 'italic', content: italicMatch[1] })
      remaining = remaining.slice(italicMatch[0].length)
      continue
    }

    const char = remaining[0]
    tokens.push(char)
    remaining = remaining.slice(1)
  }

  return tokens
}

function InlineContent({ text }: { text: string }) {
  const tokens = tokenizeInline(text)
  return (
    <>
      {tokens.map((token, i) => {
        if (typeof token === 'string') {
          return <span key={i}>{token}</span>
        }
        switch (token.type) {
          case 'bold':
            return <strong key={i}>{token.content}</strong>
          case 'italic':
            return <em key={i}>{token.content}</em>
          case 'code':
            return <code key={i} className="prose-inline-code">{token.content}</code>
          case 'link':
            return (
              <a key={i} href={token.href} target="_blank" rel="noopener noreferrer">
                {token.content}
              </a>
            )
          default:
            return <span key={i}>{token.content}</span>
        }
      })}
    </>
  )
}

interface Block {
  type: 'paragraph' | 'heading' | 'code' | 'list' | 'hr'
  level?: number
  content?: string
  language?: string
  items?: string[]
}

function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] })
      i++
      continue
    }

    if (line.trim() === '---' || line.trim() === '***') {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (line.match(/^\s*[-*+]\s+/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\s*[-*+]\s+/)) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim() || undefined
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push({ type: 'code', language, content: codeLines.join('\n') })
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !lines[i].match(/^\s*[-*+]\s+/) && !lines[i].match(/^\s*\d+\.\s+/) && lines[i].trim() !== '---' && lines[i].trim() !== '***') {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') })
    } else if (line.trim() === '' && blocks.length > 0) {
      i++
    } else {
      i++
    }
  }

  return blocks
}

export function MarkdownRenderer({ content }: { content: string }) {
  const blocks = parseMarkdown(content)

  return (
    <div className="prose">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
            return <Tag key={i}><InlineContent text={block.content || ''} /></Tag>
          case 'paragraph':
            return (
              <p key={i} className="animate-message-fade-in">
                {block.content!.split('\n').map((line, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    <InlineContent text={line} />
                  </span>
                ))}
              </p>
            )
          case 'code':
            return <CodeBlock key={i} code={block.content || ''} language={block.language} />
          case 'list':
            return (
              <ul key={i} className="animate-message-fade-in">
                {block.items!.map((item, j) => (
                  <li key={j}><InlineContent text={item} /></li>
                ))}
              </ul>
            )
          case 'hr':
            return <hr key={i} />
          default:
            return null
        }
      })}
    </div>
  )
}
