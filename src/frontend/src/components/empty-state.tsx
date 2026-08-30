import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The dashboard's one empty-state idiom: dashed card, optional icon, a title,
// and ideally an action that tells the user what to do next (an empty state
// without a next step is a dead end).
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-3xl border border-dashed p-8 text-center', className)}>
      {Icon && <Icon className="mx-auto mb-3 size-6 text-muted-foreground/60" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</div>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}
