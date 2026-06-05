import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
  divider = true,
}: {
  title: string
  description?: string
  actions?: ReactNode
  divider?: boolean
}) {
  return (
    <div className={`mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${divider ? 'border-b pb-6' : ''}`}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">{actions}</div>}
    </div>
  )
}
