import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

// The dashboard's one destructive-action idiom: first click arms the button
// (label flips to "Confirm" in destructive color), second click within the
// timeout fires onConfirm, and doing nothing disarms it again. Extracted from
// the hand-rolled copies on Keys and ModelDetail so Embeddings/Media deletes
// (which used to fire immediately, with no confirmation) behave the same way.
type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  timeout = 3000,
  variant = 'ghost',
  size = 'xs',
  armedSize,
  className,
  armedClassName,
  disabled,
  title,
  'aria-label': ariaLabel,
}: {
  onConfirm: () => void
  /** Idle content: a text label or an icon. */
  children: ReactNode
  /** Armed label; defaults to the shared "Confirm". */
  confirmLabel?: string
  timeout?: number
  variant?: ButtonVariant
  size?: ButtonSize
  /** Optional size swap while armed (icon buttons widen to fit the text). */
  armedSize?: ButtonSize
  className?: string
  armedClassName?: string
  disabled?: boolean
  title?: string
  'aria-label'?: string
}) {
  const { t } = useI18n()
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), timeout)
    return () => window.clearTimeout(timer)
  }, [armed, timeout])

  return (
    <Button
      type="button"
      variant={variant}
      size={armed ? (armedSize ?? size) : size}
      className={cn(className, armed && (armedClassName ?? 'text-destructive'))}
      disabled={disabled}
      title={title}
      aria-label={armed ? undefined : ariaLabel}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? (confirmLabel ?? t('common.confirm')) : children}
    </Button>
  )
}
