import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, setToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'

// Matches the server rule (routes/auth.ts zod schema).
const PASSWORD_MIN = 8

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}

function AuthForm({ mode, onAuthed }: { mode: 'setup' | 'login'; onAuthed: () => void }) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  // Revealed only after the server asks for it (remote first-run setup). A
  // browser on the same machine as the server never sees this field.
  const [codeRequired, setCodeRequired] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const isSetup = mode === 'setup'

  // Inline field feedback; the server stays authoritative. Only the setup form
  // enforces the password minimum client-side (an existing password of any
  // length must still be able to log in).
  const emailError = !email.trim()
    ? t('validation.required')
    : !isEmail(email)
      ? t('validation.email')
      : null
  const passwordError = !password
    ? t('validation.required')
    : isSetup && password.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (emailError || passwordError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: Record<string, string> = { email, password }
      // Only the setup flow carries a code, and only once the server has asked
      // for it. The server ignores it for local (loopback) setup.
      if (isSetup && setupCode) payload.setupCode = setupCode.trim()
      const res = await apiFetch<{ token: string }>(isSetup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setToken(res.token)
      onAuthed()
    } catch (err) {
      // The server gates remote first-run setup behind a one-time code; reveal
      // the field so the operator can paste the code from the server logs.
      if (isSetup && (err as ApiError).code === 'setup_code_required') {
        setCodeRequired(true)
      }
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block size-2 rounded-full bg-foreground" />
        <span className="font-semibold tracking-tight text-sm">FreeLLMAPI</span>
      </div>
      <div className="rounded-3xl border bg-card p-6">
        <h1 className="text-base font-medium">{isSetup ? t('auth.createYourAccount') : t('auth.signIn')}</h1>
        <p className="text-xs text-muted-foreground mt-1 mb-4">
          {isSetup
            ? t('auth.setupDescription')
            : t('auth.loginDescription')}
        </p>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-email">{t('auth.email')}</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              aria-invalid={attempted && !!emailError}
            />
            {attempted && <FieldError error={emailError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auth-password">{t('auth.password')}</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isSetup ? t('auth.passwordPlaceholderSetup') : t('auth.passwordPlaceholderLogin')}
              aria-invalid={attempted && !!passwordError}
            />
            {attempted && <FieldError error={passwordError} />}
          </div>
          {isSetup && codeRequired && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="auth-setup-code">{t('auth.setupCode')}</Label>
              <Input
                id="auth-setup-code"
                type="text"
                autoComplete="off"
                value={setupCode}
                onChange={e => setSetupCode(e.target.value)}
                placeholder={t('auth.setupCodePlaceholder')}
              />
              <p className="text-xs text-muted-foreground">{t('auth.setupCodeHint')}</p>
            </div>
          )}
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? (isSetup ? t('auth.creating') : t('auth.signingIn')) : isSetup ? t('auth.createAccount') : t('auth.signIn')}
          </Button>
        </form>
      </div>
    </Centered>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => apiFetch('/api/auth/status'),
    retry: false,
  })

  useEffect(() => {
    const handler = () => { refetch() }
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [refetch])

  function onAuthed() {
    // New session: drop any cached (unauthenticated) data and re-check status.
    queryClient.invalidateQueries()
    refetch()
  }

  if (isLoading) return <Centered><p className="text-sm text-muted-foreground text-center">{t('auth.loading')}</p></Centered>
  if (isError || !data) {
    return (
      <Centered>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('auth.serverUnreachableBefore')}<code className="font-mono">npm run dev</code>{t('auth.serverUnreachableAfter')}
        </div>
      </Centered>
    )
  }

  if (data.needsSetup) return <AuthForm mode="setup" onAuthed={onAuthed} />
  if (!data.authenticated) return <AuthForm mode="login" onAuthed={onAuthed} />

  return <>{children}</>
}
