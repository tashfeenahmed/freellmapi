import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

const STORAGE_KEY = 'locale'

function getInitialLocale(): string {
  if (typeof window === 'undefined') return 'en'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'zh-CN') return stored
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh-CN'
  return 'en'
}

const initialLocale = getInitialLocale()
document.documentElement.lang = initialLocale === 'zh-CN' ? 'zh-CN' : 'en'

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
  },
  lng: initialLocale,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLocale(locale: 'en' | 'zh-CN') {
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
  void i18n.changeLanguage(locale)
}

export default i18n
