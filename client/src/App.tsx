import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Menu, Moon, Sun, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { setLanguage, getLanguage } from '@/locales'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import AnalyticsPage from '@/pages/AnalyticsPage'

const queryClient = new QueryClient()

const navRoutes = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/playground', labelKey: 'nav.playground' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/analytics', labelKey: 'nav.analytics' },
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

const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
] as const

function LanguageSwitcher() {
  const { t } = useTranslation()
  const current = getLanguage()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        aria-label={t('nav.language')}
      >
        <Languages className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLanguage(lang.code)}
            className={current === lang.code ? 'bg-accent text-accent-foreground font-medium' : undefined}
          >
            <span className="mr-2">{lang.flag}</span>
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DarkModeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-label={dark ? t('nav.switchToLight') : t('nav.switchToDark')}
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

// True when the dashboard runs inside the desktop shell (Electron preload
// sets this). The navbar then doubles as the window title bar: draggable,
// padded for the macOS traffic lights, and without the web-only Sign out.
const isDesktopApp = typeof window !== 'undefined' && (window as any).__FREEAPI_DESKTOP__ === true

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function Navbar() {
  const { t } = useTranslation()
  const { dark, toggle } = useDarkMode()
  const location = useLocation()
  const navigate = useNavigate()

  function isActiveRoute(to: string) {
    return location.pathname === to
  }

  return (
    <header
      // In the desktop shell the body backdrop is already translucent glass;
      // a lighter wash keeps the title bar from looking more solid than the page.
      className={`sticky top-0 z-40 border-b backdrop-blur ${isDesktopApp ? 'bg-background/45' : 'bg-background/80'}`}
      style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div
        className={`mx-auto flex max-w-6xl items-center px-4 sm:px-6 ${isDesktopApp ? 'pl-20 sm:pl-20' : ''}`}
        style={isDesktopApp ? { minHeight: 52 } : undefined}
      >
        <Brand />
        <nav
          className="ml-10 hidden items-center gap-6 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          {navRoutes.map((item) => (
            <NavItem key={item.to} to={item.to}>
              {t(item.labelKey)}
            </NavItem>
          ))}
        </nav>
        <div
          className="ml-auto hidden items-center gap-1 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <DarkModeToggle dark={dark} onToggle={toggle} />
          {!isDesktopApp && (
            <Button variant="ghost" size="sm" onClick={() => logout()}>
              {t('nav.signOut')}
            </Button>
          )}
        </div>
        <LanguageSwitcher />
        <div className="ml-auto md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={t('nav.openNav')}
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                {navRoutes.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="justify-between">
                  <span>{t('nav.theme')}</span>
                  {dark ? <Sun /> : <Moon />}
                </DropdownMenuItem>
                {!isDesktopApp && (
                  <DropdownMenuItem onClick={() => logout()}>{t('nav.signOut')}</DropdownMenuItem>
                )}
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
          <div className={`min-h-screen ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
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
