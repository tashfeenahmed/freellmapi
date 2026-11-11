import { CircleAlert, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function ApinexCheckinNotice({ disabled, resuming, onResume }: {
  disabled: boolean
  resuming: boolean
  onResume: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 pl-8 text-xs" role="status">
      <CircleAlert className="size-3.5 flex-shrink-0 text-amber-600" />
      <span className="flex-1 min-w-[210px]">{t('keys.apinexCheckinRequired')}</span>
      <a href="https://apinex.bond/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
        {t('keys.openApinex')} <ExternalLink className="size-3" />
      </a>
      <Button size="xs" variant="outline" disabled={disabled} onClick={onResume}>
        {t(resuming ? 'keys.resumingKey' : 'keys.resumeKey')}
      </Button>
    </div>
  )
}
