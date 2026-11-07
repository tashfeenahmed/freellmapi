// jsdom 27 does not implement Storage itself: it delegates window.localStorage
// and window.sessionStorage to Node's internal webstorage implementation.
// That returns `undefined` unless Node runs with --experimental-webstorage
// (and a --localstorage-file backing), so on Node versions where the flag has
// no effect for jsdom, every component test that touches localStorage dies
// with "Cannot read properties of undefined (reading 'setItem')".
//
// Install a minimal spec-shaped Storage whenever the native one is missing.
// When the native one exists we leave it completely alone, so CI on Node 20/22
// exercises exactly what it always has.
class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  key(index: number): string | null {
    const keys = [...this.map.keys()]
    return index >= 0 && index < keys.length ? keys[index] : null
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

function nativeStorageAvailable(name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    return typeof window[name] !== 'undefined' && window[name] !== null
  } catch {
    // jsdom throws SecurityError on opaque origins — treat as missing.
    return false
  }
}

// Plain node-environment files have no window at all — nothing to patch there.
if (typeof window !== 'undefined') {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (!nativeStorageAvailable(name)) {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        value: new MemoryStorage(),
      })
    }
  }
}
