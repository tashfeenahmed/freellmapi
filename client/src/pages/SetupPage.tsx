import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useAuthStatus, useSetup } from '@/lib/auth'
import { passwordStrength, validatePasswordPolicy, validateUsername } from '@/lib/account-validation'
import { AuthPageShell } from '@/components/auth-page-shell'

export default function SetupPage() {
  const { data: status, isLoading: statusLoading, isError: statusError } = useAuthStatus()
  const setup = useSetup()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

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
          <p className="text-sm text-destructive">Could not load setup status.</p>
        </div>
      </AuthPageShell>
    )
  }
  if (!status.setupRequired) {
    return <Navigate to="/login" replace />
  }

  const strength = passwordStrength(password)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError(null)
    const uErr = validateUsername(username)
    if (uErr) {
      setLocalError(uErr)
      return
    }
    const pErr = validatePasswordPolicy(password)
    if (pErr) {
      setLocalError(pErr)
      return
    }
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match.')
      return
    }
    setup.mutate(
      { username, password, confirmPassword },
      {
        onError: (err) => {
          setLocalError(err instanceof Error ? err.message : 'Setup failed')
        },
      }
    )
  }

  return (
    <AuthPageShell>
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-lg">Create super-admin</CardTitle>
            <CardDescription>
              First-time setup. This account will manage the instance. Use a username or an email as the
              sign-in, choose a strong password, and store it safely.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="space-y-2">
                <Label htmlFor="setup-user">Email or username</Label>
                <Input
                  id="setup-user"
                  name="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-pass">Password</Label>
                <Input
                  id="setup-pass"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  <span className={strength.length ? 'text-foreground' : ''}>10+ characters</span>
                  {' · '}
                  <span className={strength.letter ? 'text-foreground' : ''}>a letter</span>
                  {' · '}
                  <span className={strength.number ? 'text-foreground' : ''}>a number</span>
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-confirm">Confirm password</Label>
                <Input
                  id="setup-confirm"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              {(localError || setup.isError) && (
                <p className="text-sm text-destructive" role="alert">
                  {localError ?? (setup.error instanceof Error ? setup.error.message : 'Error')}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={setup.isPending}>
                {setup.isPending ? 'Creating account…' : 'Create & continue'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AuthPageShell>
  )
}
