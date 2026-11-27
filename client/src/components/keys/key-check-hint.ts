import type { KeyCheckUnavailableReason } from '../../../../shared/types'

/** The i18n key that explains why a key is never checked automatically (#1545). */
export function noAutoCheckHintKey(reason: KeyCheckUnavailableReason | undefined): string {
  return reason === 'quota' ? 'keys.noAutoCheckQuotaHint' : 'keys.noAutoCheckHint'
}
