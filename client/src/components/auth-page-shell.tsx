import type { ReactNode } from 'react'
import { AppBrand } from '@/components/brand'
import { DarkModeToggle } from '@/components/dark-mode-toggle'

/** Same top bar as the main app (brand + theme), without nav — for /login and /setup. */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-6 flex items-center h-14">
          <AppBrand />
          <div className="ml-auto flex items-center py-2">
            <DarkModeToggle />
          </div>
        </div>
      </header>
      <div className="flex-1 flex flex-col">{children}</div>
    </div>
  )
}
