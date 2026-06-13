import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

/**
 * Compact language toggle for the dashboard top bar. Shows the *other*
 * locale's short tag (中 when English is active, EN when Chinese is active)
 * so the button advertises what tapping it will do.
 */
export function LanguageToggle() {
  const { locale, toggleLocale, t } = useI18n()
  const next = locale === 'en' ? 'zh-CN' : 'en'
  const label = next === 'zh-CN' ? t('nav.switchToChinese') : t('nav.switchToEnglish')

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLocale}
      aria-label={t('nav.language')}
      title={label}
      className="gap-1.5 px-2.5"
    >
      <Languages className="size-4" />
      <span className="text-xs font-medium uppercase tracking-wide">
        {locale === 'en' ? '中' : 'EN'}
      </span>
    </Button>
  )
}
