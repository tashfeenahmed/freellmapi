import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

// Loading placeholder. Pages compose these instead of a bare "Loading…" line so
// the layout keeps its shape while data arrives.
function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-lg bg-muted', className)}
      {...props}
    />
  )
}

// Table-shaped placeholder (header bar + rows), used by the model/key lists.
function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border">
      <div className="border-b bg-muted/30 px-4 py-3">
        <Skeleton className="h-3 w-40" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b px-4 py-3.5 last:border-0">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-3 w-full max-w-56" />
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="ml-auto h-4 w-8 rounded-full" />
        </div>
      ))}
    </div>
  )
}

// Card-shaped placeholder for the section/card lists (Embeddings, Media, Premium).
function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-3xl border bg-card p-5', className)}>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="mt-3 h-3 w-full max-w-sm" />
      <Skeleton className="mt-2 h-3 w-full max-w-xs" />
    </div>
  )
}

export { Skeleton, TableSkeleton, CardSkeleton }
