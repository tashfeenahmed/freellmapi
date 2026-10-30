import { useEffect, useState } from 'react'
import { copyText } from '@/lib/clipboard'

export function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])
  return (
    <button
      type="button"
      className={`glx-chip-button ${className}`}
      aria-label={label}
      onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  )
}
