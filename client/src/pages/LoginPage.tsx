import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useAuthStatus, useLogin } from '@/lib/auth'
import { validateUsername } from '@/lib/account-validation'
import { AuthPageShell } from '@/components/auth-page-shell'

type LocationState = { from?: { pathname?: string } } | null

export default function LoginPage() {
  const { data: status, isLoading: statusLoading, isError: statusError } = useAuthStatus()
  const login = useLogin()
  const location = useLocation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const from = (location.state as LocationState)?.from?.pathname

  if (statusLoading) {
    return (
      <AuthPageShell>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </AuthPageShell>
    )
  }
  if (statusError || !status) {
    return (
      <AuthPageShell>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-destructive">Could not load status.</p>
        </div>
      </AuthPageShell>
    )
  }
  if (status.setupRequired) {
    return <Navigate to="/setup" replace />
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError(null)
    const uErr = validateUsername(username)
    if (uErr) {
      setLocalError(uErr)
      return
    }
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          navigate(from && from !== '/login' ? from : '/playground', { replace: true })
        },
        onError: (err) => {
          setLocalError(err instanceof Error ? err.message : 'Sign-in failed')
        },
      }
    )
  }

  return (
    <AuthPageShell>
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>Enter your email or username and password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="space-y-2">
                <Label htmlFor="login-user">Email or username</Label>
                <Input
                  id="login-user"
                  name="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-pass">Password</Label>
                <Input
                  id="login-pass"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {(localError || login.isError) && (
                <p className="text-sm text-destructive" role="alert">
                  {localError ?? (login.error instanceof Error ? login.error.message : 'Error')}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={login.isPending}>
                {login.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AuthPageShell>
  )
}
