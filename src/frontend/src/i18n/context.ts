import { createContext, useContext } from 'react'
import { DEFAULT_LOCALE, type Locale } from './locale-config'

export interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

export const I18nContext = createContext<I18nContextValue | null>(null)

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) {
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: key => key,
    }
  }
  return context
}
