// Zero-dependency toast store, same spirit as the i18n provider: a module-level
// list plus subscribers, rendered by <Toaster /> (components/toaster.tsx).
// Pages fire `toast.error(...)` / `toast.success(...)`; the App-level
// MutationCache uses toast.error as the global surface for failed mutations so
// no action can fail silently again.

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  /** Auto-dismiss delay in ms. */
  duration: number
}

type Listener = (toasts: ToastItem[]) => void

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<Listener>()
const MAX_VISIBLE_TOASTS = 4
const DEFAULT_TOAST_DURATION_MS = 10_000
const DEFAULT_ERROR_TOAST_DURATION_MS = 12_000

function emit() {
  for (const listener of listeners) listener(items)
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getToasts(): ToastItem[] {
  return items
}

export function dismissToast(id: number) {
  if (!items.some(t => t.id === id)) return
  items = items.filter(t => t.id !== id)
  emit()
}

function push(kind: ToastKind, message: string, duration?: number): number {
  const id = nextId++
  // Replace an identical pending toast instead of stacking duplicates (a
  // failing poll would otherwise pile up the same error every interval).
  items = [
    ...items.filter(t => !(t.kind === kind && t.message === message)),
    { id, kind, message, duration: duration ?? (kind === 'error' ? DEFAULT_ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS) },
  ].slice(-MAX_VISIBLE_TOASTS)
  emit()
  return id
}

export const toast = {
  success: (message: string, duration?: number) => push('success', message, duration),
  error: (message: string, duration?: number) => push('error', message, duration),
  info: (message: string, duration?: number) => push('info', message, duration),
}
