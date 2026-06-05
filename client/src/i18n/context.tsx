import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import en from './en';
import zh from './zh';
import type { Translations } from './en';

type Locale = 'en' | 'zh';

const translations: Record<Locale, Translations> = { en, zh };
const LOCALE_KEY = 'freellmapi_locale';

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'zh') return 'zh';
  } catch { /* ignore */ }
  // Also check browser preference
  if (typeof navigator !== 'undefined' && navigator.language?.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

type NestedRecord = Record<string, unknown>;

function resolve(obj: NestedRecord, path: string): string {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return path;
    current = (current as NestedRecord)[key];
  }
  return typeof current === 'string' ? current : path;
}

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try { localStorage.setItem(LOCALE_KEY, next); } catch { /* ignore */ }
    // Update html lang attribute
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }, []);

  // Set initial lang attribute
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const t = useCallback((key: string, vars?: Record<string, string | number>): string => {
    const dict = translations[locale] as NestedRecord;
    let result = resolve(dict, key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return result;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextType {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
}

export { type Locale };
