import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'

interface CopyButtonProps {
  text: string
  className?: string
  label?: string
}

// Small icon button that copies `text` to the clipboard and briefly shows a
// check. Shared by markdown code blocks and Playground replies.
export function CopyButton({ text, className, label = 'Copy' }: CopyButtonProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        // Only claim success once the text is really on the clipboard: on an
        // insecure origin the copy can fail, and a check mark over an empty
        // clipboard is worse than no feedback at all (#734).
        void copyText(text).then(ok => {
          if (!ok) {
            toast.error(t('common.copyFailed'))
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
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
