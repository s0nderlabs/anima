import { describe, expect, it } from 'bun:test'
import { detectBlockedToolError } from './og-compute'

describe('detectBlockedToolError (qwen safety-filter recovery)', () => {
  it('matches the canonical broker error string', () => {
    const content =
      'An error occurred while generating a tool call: Unauthorized: browser is a blocked tool.'
    expect(detectBlockedToolError(content)).toBe('browser')
  })

  it('matches without the leading prefix', () => {
    expect(detectBlockedToolError('Unauthorized: shell is a blocked tool.')).toBe('shell')
  })

  it('returns null for normal assistant content', () => {
    expect(detectBlockedToolError('The first result is "Wikipedia: HTTP".')).toBe(null)
    expect(detectBlockedToolError('')).toBe(null)
    expect(detectBlockedToolError('I called browser.snapshot and got the page.')).toBe(null)
  })

  it('returns null for similar-looking but non-matching strings', () => {
    expect(detectBlockedToolError('Unauthorized request')).toBe(null)
    expect(detectBlockedToolError('blocked tool: browser')).toBe(null)
  })
})
