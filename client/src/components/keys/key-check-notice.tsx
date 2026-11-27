import { CircleAlert, Info } from 'lucide-react'
import type { KeyCheckUnavailableReason } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { noAutoCheckHintKey } from './key-check-hint'

interface KeyCheckNoticeProps {
  /** False for a provider whose keys are never probed (#1459). */
  autoHealthCheck?: boolean
  keyCheckUnavailable?: KeyCheckUnavailableReason
  status: string
  lastHealthError: string | null | undefined
  modelsAvailable?: number
}

/**
 * The line under a key row that explains its check state. A provider that is
 * never probed has unknown validity, which is not a fault: it gets grey
 * information, never the red error line, even if an older release stored its
 * "no validation endpoint" message as the key's last error (#1545). A real
 * probe failure on any other provider keeps the red line.
 */
export function KeyCheckNotice({ autoHealthCheck, keyCheckUnavailable, status, lastHealthError, modelsAvailable }: KeyCheckNoticeProps) {
  const { t } = useI18n()
  if (autoHealthCheck === false) {
    if (status !== 'unknown') return null
    return (
      <div className="flex items-start gap-2 px-4 pb-3 pl-8 text-xs text-muted-foreground" role="status">
        <Info className="mt-0.5 size-3.5 flex-shrink-0" />
        <span>
          {t(noAutoCheckHintKey(keyCheckUnavailable))}
          {modelsAvailable === 0 && <> {t('keys.noModelsYetHint')}</>}
        </span>
      </div>
    )
  }
  if (!lastHealthError) return null
  return (
    <div className="flex items-start gap-2 px-4 pb-3 pl-8 text-xs text-destructive" role="status">
      <CircleAlert className="mt-0.5 size-3.5 flex-shrink-0" />
      <span className="break-words" title={lastHealthError}>{lastHealthError}</span>
    </div>
  )
}
