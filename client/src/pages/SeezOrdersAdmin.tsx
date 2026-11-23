import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiFetch, clearToken, setToken } from '@/lib/api'

interface Order {
  id: number
  customerName: string
  customerPhone: string
  address: string
  perfume: string
  volumeMl: number
  createdAt: string
}

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
}

async function cloudflareFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers)
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object'
      && 'error' in body && body.error && typeof body.error === 'object'
      && 'message' in body.error && typeof body.error.message === 'string'
      ? body.error.message
      : `HTTP ${response.status}`
    throw Object.assign(new Error(message), { status: response.status })
  }
  return body as T
}

export default function SeezOrdersAdmin() {
  const cloudflareMode = import.meta.env.VITE_SEEZ_CLOUDFLARE === '1'
    || window.location.hostname.endsWith('.pages.dev')
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  let loginDescription = 'সংরক্ষিত customer order দেখতে আপনার অ্যাডমিন ইমেইল ও পাসওয়ার্ড দিন।'
  if (needsSetup && !cloudflareMode) {
    loginDescription = 'প্রথমবার একটি ইমেইল ও অন্তত ৮ অক্ষরের পাসওয়ার্ড দিয়ে অ্যাডমিন অ্যাকাউন্ট তৈরি করুন।'
  }
  if (cloudflareMode) {
    loginDescription = 'Cloudflare-এ সেট করা admin password দিয়ে সংরক্ষিত customer order দেখুন।'
  }
  let passwordMinLength: number | undefined
  if (cloudflareMode) passwordMinLength = 16
  else if (needsSetup) passwordMinLength = 8

  const loadOrders = useCallback(async () => {
    const result = cloudflareMode
      ? await cloudflareFetch<{ orders: Order[] }>('/api/seez/orders')
      : await apiFetch<{ orders: Order[] }>('/api/seez/orders')
    setOrders(result.orders)
  }, [cloudflareMode])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        if (cloudflareMode) {
          const status = await cloudflareFetch<{ authenticated: boolean }>('/api/seez/admin/status')
          if (!active) return
          setNeedsSetup(false)
          if (status.authenticated) {
            await loadOrders()
            if (!active) return
            setAdminEmail('Cloudflare admin')
            setAuthenticated(true)
          }
        } else {
          const status = await apiFetch<AuthStatus>('/api/auth/status')
          if (!active) return
          setNeedsSetup(status.needsSetup)
          if (status.authenticated) {
            await loadOrders()
            if (!active) return
            setAdminEmail(status.email ?? '')
            setAuthenticated(true)
          }
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'অর্ডার সার্ভারে সংযোগ করা যাচ্ছে না।')
      } finally {
        if (active) setChecking(false)
      }
    })()
    return () => { active = false }
  }, [loadOrders])

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (cloudflareMode) {
        await cloudflareFetch('/api/seez/admin/login', {
          method: 'POST',
          body: JSON.stringify({ password }),
        })
        setAdminEmail('Cloudflare admin')
      } else {
        const path = needsSetup ? '/api/auth/setup' : '/api/auth/login'
        const result = await apiFetch<{ token: string }>(path, {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
        setToken(result.token)
        setAdminEmail(email)
      }
      await loadOrders()
      setPassword('')
      setAuthenticated(true)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'লগইন করা যায়নি।')
    } finally {
      setBusy(false)
    }
  }

  async function refreshOrders() {
    setBusy(true)
    setError('')
    try {
      await loadOrders()
    } catch (loadError) {
      if (loadError instanceof Error && 'status' in loadError && loadError.status === 401) {
        setOrders([])
        setAuthenticated(false)
      }
      setError(loadError instanceof Error ? loadError.message : 'অর্ডার লোড করা যায়নি।')
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    if (cloudflareMode) {
      try {
        await cloudflareFetch('/api/seez/admin/logout', { method: 'POST' })
      } catch (logoutError) {
        setError(logoutError instanceof Error ? logoutError.message : 'লগআউট করা যায়নি।')
      }
    } else {
      clearToken()
    }
    setAuthenticated(false)
    setOrders([])
    setPassword('')
  }

  return (
    <div className="seez-page seez-admin">
      <header className="seez-header">
        <a className="seez-logo" href="/seez.html">
          <span className="seez-logo-word">seez<span>.</span></span>
          <small>PERFUME</small>
        </a>
        <a className="seez-admin-back" href="/seez.html"><ArrowLeft size={15} /> স্টোরে ফিরুন</a>
      </header>

      <main className="seez-admin-main">
        {checking ? (
          <p className="seez-admin-message">অর্ডার ম্যানেজমেন্ট চালু হচ্ছে…</p>
        ) : !authenticated ? (
          <section className="seez-admin-login">
            <ShieldCheck className="seez-admin-shield" size={27} />
            <p className="seez-eyebrow"><span /> PRIVATE ORDER DASHBOARD</p>
            <h1>{needsSetup ? 'অ্যাডমিন অ্যাকাউন্ট তৈরি করুন' : 'অ্যাডমিন লগইন'}</h1>
            <p className="seez-admin-description">{loginDescription}</p>
            <form className="seez-order-form" onSubmit={signIn}>
              {!cloudflareMode && (
                <label>
                  ইমেইল
                  <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
                </label>
              )}
              <label>
                পাসওয়ার্ড
                <input type="password" autoComplete={needsSetup && !cloudflareMode ? 'new-password' : 'current-password'} minLength={passwordMinLength} value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
              {error && <p className="seez-order-error" role="alert">{error}</p>}
              <button className="seez-submit-order" type="submit" disabled={busy}>
                {busy ? 'অপেক্ষা করুন…' : needsSetup ? 'অ্যাডমিন অ্যাকাউন্ট তৈরি করুন' : 'লগইন করুন'}
              </button>
            </form>
            <p className="seez-admin-note">
              {cloudflareMode
                ? 'এই password Cloudflare-এর secret setting-এ রাখা হয়; কাউকে পাঠাবেন না।'
                : 'এই লগইনটি FreeLLMAPI server-এর admin account-ও। পাসওয়ার্ড গোপন রাখুন।'}
            </p>
          </section>
        ) : (
          <>
            <div className="seez-admin-title-row">
              <div>
                <p className="seez-eyebrow"><span /> SEEZ PERFUME</p>
                <h1>Customer orders</h1>
                <p className="seez-admin-description">লগইন: {adminEmail} · সর্বশেষ ৫০০টি অর্ডার</p>
              </div>
              <div className="seez-admin-actions">
                <button className="seez-admin-action" type="button" onClick={() => void refreshOrders()} disabled={busy}>
                  <RefreshCw size={15} /> Refresh
                </button>
                <button className="seez-admin-action" type="button" onClick={signOut}>
                  <LogOut size={15} /> Logout
                </button>
              </div>
            </div>
            {error && <p className="seez-order-error" role="alert">{error}</p>}
            {orders.length === 0 ? (
              <div className="seez-admin-empty">এখনো কোনো অর্ডার আসেনি।</div>
            ) : (
              <div className="seez-admin-orders">
                {orders.map((order) => (
                  <article className="seez-admin-order" key={order.id}>
                    <div className="seez-admin-order-heading">
                      <strong>অর্ডার #{order.id}</strong>
                      <time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    </div>
                    <h2>{order.perfume} <span>· {order.volumeMl} ml</span></h2>
                    <div className="seez-admin-customer">
                      <p><small>নাম</small>{order.customerName}</p>
                      <p><small>ফোন</small><a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a></p>
                    </div>
                    <p className="seez-admin-address"><small>ডেলিভারির ঠিকানা</small>{order.address}</p>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
