import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

// Minimal localStorage stand-in for environments where jsdom/Node do not
// expose one (Node ≥22 gates it behind --localstorage-file).
if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  const store = {
    getItem: (k: string): string | null => backing.get(String(k)) ?? null,
    setItem: (k: string, v: string): void => void backing.set(String(k), String(v)),
    removeItem: (k: string): void => void backing.delete(String(k)),
    clear: (): void => void backing.clear(),
    key: (i: number): string | null => [...backing.keys()][i] ?? null,
    get length(): number {
      return backing.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
}
