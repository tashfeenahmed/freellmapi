import { useEffect, useState, type ReactNode } from 'react'

// Viewport-fixed action bar that slides up when shown and — instead of
// vanishing — slides back down before unmounting (kept in the tree for the
// duration of the exit animation).
export function FloatingBar({ show, children }: { show: boolean; children: ReactNode }) {
  const [render, setRender] = useState(show)
  useEffect(() => {
    if (show) {
      setRender(true)
      return
    }
    const t = setTimeout(() => setRender(false), 300) // match animation duration
    return () => clearTimeout(t)
  }, [show])
  if (!render) return null
  return (
    <div
      className={`fixed inset-x-0 bottom-6 z-50 flex justify-center px-6 pointer-events-none duration-300 ${
        show
          ? 'animate-in slide-in-from-bottom-4 fade-in'
          : 'animate-out slide-out-to-bottom-4 fade-out fill-mode-forwards'
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-lg">
        {children}
      </div>
    </div>
  )
}
