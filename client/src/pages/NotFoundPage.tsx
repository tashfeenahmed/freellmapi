import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// Catch-all route: before this, an unknown URL rendered the navbar over a
// silent empty page.
export default function NotFoundPage() {
  const { t } = useI18n()
  return (
    <div className="flex justify-center py-16">
      <div className="w-full max-w-md rounded-3xl border bg-card p-8 text-center">
        <Compass className="mx-auto size-8 text-muted-foreground" />
        <h1 className="mt-4 text-lg font-semibold">{t('notFound.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('notFound.description')}</p>
        <div className="mt-5">
          <Link to="/">
            <Button size="sm">{t('errors.goHome')}</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
