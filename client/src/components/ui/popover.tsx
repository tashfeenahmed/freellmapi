import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type PopoverContextValue = {
  open: boolean
  setOpen: (open: boolean) => void
}

const PopoverContext = createContext<PopoverContextValue | null>(null)

export function Popover({ children, onOpenChange }: { children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false)
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  const value = useMemo(() => ({ open, setOpen }), [open])
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>
}

export function PopoverTrigger({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = useContext(PopoverContext)
  if (!ctx) return <button className={className} {...props}>{children}</button>
  return (
    <button
      type="button"
      className={className}
      {...props}
      onClick={(e) => {
        props.onClick?.(e)
        ctx.setOpen(!ctx.open)
      }}
    >
      {children}
    </button>
  )
}

export function PopoverContent({ children, className, align }: { children: ReactNode; className?: string; align?: 'start' | 'center' | 'end' }) {
  const ctx = useContext(PopoverContext)
  if (!ctx?.open) return null
  return (
    <div
      className={className}
      data-align={align}
      style={{ position: 'absolute', zIndex: 50 }}
    >
      {children}
    </div>
  )
}
