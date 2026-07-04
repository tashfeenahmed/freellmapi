import { useEffect, useSyncExternalStore } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from '@/lib/toast'
import { useI18n } from '@/i18n'

// Bottom-right toast stack. FloatingBar owns bottom-center, so the two never
// collide. Errors are assertive for screen readers; the rest are polite.
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-6 right-4 z-[60] flex w-full max-w-sm flex-col gap-2 sm:right-6">
      {toasts.map(t => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  )
}

const ICONS = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
} as const

const ICON_CLASS = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-destructive',
  info: 'text-muted-foreground',
} as const

function Toast({ toast }: { toast: ToastItem }) {
  const { t } = useI18n()

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.duration)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.duration])

  const Icon = ICONS[toast.kind]
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      className="pointer-events-auto flex items-start gap-2.5 rounded-2xl border bg-card px-3.5 py-2.5 shadow-lg animate-in slide-in-from-bottom-2 fade-in duration-200"
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${ICON_CLASS[toast.kind]}`} />
      <p className="min-w-0 flex-1 break-words text-sm leading-snug">{toast.message}</p>
      <button
        type="button"
        aria-label={t('common.dismiss')}
        onClick={() => dismissToast(toast.id)}
        className="rounded-md p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
