import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './en.json'
import zh from './zh.json'

const defaultLang = 'en'

function getStoredLang(): string | null {
  try {
    return localStorage.getItem('freellmapi_lang')
  } catch {
    return null
  }
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    lng: getStoredLang() ?? defaultLang,
    fallbackLng: defaultLang,
    interpolation: {
      escapeValue: false, // React already safe
    },
    defaultNS: 'translation',
  })

export function setLanguage(lang: string): void {
  i18n.changeLanguage(lang)
  try {
    localStorage.setItem('freellmapi_lang', lang)
  } catch {
    /* ignore */
  }
}

export function getLanguage(): string {
  return i18n.language
}

export default i18n
