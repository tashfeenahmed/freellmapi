import '@testing-library/jest-dom/vitest'
import * as matchers from '@testing-library/jest-dom/matchers'
import { expect, afterEach, vi } from 'vitest'
expect.extend(matchers)
import { cleanup } from '@testing-library/react'

// jsdom (esp. v26) doesn't always expose a functional window.localStorage.
// Components read/write it (i18n locale, auth token), so provide a minimal
// in-memory implementation that behaves like the real Storage API.
// This setup file is loaded for every suite, including the plain-TypeScript
// node-environment ones (most of lib/ and pages/). DOM-only shims must be
// skipped when there is no window, or those suites die at setup time.
if (typeof window !== 'undefined' && (!window.localStorage || typeof window.localStorage.getItem !== 'function')) {
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
  if (typeof window !== 'undefined') cleanup()
  vi.restoreAllMocks()
})

// jsdom doesn't implement matchMedia (App uses it for dark-mode pref) —
// provide a permissive stub so component mounts don't throw.
if (typeof window !== 'undefined' && !window.matchMedia) {
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

// @base-ui/react's Switch (and other pointer-based primitives) construct a
// PointerEvent on click; jsdom doesn't ship one. Provide a minimal subclass of
// MouseEvent so switch toggles work in tests.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number
    pointerType: string
    isPrimary: boolean
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
      this.pointerType = params.pointerType ?? 'mouse'
      this.isPrimary = params.isPrimary ?? true
    }
  }
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    writable: true,
    configurable: true,
  })
}
