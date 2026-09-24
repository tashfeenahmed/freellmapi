import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { highlightCode } from '@/lib/highlight'

// Highlighted source: the reply code blocks and the artifact panel's Code tab.
// highlightCode returns escaped HTML with hljs-* spans, so injecting it is
// safe; the token colours live in index.css under `.code-highlight`.

export interface CodeBlockProps {
  code: string
  language?: string | null
  className?: string
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const { html, language: applied } = useMemo(() => highlightCode(code, language), [code, language])
  return (
    <code
      className={cn('code-highlight block font-mono text-[12.5px] leading-relaxed whitespace-pre', className)}
      data-language={applied ?? undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
