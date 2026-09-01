import { Component, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// Route-level error boundary: a render throw inside a page shows a friendly
// crash card instead of white-screening the whole app. Keyed by pathname in
// App.tsx, so navigating away from the crashed page automatically resets it.
interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[dashboard] page crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}

// Functional child so it can use the i18n hook (the class itself cannot).
function CrashScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex justify-center py-16">
      <div className="w-full max-w-md rounded-3xl border bg-card p-8 text-center">
        <CircleAlert className="mx-auto size-8 text-destructive" />
        <h1 className="mt-4 text-lg font-semibold">{t('errors.boundaryTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('errors.boundaryDescription')}</p>
        {error.message && (
          <code className="mt-3 block truncate rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground" title={error.message}>
            {error.message}
          </code>
        )}
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>{t('errors.tryAgain')}</Button>
          <Link to="/" onClick={onRetry}>
            <Button size="sm">{t('errors.goHome')}</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
