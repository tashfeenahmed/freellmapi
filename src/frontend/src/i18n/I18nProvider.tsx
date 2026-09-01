/**
 * Lightweight, lazy-loaded i18n for the dashboard.
 *
 * English stays in the initial bundle as the always-available fallback. Vite
 * discovers every other JSON dictionary at build time and emits one chunk per
 * locale; switching locale loads only that dictionary.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import en from './locales/en.json'
import { I18nContext, type I18nContextValue } from './context'
import {
  DEFAULT_LOCALE,
  RTL_LOCALES,
  SUPPORTED_LOCALES,
  type Locale,
} from './locale-config'
const supportedLocaleSet = new Set<string>(SUPPORTED_LOCALES)
const supportedByLowerCase = new Map(
  SUPPORTED_LOCALES.map(locale => [locale.toLowerCase(), locale]),
)

function matchBrowserLocale(browserLocale: string): Locale | null {
  const normalized = browserLocale.replace('_', '-').toLowerCase()
  const exact = supportedByLowerCase.get(normalized)
  if (exact) return exact

  const [primary, regionOrScript] = normalized.split('-')
  if (primary === 'zh') {
    return regionOrScript === 'tw'
      || regionOrScript === 'hk'
      || regionOrScript === 'mo'
      || regionOrScript === 'hant'
      ? 'zh-TW'
      : 'zh-CN'
  }
  if (primary === 'pt') return regionOrScript === 'pt' ? 'pt-PT' : 'pt-BR'
  // Browsers report Norwegian as nb/nn and Filipino as fil; snap those to
  // our nearest dictionaries.
  if (primary === 'nb' || primary === 'nn') return 'no'
  if (primary === 'fil') return 'tl'

  return supportedByLowerCase.get(primary) ?? null
}

function detectLocale(): Locale {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return DEFAULT_LOCALE
  }

  const stored = window.localStorage.getItem('freellmapi.locale')
  if (stored && supportedLocaleSet.has(stored)) return stored as Locale

  const legacyLanguage = (navigator as { userLanguage?: string }).userLanguage
  const browserLocales = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || legacyLanguage || '']

  for (const browserLocale of browserLocales) {
    const match = matchBrowserLocale(browserLocale)
    if (match) return match
  }
  return DEFAULT_LOCALE
}

type Dictionary = Record<string, unknown>
type LocaleLoader = () => Promise<Dictionary>

const localeModules = import.meta.glob<Dictionary>(
  ['./locales/*.json', '!./locales/en.json'],
  { import: 'default' },
)
const localeLoaders = Object.fromEntries(
  Object.entries(localeModules).map(([path, loader]) => {
    const locale = path.match(/\/([^/]+)\.json$/)?.[1]
    return [locale, loader]
  }),
) as Partial<Record<Locale, LocaleLoader>>
const loadedDictionaries: Partial<Record<Locale, Dictionary>> = {
  en: en as Dictionary,
}

function lookup(dictionary: Dictionary, key: string): unknown {
  const segments = key.split('.')
  let current: unknown = dictionary
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as Dictionary)) {
      current = (current as Dictionary)[segment]
    } else {
      return undefined
    }
  }
  return current
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name]
    return value === undefined || value === null ? `{${name}}` : String(value)
  })
}

export interface I18nProviderProps {
  children: ReactNode
  initialLocale?: Locale
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectLocale())
  const [dictionary, setDictionary] = useState<Dictionary>(
    () => loadedDictionaries[initialLocale ?? DEFAULT_LOCALE] ?? (en as Dictionary),
  )

  useEffect(() => {
    window.localStorage.setItem('freellmapi.locale', locale)
    document.documentElement.lang = locale
    document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
  }, [locale])

  useEffect(() => {
    const load = localeLoaders[locale]
    if (!load) return

    let active = true
    void load()
      .then(nextDictionary => {
        loadedDictionaries[locale] = nextDictionary
        if (active) setDictionary(nextDictionary)
      })
      .catch(error => {
        console.error(`Failed to load locale "${locale}"`, error)
      })
    return () => {
      active = false
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    if (!supportedLocaleSet.has(next)) return
    setLocaleState(next)
    const loaded = loadedDictionaries[next]
    if (loaded) setDictionary(loaded)
  }, [])

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (key, vars) => {
      const raw = lookup(dictionary, key)
      if (typeof raw === 'string') return interpolate(raw, vars)
      const fallback = lookup(en as Dictionary, key)
      if (typeof fallback === 'string') return interpolate(fallback, vars)
      return key
    },
  }), [dictionary, locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
