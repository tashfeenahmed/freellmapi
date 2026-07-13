import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom (esp. v26) doesn't always expose a functional window.localStorage.
// Components read/write it (i18n locale, auth token), so provide a minimal
// in-memory implementation that behaves like the real Storage API.
if (!window.localStorage || typeof window.localStorage.getItem !== 'function') {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    value: {
      get length() {
        return store.size
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v))
      },
      removeItem: (k: string) => {
        store.delete(k)
      },
      clear: () => store.clear(),
    },
    writable: true,
    configurable: true,
  })
}

// Reset the DOM and any module-level fetch mock between tests.
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// jsdom doesn't implement matchMedia (App uses it for dark-mode pref) —
// provide a permissive stub so component mounts don't throw.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
