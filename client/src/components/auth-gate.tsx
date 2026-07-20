import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, setToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isEmail } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

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
  const [showForgot, setShowForgot] = useState(false)

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

  if (showForgot && !isSetup) {
    return <ForgotPasswordForm onBack={() => setShowForgot(false)} />
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
        {!isSetup && (
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('auth.forgotPassword')}
          </button>
        )}
      </div>
    </Centered>
  )
}

// Forgot / Reset password flow

type ForgotStep = 'request' | 'reset' | 'done'

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [step, setStep] = useState<ForgotStep>('request')
  const [resetCode, setResetCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const passwordError = !newPassword
    ? t('validation.required')
    : newPassword.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : null
  const codeError = !resetCode.trim() ? t('validation.required') : null

  async function requestCode() {
    setBusy(true)
    setError('')
    try {
      await apiFetch('/api/auth/forgot-password', { method: 'POST' })
      setStep('reset')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    if (codeError || passwordError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ resetCode: resetCode.trim(), newPassword }),
      })
      setStep('done')
    } catch (err) {
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
        <h1 className="text-base font-medium">{t('auth.forgotPassword')}</h1>

        {step === 'request' && (
          <div className="mt-1 space-y-3">
            <p className="text-xs text-muted-foreground mb-4">{t('auth.forgotPasswordDescription')}</p>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button className="w-full" disabled={busy} onClick={requestCode}>
              {busy ? t('auth.requestingResetCode') : t('auth.requestResetCode')}
            </Button>
          </div>
        )}

        {step === 'reset' && (
          <form onSubmit={submitReset} className="space-y-3 mt-4" noValidate>
            <p className="text-xs text-muted-foreground">{t('auth.resetCodeHint')}</p>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-code">{t('auth.resetCode')}</Label>
              <Input
                id="reset-code"
                type="text"
                autoComplete="off"
                value={resetCode}
                onChange={e => setResetCode(e.target.value)}
                placeholder={t('auth.resetCodePlaceholder')}
                aria-invalid={attempted && !!codeError}
              />
              {attempted && <FieldError error={codeError} />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reset-new-password">{t('auth.newPassword')}</Label>
              <Input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t('auth.passwordPlaceholderSetup')}
                aria-invalid={attempted && !!passwordError}
              />
              {attempted && <FieldError error={passwordError} />}
            </div>
            {error && <p className="text-destructive text-xs">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t('auth.resettingPassword') : t('auth.resetPassword')}
            </Button>
          </form>
        )}

        {step === 'done' && (
          <p className="text-xs text-muted-foreground mt-1 mb-4">{t('auth.passwordReset')}</p>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('auth.backToLogin')}
        </button>
      </div>
    </Centered>
  )
}

// Change-credentials modal (rendered inside the authenticated shell)

interface ChangeCredentialsModalProps {
  mode: 'password' | 'email'
  onClose: () => void
}

export function ChangeCredentialsModal({ mode, onClose }: ChangeCredentialsModalProps) {
  const { t } = useI18n()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newValue, setNewValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const isPassword = mode === 'password'

  const newValueError = !newValue.trim()
    ? t('validation.required')
    : isPassword && newValue.length < PASSWORD_MIN
      ? t('validation.passwordMin', { min: PASSWORD_MIN })
      : !isPassword && !isEmail(newValue)
        ? t('validation.email')
        : null
  const currentPwError = !currentPassword ? t('validation.required') : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (newValueError || currentPwError) {
      setAttempted(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isPassword) {
        await apiFetch('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword: newValue }),
        })
        toast.success(t('auth.passwordChanged'))
      } else {
        await apiFetch('/api/auth/change-email', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newEmail: newValue }),
        })
        toast.success(t('auth.emailChanged'))
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-3xl border bg-card p-6 shadow-xl">
        <h2 className="text-base font-medium mb-1">
          {isPassword ? t('auth.changePassword') : t('auth.changeEmail')}
        </h2>
        <form onSubmit={submit} className="space-y-3 mt-4" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-current-password">{t('auth.currentPassword')}</Label>
            <Input
              id="cred-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholderLogin')}
              aria-invalid={attempted && !!currentPwError}
            />
            {attempted && <FieldError error={currentPwError} />}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="cred-new-value">
              {isPassword ? t('auth.newPassword') : t('auth.newEmail')}
            </Label>
            <Input
              id="cred-new-value"
              type={isPassword ? 'password' : 'email'}
              autoComplete={isPassword ? 'new-password' : 'email'}
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder={isPassword ? t('auth.passwordPlaceholderSetup') : t('auth.emailPlaceholder')}
              aria-invalid={attempted && !!newValueError}
            />
            {attempted && <FieldError error={newValueError} />}
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="flex-1" disabled={busy}>
              {busy
                ? (isPassword ? t('auth.changingPassword') : t('auth.changingEmail'))
                : t('common.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
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

