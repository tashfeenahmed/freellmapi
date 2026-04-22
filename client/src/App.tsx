import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppBrand } from '@/components/brand'
import { DarkModeToggle } from '@/components/dark-mode-toggle'
import { Button } from '@/components/ui/button'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import LoginPage from '@/pages/LoginPage'
import SetupPage from '@/pages/SetupPage'
import { useAuthStatus, useMe, useLogout } from '@/lib/auth'

const queryClient = new QueryClient()

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

function UserMenu() {
  const { data: me } = useMe()
  const logout = useLogout()
  const name = me?.user?.username ?? ''

  return (
    <div className="flex items-center gap-2">
      {name && (
        <span className="text-xs text-muted-foreground max-w-[120px] truncate" title={name}>
          {name}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        type="button"
      >
        {logout.isPending ? '…' : 'Log out'}
      </Button>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: st, isLoading: stLoad } = useAuthStatus()
  const { data: me, isLoading: meLoad } = useMe()
  const location = useLocation()

  if (stLoad || meLoad) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }
  if (st?.setupRequired) {
    return <Navigate to="/setup" replace state={{ from: location }} />
  }
  if (!me?.user) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return <>{children}</>
}

function AppShell() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-6 flex items-center">
          <AppBrand />
          <nav className="flex items-center gap-6 ml-10">
            <NavItem to="/playground">Playground</NavItem>
            <NavItem to="/keys">Keys</NavItem>
            <NavItem to="/fallback">Fallback</NavItem>
            <NavItem to="/analytics">Analytics</NavItem>
          </nav>
          <div className="ml-auto py-2 flex items-center gap-2">
            <UserMenu />
            <DarkModeToggle />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="playground" replace />} />
            <Route path="playground" element={<PlaygroundPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="fallback" element={<FallbackPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="test" element={<Navigate to="playground" replace />} />
            <Route path="health" element={<Navigate to="keys" replace />} />
            <Route path="*" element={<Navigate to="/playground" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
