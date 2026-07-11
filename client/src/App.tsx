import { useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChevronDown, Languages, Menu, MoreHorizontal, Moon, Search, Sun } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate } from '@/components/auth-gate'
import { CommandPalette, openCommandPalette } from '@/components/command-palette'
import { ErrorBoundary } from '@/components/error-boundary'
import { Toaster } from '@/components/toaster'
import { I18nProvider, useI18n, SUPPORTED_LOCALES, type Locale } from '@/i18n'
import { logout } from '@/lib/api'
import { toast } from '@/lib/toast'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import ModelDetailPage from '@/pages/ModelDetailPage'
import FusionPage from '@/pages/FusionPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import ImagePage from '@/pages/ImagePage'
import AudioPage from '@/pages/AudioPage'
import MediaDetailPage from '@/pages/MediaDetailPage'
import EmbeddingDetailPage from '@/pages/EmbeddingDetailPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import PremiumPage from '@/pages/PremiumPage'
import NotFoundPage from '@/pages/NotFoundPage'

// Every failed mutation surfaces as an error toast, so no action fails
// silently. A page that already shows the failure inline can opt out with
// `meta: { silenceToast: true }` on the mutation.
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silenceToast) return
      toast.error(error instanceof Error ? error.message : String(error))
    },
  }),
})

const navItems = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/playground', labelKey: 'nav.playground' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/premium', labelKey: 'nav.premium' },
]

// The five modality pages behind "Models"; surfaced in the nav dropdown and
// the mobile submenu so Fusion/Embeddings/Image/Audio are discoverable without
// first landing on the chat table.
const modelItems = [
  { to: '/models/chat', labelKey: 'models.chatModelsTab' },
  { to: '/models/embeddings', labelKey: 'models.embeddingsTab' },
  { to: '/models/image', labelKey: 'models.imageTab' },
  { to: '/models/audio', labelKey: 'models.audioTab' },
  { to: '/models/fusion', labelKey: 'models.fusionTab' },
]

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

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

// Language picker as a dropdown submenu, shared by the desktop (⋯) and mobile
// (☰) menus. Radio items show a check on the active locale; selecting one calls
// setLocale, which persists and re-renders every t() synchronously.
function LanguageSubMenu() {
  const { locale, setLocale, t } = useI18n()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Languages className="size-4" />
        <span>{t('nav.language')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          {SUPPORTED_LOCALES.map((code) => (
            <DropdownMenuRadioItem key={code} value={code}>
              {t(`languages.${code}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function Navbar() {
  const { dark, toggle } = useDarkMode()
  const { t } = useI18n()
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
          {navItems.map((item) =>
            item.to === '/models' ? (
              // Split control: the label navigates, the chevron reveals the
              // five modality pages hiding behind "Models".
              <div key={item.to} className="flex items-center gap-0.5">
                <NavItem to={item.to}>{t(item.labelKey)}</NavItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t('nav.modelsMenu')}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    {modelItems.map((m) => (
                      <DropdownMenuItem key={m.to} onClick={() => navigate(m.to)}>
                        {t(m.labelKey)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <NavItem key={item.to} to={item.to}>
                {t(item.labelKey)}
              </NavItem>
            ),
          )}
        </nav>
        <div
          className="ml-auto hidden items-center gap-1 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label={t('palette.title')}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <Search className="size-3.5" />
            <kbd className="text-[10px] text-muted-foreground">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={t('nav.openMenu')}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={toggle} className="justify-between">
                <span>{t('nav.theme')}</span>
                {dark ? <Sun /> : <Moon />}
              </DropdownMenuItem>
              <LanguageSubMenu />
              {!isDesktopApp && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => logout()}>{t('nav.signOut')}</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="ml-auto md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={t('nav.openMenu')}
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                {navItems.map((item) =>
                  item.to === '/models' ? (
                    <DropdownMenuSub key={item.to}>
                      <DropdownMenuSubTrigger
                        className={location.pathname.startsWith('/models') ? 'bg-accent text-accent-foreground font-medium' : undefined}
                      >
                        {t(item.labelKey)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {modelItems.map((m) => (
                          <DropdownMenuItem key={m.to} onClick={() => navigate(m.to)}>
                            {t(m.labelKey)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : (
                    <DropdownMenuItem
                      key={item.to}
                      onClick={() => navigate(item.to)}
                      className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                    >
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="justify-between">
                  <span>{t('nav.theme')}</span>
                  {dark ? <Sun /> : <Moon />}
                </DropdownMenuItem>
                <LanguageSubMenu />
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

// Keyed by pathname so navigating away from a crashed page resets the boundary.
function PageBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <div className={`min-h-screen ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
            <Navbar />
            <main className="max-w-6xl mx-auto px-6 py-8">
              <PageBoundary>
              <Routes>
                <Route path="/" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models/chat" element={<FallbackPage />} />
                <Route path="/models/chat/:id" element={<ModelDetailPage />} />
                <Route path="/models/fusion" element={<FusionPage />} />
                <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                <Route path="/models/embeddings/:id" element={<EmbeddingDetailPage />} />
                <Route path="/models/image" element={<ImagePage />} />
                <Route path="/models/image/:id" element={<MediaDetailPage modality="image" />} />
                <Route path="/models/audio" element={<AudioPage />} />
                <Route path="/models/audio/:id" element={<MediaDetailPage modality="audio" />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/keys" element={<KeysPage />} />
                <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/premium" element={<PremiumPage />} />
                <Route path="/test" element={<Navigate to="/playground" replace />} />
                <Route path="/health" element={<Navigate to="/keys" replace />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
              </PageBoundary>
            </main>
            <Toaster />
            <CommandPalette />
          </div>
        </AuthGate>
      </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  )
}

export default App
