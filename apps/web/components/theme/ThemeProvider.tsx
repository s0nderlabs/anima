'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

type ThemeContextValue = {
  theme: ThemeMode
  resolved: ResolvedTheme
  setTheme: (next: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export const THEME_STORAGE_KEY = 'anima-theme'

function systemPrefersDark() {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readStored(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

function applyDocumentTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // Only stamp an explicit class when the user has made an explicit
  // choice. In 'system' mode we leave both classes off so the CSS
  // `@media (prefers-color-scheme: dark)` rule drives the swap, which
  // is what eliminates the FOUC on dark-OS visitors with no stored pick.
  if (theme === 'light') {
    root.classList.add('light')
    root.classList.remove('dark')
  } else if (theme === 'dark') {
    root.classList.add('dark')
    root.classList.remove('light')
  } else {
    root.classList.remove('dark')
    root.classList.remove('light')
  }
  root.style.colorScheme = resolveTheme(theme)
  // React 19 hydration can drop the data-theme-ready attribute the
  // pre-hydration script set. Re-stamp so globals.css's body-transition
  // gate stays armed.
  root.setAttribute('data-theme-ready', '1')
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize with 'system' so server + client first render agree. The
  // pre-hydration inline script has already applied the right class to
  // <html> before paint, so we just re-sync state from localStorage on
  // mount.
  const [theme, setThemeState] = useState<ThemeMode>('system')
  const [resolved, setResolved] = useState<ResolvedTheme>('light')

  useEffect(() => {
    const stored = readStored()
    setThemeState(stored)
    setResolved(resolveTheme(stored))
    applyDocumentTheme(stored)
  }, [])

  // Track system preference while theme === 'system'. Detaches when
  // user picks an explicit value.
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setResolved(e.matches ? 'dark' : 'light')
      applyDocumentTheme('system')
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [theme])

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    }
    setResolved(resolveTheme(next))
    applyDocumentTheme(next)
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
