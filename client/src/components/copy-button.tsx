import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CopyButtonProps {
  text: string
  className?: string
  label?: string
}

// Small icon button that copies `text` to the clipboard and briefly shows a
// check. Shared by markdown code blocks and Playground replies.
export function CopyButton({ text, className, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className={cn(
        'inline-flex items-center justify-center rounded-md border bg-background/80 text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}
