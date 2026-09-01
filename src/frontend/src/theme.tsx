import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ThemeContext, type Theme } from '@/theme-context'

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem('theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

function getSystemDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)
  const [systemDark, setSystemDark] = useState(getSystemDark)
  const resolvedDark = theme === 'system' ? systemDark : theme === 'dark'

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = (event: MediaQueryListEvent) => setSystemDark(event.matches)

    media.addEventListener('change', syncSystemTheme)
    return () => media.removeEventListener('change', syncSystemTheme)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('theme', theme)
    // The desktop preload mirrors this attribute to the Electron main process
    // so nativeTheme.themeSource can follow a 'system' choice for real.
    document.documentElement.dataset.themeChoice = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedDark)
    document.documentElement.style.colorScheme = resolvedDark ? 'dark' : 'light'
  }, [resolvedDark])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
  }, [])

  const value = useMemo(
    () => ({ theme, setTheme, resolvedDark }),
    [resolvedDark, setTheme, theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
