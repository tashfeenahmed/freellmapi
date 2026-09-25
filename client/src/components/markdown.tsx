import { memo, isValidElement, useContext, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AppWindow, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from './copy-button'
import { CodeBlock } from './code-block'
import { artifactKindOf, type ArtifactKind } from '@/lib/artifacts'
import { ArtifactHostContext } from '@/lib/artifact-host'
import { useI18n } from '@/i18n'


function fenceLanguage(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return ''
  const cls = (child.props as { className?: string }).className ?? ''
  return /language-([^\s]+)/.exec(cls)?.[1]?.toLowerCase() ?? ''
}

function ArtifactCard({ kind, language, code }: { kind: ArtifactKind; language: string; code: string }) {
  const { t } = useI18n()
  const host = useContext(ArtifactHostContext)!
  const active = host.activeCode === code
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)?.[1]?.trim()
    || t(kind === 'svg' ? 'playground.artifactSvg' : 'playground.artifactHtml')
  const Icon = kind === 'svg' ? ImageIcon : AppWindow
  return (
    <button
      type="button"
      onClick={() => host.open(kind, language, code)}
      className={cn(
        'group/artifact my-2 flex w-full max-w-md items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/60 first:mt-0 last:mb-0',
        active && 'border-foreground/40',
      )}
      aria-pressed={active}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">
          {t('playground.artifactOpen')} · {code.split('\n').length} {t('playground.artifactLines')}
        </span>
      </span>
    </button>
  )
}

// react-markdown hands <pre> its rendered <code> element, not the raw source,
// so pull the text back out of the React tree for the copy button.
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

function Pre({ children }: { children?: ReactNode }) {
  const host = useContext(ArtifactHostContext)
  if (host) {
    const language = fenceLanguage(children)
    const code = nodeText(children).replace(/\n$/, '')
    const kind = artifactKindOf(language, code)
    if (kind) return <ArtifactCard kind={kind} language={language} code={code} />
  }
  return (
    <pre className="group relative my-2 overflow-x-auto rounded-lg border bg-background/60 p-3 first:mt-0 last:mb-0">
      <CopyButton
        text={nodeText(children).replace(/\n$/, '')}
        label="Copy code"
        className="absolute right-2 top-2 size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      />
      {children}
    </pre>
  )
}

const components: Components = {
  p: ({ children }) => (
    <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap wrap-break-word">
      {children}
    </p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2 decoration-foreground/40 hover:decoration-foreground wrap-break-word"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-foreground/20 pl-3 italic text-foreground/80 first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-foreground/15" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="opacity-70">{children}</del>,

  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-background/40">{children}</thead>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="border border-foreground/15 px-2 py-1 text-left font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-foreground/15 px-2 py-1 align-top">
      {children}
    </td>
  ),

  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      const language = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? null
      return <CodeBlock code={nodeText(children).replace(/\n$/, '')} language={language} className={className} />
    }
    return (
      <code
        className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em] wrap-break-word"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }) => <Pre>{children}</Pre>,
}

interface MarkdownProps {
  children: string
  className?: string
}

function MarkdownInner({ children, className }: MarkdownProps) {
  return (
    <div className={cn('text-sm leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownInner)
