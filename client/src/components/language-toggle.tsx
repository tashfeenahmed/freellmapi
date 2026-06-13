import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { setLocale } from '@/i18n'

export function LanguageToggle() {
  const { i18n, t } = useTranslation()
  const current = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium hover:bg-muted transition-colors"
        aria-label={t('common.language')}
      >
        <Languages className="size-4" />
        <span className="text-xs tabular-nums">{current === 'zh-CN' ? '中文' : 'EN'}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => setLocale('en')}
          className={current === 'en' ? 'bg-accent text-accent-foreground font-medium' : undefined}
        >
          English
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setLocale('zh-CN')}
          className={current === 'zh-CN' ? 'bg-accent text-accent-foreground font-medium' : undefined}
        >
          简体中文
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
