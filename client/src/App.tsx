import { useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChevronDown, KeyRound, LogOut, Menu, MoreHorizontal, Search, Settings, Sparkles } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate, ChangeCredentialsModal } from '@/components/auth-gate'
import { CommandPalette } from '@/components/command-palette'
import { openCommandPalette } from '@/components/command-palette-state'
import { ErrorBoundary } from '@/components/error-boundary'
import { SettingsDialog } from '@/components/settings-dialog'
import { Toaster } from '@/components/toaster'
import { usePremium } from '@/hooks/use-premium'
import { I18nProvider, useI18n } from '@/i18n'
import { logout } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ThemeProvider } from '@/theme'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import ModelDetailPage from '@/pages/ModelDetailPage'
import FusionPage from '@/pages/FusionPage'
import CombosPage from '@/pages/CombosPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import ImagePage from '@/pages/ImagePage'
import AudioPage from '@/pages/AudioPage'
import MediaDetailPage from '@/pages/MediaDetailPage'
import EmbeddingDetailPage from '@/pages/EmbeddingDetailPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import PremiumPage from '@/pages/PremiumPage'
import NotFoundPage from '@/pages/NotFoundPage'
import AgentsPage from '@/pages/AgentsPage'

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
  { to: '/agents', labelKey: 'nav.agents' },
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
  { to: '/models/combos', labelKey: 'models.combosTab' },
]

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

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
const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __FREEAPI_DESKTOP__?: boolean }).__FREEAPI_DESKTOP__ === true

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function AccountMenuItems({
  showUpgrade,
  upgradeLabel,
  settingsLabel,
  signOutLabel,
  changeEmailLabel,
  changePasswordLabel,
  onUpgrade,
  onOpenSettings,
  onChangeEmail,
  onChangePassword,
}: {
  showUpgrade: boolean
  upgradeLabel: string
  settingsLabel: string
  signOutLabel: string
  changeEmailLabel: string
  changePasswordLabel: string
  onUpgrade: () => void
  onOpenSettings: () => void
  onChangeEmail: () => void
  onChangePassword: () => void
}) {
  return (
    <>
      {showUpgrade && (
        <DropdownMenuItem onClick={onUpgrade}>
          <Sparkles />
          {upgradeLabel}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onOpenSettings}>
        <Settings />
        {settingsLabel}
      </DropdownMenuItem>
      {/* Desktop signs in with a hidden local account, so it has no credentials
          to change and no session to end. */}
      {!isDesktopApp && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onChangeEmail}>
            <span className="flex size-4 items-center justify-center font-serif text-xs font-bold">@</span>
            {changeEmailLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onChangePassword}>
            <KeyRound />
            {changePasswordLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => logout()}>
            <LogOut />
            {signOutLabel}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

function Navbar() {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentialsMode, setCredentialsMode] = useState<'password' | 'email' | null>(null)
  const { data: premium, licensed, isLoading: premiumLoading, isError: premiumError } = usePremium()
  const showUpgrade = Boolean(premium) && !licensed && !premiumLoading && !premiumError

  return (
    <>
      <header
        // In the desktop shell the body backdrop is already translucent glass;
        // a lighter wash keeps the title bar from looking more solid than the page.
        className={`sticky top-0 z-40 border-b backdrop-blur ${isDesktopApp ? 'bg-background/45' : 'bg-background/80'}`}
        style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <div
          // Physical pl (not logical ps): the gutter reserves the macOS
          // traffic lights, which stay top-left even when an RTL locale
          // flips the document direction.
          className={`mx-auto flex max-w-6xl items-center px-4 sm:px-6 ${isDesktopApp ? 'pl-20 sm:pl-20' : ''}`}
          style={isDesktopApp ? { minHeight: 52 } : undefined}
        >
          <Brand />
          <nav
            className="ms-10 hidden items-center gap-6 md:flex"
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
                      {modelItems.map((model) => (
                        <DropdownMenuItem key={model.to} onClick={() => navigate(model.to)}>
                          {t(model.labelKey)}
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
            className="ms-auto hidden items-center gap-1 md:flex"
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
                <AccountMenuItems
                  showUpgrade={showUpgrade}
                  upgradeLabel={t('nav.upgrade')}
                  settingsLabel={t('nav.settings')}
                  signOutLabel={t('nav.signOut')}
                  changeEmailLabel={t('auth.changeEmail')}
                  changePasswordLabel={t('auth.changePassword')}
                  onUpgrade={() => navigate('/premium')}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onChangeEmail={() => setCredentialsMode('email')}
                  onChangePassword={() => setCredentialsMode('password')}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="ms-auto md:hidden">
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
                          {modelItems.map((model) => (
                            <DropdownMenuItem key={model.to} onClick={() => navigate(model.to)}>
                              {t(model.labelKey)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : (
                      <DropdownMenuItem
                        key={item.to}
                        onClick={() => navigate(item.to)}
                        className={location.pathname === item.to ? 'bg-accent text-accent-foreground font-medium' : undefined}
                      >
                        {t(item.labelKey)}
                      </DropdownMenuItem>
                    ),
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <AccountMenuItems
                  showUpgrade={showUpgrade}
                  upgradeLabel={t('nav.upgrade')}
                  settingsLabel={t('nav.settings')}
                  signOutLabel={t('nav.signOut')}
                  changeEmailLabel={t('auth.changeEmail')}
                  changePasswordLabel={t('auth.changePassword')}
                  onUpgrade={() => navigate('/premium')}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onChangeEmail={() => setCredentialsMode('email')}
                  onChangePassword={() => setCredentialsMode('password')}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {credentialsMode && (
        <ChangeCredentialsModal mode={credentialsMode} onClose={() => setCredentialsMode(null)} />
      )}
    </>
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
      <ThemeProvider>
        <I18nProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <AuthGate>
              <div className={`min-h-screen ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
                <Navbar />
                <main className="mx-auto max-w-6xl px-6 py-8">
                  <PageBoundary>
                    <Routes>
                      <Route path="/" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models/chat" element={<FallbackPage />} />
                      <Route path="/models/chat/:id" element={<ModelDetailPage />} />
                      <Route path="/models/fusion" element={<FusionPage />} />
                      <Route path="/models/combos" element={<CombosPage />} />
                      <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                      <Route path="/models/embeddings/:id" element={<EmbeddingDetailPage />} />
                      <Route path="/models/image" element={<ImagePage />} />
                      <Route path="/models/image/:id" element={<MediaDetailPage modality="image" />} />
                      <Route path="/models/audio" element={<AudioPage />} />
                      <Route path="/models/audio/:id" element={<MediaDetailPage modality="audio" />} />
                      <Route path="/models/transcription/:id" element={<MediaDetailPage modality="transcription" />} />
                      <Route path="/playground" element={<PlaygroundPage />} />
                      <Route path="/keys" element={<KeysPage />} />
                      <Route path="/agents" element={<AgentsPage />} />
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
      </ThemeProvider>
    </QueryClientProvider>
  )
}

export default App
