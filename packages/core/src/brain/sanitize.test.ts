import { describe, expect, it } from 'bun:test'
import { sanitizeDashes } from './sanitize'

describe('sanitizeDashes (v0.22.2 backstop)', () => {
  it('replaces em-dash with comma+space (preserving surrounding spaces)', () => {
    expect(sanitizeDashes('Denied — rm -rf blocked')).toBe('Denied ,  rm -rf blocked')
    expect(sanitizeDashes('text—more')).toBe('text, more')
  })
  it('replaces en-dash with ASCII hyphen', () => {
    expect(sanitizeDashes('range 3–5')).toBe('range 3-5')
    expect(sanitizeDashes('2026–2027')).toBe('2026-2027')
  })
  it('passes plain ASCII text untouched', () => {
    expect(sanitizeDashes('hello world')).toBe('hello world')
    expect(sanitizeDashes('use rm -rf carefully')).toBe('use rm -rf carefully')
  })
  it('handles empty + null-ish', () => {
    expect(sanitizeDashes('')).toBe('')
  })
  it('strips all em-dashes and en-dashes from prose-heavy input', () => {
    const result = sanitizeDashes('A — B – C — D')
    expect(result).not.toMatch(/[—–]/)
    expect(result.startsWith('A')).toBe(true)
    expect(result.endsWith('D')).toBe(true)
    expect(result).toContain('B - C')
  })
})
