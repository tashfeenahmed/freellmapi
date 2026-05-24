import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import DocsPage from '@/pages/DocsPage'
import { Toaster } from 'sonner'

const queryClient = new QueryClient()

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative text-xs md:text-sm px-0.5 md:px-1 py-4 transition-colors shrink-0 ${
          isActive
            ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

function DarkModeToggle() {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const stored = localStorage.getItem('theme')
    if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
      setDark(true)
    }
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme">
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </Button>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block size-2 rounded-full bg-foreground" />
      <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
    </div>
  )
}

function MainLayout() {
  const location = useLocation()
  const isPlayground = location.pathname.startsWith('/playground') || location.pathname === '/'
  
  // Shared sidebar state between header layout and Playground page
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768
    }
    return true
  })

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur border-b select-none">
        <div className={`w-full px-6 flex items-center transition-all duration-300 ${
          sidebarOpen && isPlayground ? 'md:pl-[272px]' : ''
        }`}>
          {/* Brand logo only appears in header if sidebar is collapsed or we are on other pages */}
          <div className={`transition-all duration-350 overflow-hidden ${
            sidebarOpen && isPlayground ? 'w-0 opacity-0 pointer-events-none md:mr-0' : 'w-fit opacity-100 mr-4 md:mr-10'
          }`}>
            <Brand />
          </div>
          
          <nav className="flex items-center gap-3 md:gap-6 overflow-x-auto no-scrollbar py-1">
            <NavItem to="/playground">Playground</NavItem>
            <NavItem to="/keys">Keys</NavItem>
            <NavItem to="/fallback">Fallback</NavItem>
            <NavItem to="/analytics">Analytics</NavItem>
            <NavItem to="/docs">Docs</NavItem>
          </nav>
          <div className="ml-auto py-2 shrink-0">
            <DarkModeToggle />
          </div>
        </div>
      </header>
      <Toaster richColors position="bottom-right" />
      <Routes>
        <Route path="/" element={<Navigate to="/playground" replace />} />
        <Route path="/playground" element={<PlaygroundPage sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />} />
        <Route path="/playground/:chatId" element={<PlaygroundPage sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />} />
        <Route path="/keys" element={<div className="max-w-6xl mx-auto px-6 py-8 w-full"><KeysPage /></div>} />
        <Route path="/fallback" element={<div className="max-w-6xl mx-auto px-6 py-8 w-full"><FallbackPage /></div>} />
        <Route path="/analytics" element={<div className="max-w-6xl mx-auto px-6 py-8 w-full"><AnalyticsPage /></div>} />
        <Route path="/docs" element={<div className="max-w-6xl mx-auto px-6 py-8 w-full"><DocsPage /></div>} />
        <Route path="/test" element={<Navigate to="/playground" replace />} />
        <Route path="/health" element={<Navigate to="/keys" replace />} />
      </Routes>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <MainLayout />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
