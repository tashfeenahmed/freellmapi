import { memo, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const components: Components = {
  p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
    <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap wrap-break-word">
      {children}
    </p>
  ),
  a: ({ children, href }: ComponentPropsWithoutRef<'a'>) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2 decoration-foreground/40 hover:decoration-foreground wrap-break-word"
    >
      {children}
    </a>
  ),
  h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
    <h1 className="mt-4 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }: ComponentPropsWithoutRef<'h4'>) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="my-2 ml-5 list-disc space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }: ComponentPropsWithoutRef<'li'>) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="my-2 border-l-2 border-foreground/20 pl-3 italic text-foreground/80 first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-foreground/15" />,
  strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: ComponentPropsWithoutRef<'em'>) => <em className="italic">{children}</em>,
  del: ({ children }: ComponentPropsWithoutRef<'del'>) => <del className="opacity-70">{children}</del>,

  table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: ComponentPropsWithoutRef<'thead'>) => <thead className="bg-background/40">{children}</thead>,
  th: ({ children, style }: ComponentPropsWithoutRef<'th'>) => (
    <th
      style={style}
      className="border border-foreground/15 px-2 py-1 text-left font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }: ComponentPropsWithoutRef<'td'>) => (
    <td style={style} className="border border-foreground/15 px-2 py-1 align-top">
      {children}
    </td>
  ),

  code: ({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) => {
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[12.5px] leading-relaxed', className)} {...props}>
          {children}
        </code>
      )
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
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => (
    <pre className="my-2 overflow-x-auto rounded-lg border bg-background/60 p-3 first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
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
