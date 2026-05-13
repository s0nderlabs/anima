/**
 * Pre-hydration theme script. Stamps an explicit `dark` or `light`
 * class on <html> before paint so user-explicit choices override the
 * `@media (prefers-color-scheme)` fallback in globals.css.
 *
 * For 'system' (or first-visit) it leaves both classes off and lets
 * the media query drive — that's what eliminates the FOUC on dark-OS
 * visitors without needing JS at all.
 *
 * `data-theme-ready=1` flips on the body's bg/color transition (gated
 * in globals.css) so the very first paint never animates.
 */
import { THEME_STORAGE_KEY } from './ThemeProvider'

const SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=localStorage.getItem(k);var explicit=s==='light'||s==='dark';var m=explicit?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var r=document.documentElement;if(explicit)r.classList.add(m);r.style.colorScheme=m;requestAnimationFrame(function(){r.setAttribute('data-theme-ready','1');});}catch(e){}})();`

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
}
