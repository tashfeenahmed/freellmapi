/**
 * Lightweight i18n for the dashboard.
 *
 * - Zero external dependencies (no react-i18next, no Intl polyfills)
 * - Locale data is imported as JSON (en, zh-CN) — adding a new locale is a
 *   single file under `locales/` plus a registration in `LOCALES` below.
 * - Locale preference is persisted in `localStorage` under
 *   `freellmapi.locale` and falls back to `navigator.language` on first visit
 *   (snapped to the closest supported locale).
 * - The provider re-renders synchronously on `setLocale`, so all `t()` calls
 *   pick up the new strings without page reload.
 *
 * Translation keys use dot notation, e.g. `nav.models` or `premium.renewsOn`.
 * `t()` does a single dotted lookup; unknown keys return the key itself
 * rather than throwing, so partial translations degrade gracefully.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import fr from './locales/fr.json'
import es from './locales/es.json'
import ptBR from './locales/pt-BR.json'
import it from './locales/it.json'

export const SUPPORTED_LOCALES = ['en', 'zh-CN', 'fr', 'es', 'pt-BR', 'it'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

// `navigator.language` returns values like `zh`, `zh-CN`, `fr-CA`, `pt-BR`,
// `es-419`, `en-US`. We snap to the closest supported locale (match on the
// primary subtag) so first-visit detection is forgiving — e.g. a `zh-Hans`
// browser still gets our `zh-CN` strings and a `pt-PT` browser gets `pt-BR`.
function detectLocale(): Locale {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return DEFAULT_LOCALE
  }
  const stored = window.localStorage.getItem('freellmapi.locale')
  if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
    return stored as Locale
  }
  const nav = navigator.language || (navigator as { userLanguage?: string }).userLanguage || ''
  const lower = nav.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('pt')) return 'pt-BR'
  if (lower.startsWith('fr')) return 'fr'
  if (lower.startsWith('es')) return 'es'
  if (lower.startsWith('it')) return 'it'
  if (lower.startsWith('en')) return 'en'
  return DEFAULT_LOCALE
}

type Dictionary = Record<string, unknown>

const dictionaries: Record<Locale, Dictionary> = {
  en: en as Dictionary,
  'zh-CN': zhCN as Dictionary,
  fr: fr as Dictionary,
  es: es as Dictionary,
  'pt-BR': ptBR as Dictionary,
  it: it as Dictionary,
}

function lookup(dict: Dictionary, key: string): unknown {
  // Walk the dot path; return the literal key when a segment is missing so
  // the UI never blanks out for an untranslated string.
  const segments = key.split('.')
  let cur: unknown = dict
  for (const seg of segments) {
    if (cur && typeof cur === 'object' && seg in (cur as Dictionary)) {
      cur = (cur as Dictionary)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name]
    return v === undefined || v === null ? `{${name}}` : String(v)
  })
}

interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  /** Cycle to the next supported locale. Handy for a toggle button. */
  toggleLocale: () => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export interface I18nProviderProps {
  children: ReactNode
  /** Optional override for tests; defaults to the detector. */
  initialLocale?: Locale
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectLocale())

  // Persist + keep <html lang> in sync so screen readers and CSS `:lang()` rules
  // see the right language attribute.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('freellmapi.locale', locale)
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(next)) {
      setLocaleState(next)
    }
  }, [])

  const toggleLocale = useCallback(() => {
    setLocaleState((cur) => {
      const i = SUPPORTED_LOCALES.indexOf(cur)
      return SUPPORTED_LOCALES[(i + 1) % SUPPORTED_LOCALES.length]
    })
  }, [])

  const value = useMemo<I18nContextValue>(() => {
    const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]
    return {
      locale,
      setLocale,
      toggleLocale,
      t: (key, vars) => {
        const raw = lookup(dict, key)
        if (typeof raw === 'string') return interpolate(raw, vars)
        // Fallback to English so a partial zh-CN still renders something.
        const fallback = lookup(dictionaries[DEFAULT_LOCALE], key)
        if (typeof fallback === 'string') return interpolate(fallback, vars)
        return key
      },
    }
  }, [locale, setLocale, toggleLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // Safe default so components used outside the provider (e.g. in tests)
    // don't throw — they just render the key strings.
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      toggleLocale: () => {},
      t: (key) => key,
    }
  }
  return ctx
}
