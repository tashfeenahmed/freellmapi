import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Chat } from '@/components/Chat'
import { ControlRoom } from '@/components/ControlRoom'
import { SignInRequired } from '@/components/SignInRequired'
import { getSessionToken } from '@/lib/session'
import type { ProviderChoice } from '@/lib/capabilities'

// GLIXEL shell: header, the active view, and a bottom tab bar sized for thumbs.
// The tab lives in the URL hash (#control; #status from increment 2 still
// works), so nothing is written to storage. The AI path is held here, in
// memory, so the Control Room and the chat always agree on it.
type Tab = 'chat' | 'control'
const tabFromHash = (): Tab => (/^#(control|status)$/.test(window.location.hash) ? 'control' : 'chat')
function writeHash(tab: Tab) { window.location.hash = tab === 'control' ? 'control' : '' }

function Shell() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [provider, setProvider] = useState<ProviderChoice>('freellmapi')
  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const go = (next: Tab) => { writeHash(next); setTab(next) }

  if (!getSessionToken()) return <SignInRequired />

  return (
    <main className="glx-shell flex h-dvh flex-col">
      <header className="shrink-0 border-b border-glx-line px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="glx-wordmark">GLIXEL</h1>
            <p className="truncate text-[11px] text-glx-muted">The pixel remembers what the signal forgot.</p>
          </div>
          <a className="glx-link text-xs" href="/">Dashboard</a>
        </div>
      </header>
      <div className={`min-h-0 flex-1 px-4 ${tab === 'chat' ? 'flex flex-col' : 'overflow-y-auto pt-4'}`}>
        <div className={`mx-auto w-full ${tab === 'chat' ? 'flex min-h-0 max-w-3xl flex-1 flex-col' : 'max-w-5xl'}`}>
          {tab === 'chat'
            ? <Chat provider={provider} onProviderReset={() => setProvider('freellmapi')} />
            : <ControlRoom provider={provider} onProvider={setProvider} />}
        </div>
      </div>
      <nav className="glx-tabs shrink-0 border-t border-glx-line pb-[env(safe-area-inset-bottom)]" aria-label="GLIXEL">
        {(['chat', 'control'] as const).map(t => (
          <button
            key={t} type="button" aria-current={tab === t ? 'page' : undefined}
            className={tab === t ? 'glx-tab glx-tab-active' : 'glx-tab'} onClick={() => go(t)}
          >
            {t === 'chat' ? 'Chat' : 'Control'}
          </button>
        ))}
      </nav>
    </main>
  )
}

export function App() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  }))
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  )
}
