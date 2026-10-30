import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'

// Assistant replies are untrusted text. react-markdown builds React elements
// (never innerHTML); on top of its defaults this renderer:
//  - drops raw HTML entirely (skipHtml), so <script>, <img onerror> etc. are not rendered;
//  - keeps only http(s) and mailto links (defaultUrlTransform blanks javascript:, data:, ...);
//  - never loads images: a reply could embed a URL that leaks the conversation
//    to a third party the moment it renders, so images become plain links.

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

const safeUrl = (url: string) => {
  const cleaned = defaultUrlTransform(url)
  return /^(https?:|mailto:|#)/i.test(cleaned) ? cleaned : ''
}

const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="glx-md-link">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? safeUrl(src) : ''
    const label = `image: ${alt || 'untitled'}`
    return href
      ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="glx-md-link" data-testid="md-image-link">[{label}]</a>
      : <span>[{label}]</span>
  },
  pre: ({ children }) => {
    const code = nodeText(children).replace(/\n$/, '')
    return (
      <div className="glx-md-pre group relative" data-testid="code-block">
        <CopyButton text={code} label="Copy code" className="absolute right-1.5 top-1.5" />
        <pre>{children}</pre>
      </div>
    )
  },
  table: ({ children }) => <div className="glx-md-table"><table>{children}</table></div>,
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="glx-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
