// Server-safe constants. NOT a client module. Imported from both
// ThemeProvider ('use client') and ThemeScript (server component
// rendered in <head>). Keeping these as plain exports here means
// Next.js inlines the actual string value when the server bundles
// the script tag, rather than serializing a client-reference proxy.
//
// Symptom if you accidentally import a 'use client' constant into a
// server component template literal: the bundled script ends up with
// `var k='function() { throw new Error("...client function...") }'`
// at runtime, breaking localStorage reads silently.
export const THEME_STORAGE_KEY = 'anima-theme'
