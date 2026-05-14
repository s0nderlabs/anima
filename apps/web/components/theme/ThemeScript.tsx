/**
 * Pre-hydration safety net for the cookie-less path. layout.tsx is the
 * primary FOUC defense — it server-renders `<html class="light|dark">`
 * from the theme cookie, so the first byte already carries the right
 * class. This script only does work when the cookie wasn't there (first
 * visit after the cookie code shipped, or cookie expired): it reads
 * localStorage, stamps the class, and injects an `<style>` that pins
 * every theme token on `:root` with `!important` until ThemeProvider's
 * useEffect re-stamps the class and writes the cookie. When the SSR
 * class is already present (the common case after first visit), this
 * script short-circuits to just arming the body transition gate.
 *
 *   IMPORTANT: token values must match globals.css `@theme` and
 *   `html.dark` blocks. If you add a new token there, mirror it here.
 */
import { THEME_STORAGE_KEY } from './constants'

const LIGHT_TOKENS = [
  '--color-cream:#f9f8f6',
  '--color-cream-deep:#f2f1ee',
  '--color-paper:#fbfbf9',
  '--color-cream-warm:#f0e8d6',
  '--color-ink:#100f09',
  '--color-ink-2:#525251',
  '--color-ink-3:#8b8b88',
  '--color-border:rgba(16,15,9,0.09)',
  '--color-border-strong:rgba(16,15,9,0.2)',
  '--rgb-cream:249 248 246',
  '--rgb-ink:16 15 9',
  '--rgb-shadow:60 50 30',
  '--rgb-shadow-strong:16 15 9',
  '--shadow-doc:0 30px 80px -40px rgba(70,50,30,0.35)',
  '--shadow-card:0 20px 50px -30px rgba(50,35,22,0.28)',
  '--shadow-doc-asym:18px 28px 60px -34px rgba(45,30,18,0.42)',
  '--tg-chat-bg:#dfe9d8',
  '--tg-header-bg:rgba(247,247,247,0.88)',
  '--tg-composer-bg:rgba(247,247,247,0.88)',
  '--tg-composer-input-bg:#fff',
  '--tg-composer-input-border:rgba(0,0,0,0.15)',
  '--tg-bubble-out-bg:#e1ffc7',
  '--tg-bubble-in-bg:#ffffff',
  '--tg-text:#000000',
  '--tg-text-muted:rgba(0,0,0,0.45)',
  '--tg-text-tool-tool:rgba(0,0,0,0.55)',
  '--tg-text-tool-colon:rgba(0,0,0,0.45)',
  '--tg-text-tool-args:rgba(0,0,0,0.7)',
  '--tg-text-tool-body:rgba(0,0,0,0.78)',
  '--tg-doodle-stroke:rgba(46,140,93,0.32)',
  '--tg-divider:rgba(0,0,0,0.1)',
  '--tg-name:#000000',
  '--tg-typing-dot:#8a8a8e',
  '--tg-check-blue:#4ea7e6',
  '--tg-accent:#007aff',
  '--tg-online:#3aa66e',
  '--tg-icon-muted:#8e8e93',
  '--tg-placeholder:#8a8a8e',
  '--tg-bubble-shadow:0 1px 1px rgba(0,0,0,0.07)',
].join(' !important;') + ' !important;'

const DARK_TOKENS = [
  '--color-cream:#0e0d0a',
  '--color-cream-deep:#161410',
  '--color-paper:#14120e',
  '--color-cream-warm:#1f1c14',
  '--color-ink:#efece3',
  '--color-ink-2:#a8a59e',
  '--color-ink-3:#6f6c65',
  '--color-border:rgba(239,236,227,0.1)',
  '--color-border-strong:rgba(239,236,227,0.22)',
  '--rgb-cream:14 13 10',
  '--rgb-ink:239 236 227',
  '--rgb-shadow:0 0 0',
  '--rgb-shadow-strong:0 0 0',
  '--shadow-doc:0 30px 80px -40px rgba(0,0,0,0.75)',
  '--shadow-card:0 20px 50px -30px rgba(0,0,0,0.7)',
  '--shadow-doc-asym:18px 28px 60px -34px rgba(0,0,0,0.78)',
  '--tg-chat-bg:#0e1621',
  '--tg-header-bg:rgba(23,33,43,0.92)',
  '--tg-composer-bg:rgba(23,33,43,0.92)',
  '--tg-composer-input-bg:#182533',
  '--tg-composer-input-border:rgba(255,255,255,0.06)',
  '--tg-bubble-out-bg:#3a6b8f',
  '--tg-bubble-in-bg:#182533',
  '--tg-text:#ffffff',
  '--tg-text-muted:rgba(255,255,255,0.55)',
  '--tg-text-tool-tool:rgba(255,255,255,0.7)',
  '--tg-text-tool-colon:rgba(255,255,255,0.5)',
  '--tg-text-tool-args:rgba(255,255,255,0.78)',
  '--tg-text-tool-body:rgba(255,255,255,0.85)',
  '--tg-doodle-stroke:rgba(120,200,160,0.16)',
  '--tg-divider:rgba(255,255,255,0.08)',
  '--tg-name:#ffffff',
  '--tg-typing-dot:#6e7681',
  '--tg-check-blue:#7cbaf0',
  '--tg-accent:#7cbaf0',
  '--tg-online:#5dd5b6',
  '--tg-icon-muted:#7d8b95',
  '--tg-placeholder:#7d8b95',
  '--tg-bubble-shadow:0 1px 2px rgba(0,0,0,0.45)',
].join(' !important;') + ' !important;'

const SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=localStorage.getItem(k);var explicit=s==='light'||s==='dark';var m=explicit?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var r=document.documentElement;var ssrOk=r.classList.contains(m);if(!ssrOk){if(explicit){r.classList.remove(m==='dark'?'light':'dark');r.classList.add(m);}r.style.colorScheme=m;var tokens=m==='dark'?${JSON.stringify(DARK_TOKENS)}:${JSON.stringify(LIGHT_TOKENS)};var bg=m==='dark'?'#0e0d0a':'#f9f8f6';var fg=m==='dark'?'#efece3':'#100f09';var st=document.createElement('style');st.id='__theme-init';st.textContent=':root{'+tokens+'}html,body{background-color:'+bg+' !important;color:'+fg+' !important;}';document.head.appendChild(st);}requestAnimationFrame(function(){r.setAttribute('data-theme-ready','1');});}catch(e){}})();`

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
}
