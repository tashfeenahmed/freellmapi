import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Menu, Moon, Sun } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate } from '@/components/auth-gate'
import { logout } from '@/lib/api'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import AnalyticsPage from '@/pages/AnalyticsPage'

const queryClient = new QueryClient()

const navItems = [
  { to: '/models', label: 'Models' },
  { to: '/playground', label: 'Playground' },
  { to: '/keys', label: 'Keys' },
  { to: '/analytics', label: 'Analytics' },
]

function getPreferredDarkMode() {
  if (typeof window === 'undefined') {
    return false
  }

  const stored = localStorage.getItem('theme')
  return stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative text-sm px-1 py-4 transition-colors ${
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

function useDarkMode() {
  const [dark, setDark] = useState(getPreferredDarkMode)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function toggle() {
    setDark((current) => {
      const next = !current
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }

  return { dark, toggle }
}

function DarkModeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 transition-opacity hover:opacity-70">
      <span className="inline-block size-2 rounded-full bg-foreground" />
      <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
    </Link>
  )
}

function Navbar() {
  const { dark, toggle } = useDarkMode()
  const location = useLocation()
  const navigate = useNavigate()

  function isActiveRoute(to: string) {
    return location.pathname === to
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center px-4 sm:px-6">
        <Brand />
        <nav className="ml-10 hidden items-center gap-6 md:flex">
          {navItems.map((item) => (
            <NavItem key={item.to} to={item.to}>
              {item.label}
            </NavItem>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-1 md:flex">
          <DarkModeToggle dark={dark} onToggle={toggle} />
          <Button variant="ghost" size="sm" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
        <div className="ml-auto md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label="Open navigation menu"
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                {navItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="justify-between">
                  <span>Theme</span>
                  {dark ? <Sun /> : <Moon />}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => logout()}>Sign out</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <div className="min-h-screen bg-background">
            <Navbar />
            <main className="max-w-6xl mx-auto px-6 py-8">
              <Routes>
                <Route path="/" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models/chat" element={<FallbackPage />} />
                <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/keys" element={<KeysPage />} />
                <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/test" element={<Navigate to="/playground" replace />} />
                <Route path="/health" element={<Navigate to="/keys" replace />} />
              </Routes>
            </main>
          </div>
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
