/**
 * Backstop sanitizer for brain output.
 *
 * The frozen-prefix system prompt forbids em-dashes (U+2014) and en-dashes
 * (U+2013). Weak models (qwen3.6-plus, anima's flagship) occasionally slip
 * despite the rule. This sanitizer is the final filter on brain output,
 * applied at the single brain return point in og-compute.ts so every
 * surface (TUI, TG, A2A, market) sees clean text.
 *
 * Replacements were chosen to preserve readability with minimal punctuation
 * disruption:
 *   - U+2014 em-dash → comma + space ("X — Y" → "X, Y")
 *   - U+2013 en-dash → ASCII hyphen ("3–5" → "3-5")
 *
 * Stand-alone hyphen-substitution avoids accidentally turning a number
 * range into prose-only ("3 to 5" feels heavy-handed in code/numeric
 * contexts), while comma substitution for em-dash keeps the prose rhythm
 * the model intended.
 */
export function sanitizeDashes(text: string): string {
  if (!text) return text
  return text.replace(/—/g, ', ').replace(/–/g, '-')
}
