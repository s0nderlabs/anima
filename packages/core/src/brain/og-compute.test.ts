import { describe, expect, it } from 'bun:test'
import { OGComputeBrain, detectBlockedToolError } from './og-compute'

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

describe('OGComputeBrain abort signal', () => {
  it('rejects with AbortError when signal is aborted before infer starts', async () => {
    // Use a real instance but DON'T call init() — the abort check fires
    // BEFORE init, so the broker connection is never opened.
    // Real-shape valid privkey (deterministic, well-known test fixture).
    const TEST_PK = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const brain = new OGComputeBrain({
      privkeyHex: TEST_PK as `0x${string}`,
      rpcUrl: 'https://does-not-matter',
      providerAddress: '0x0000000000000000000000000000000000000000',
      tools: [],
      prefix: {
        systemPrompt: 'test',
        memoryIndexText: null,
        identityText: null,
        personaText: null,
        skillIndexText: null,
        toolGuidance: [],
        appendText: null,
        envText: null,
        timestamp: null,
      },
    })
    // Manually flag as initialized so init() is skipped (we want to hit the
    // abort check, not the broker init network call).
    ;(brain as unknown as { broker: unknown }).broker = {}

    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      brain.infer({
        event: {
          id: 'test',
          source: 'stdin',
          payload: { label: 'user-message', data: 'hello' },
          ts: Date.now(),
        },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
