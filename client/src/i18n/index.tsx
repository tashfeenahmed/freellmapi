import { createContext, useContext, useMemo, type ReactNode } from 'react'
import en from './locales/en.json'

type MessageTree = Record<string, unknown>

const I18nContext = createContext<typeof en>(en)

function lookup(obj: MessageTree, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as MessageTree)[key]
  }, obj)
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const value = params[key]
    return value == null ? '' : String(value)
  })
}

export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={en}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const dict = useContext(I18nContext)
  return useMemo(() => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const value = lookup(dict as MessageTree, key)
      if (typeof value === 'string') return format(value, params)
      return key
    },
  }), [dict])
}
