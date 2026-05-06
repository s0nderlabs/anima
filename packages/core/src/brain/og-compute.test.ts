import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_CHANNEL_KEY,
  DEFAULT_MAX_OUTPUT_TOKENS,
  OGComputeBrain,
  detectBlockedToolError,
  looksLikeValidJsonString,
  stripThinkBlocks,
} from './og-compute'
import type { BrainMessage } from './types'

const TEST_PK = '0x1111111111111111111111111111111111111111111111111111111111111111'
const NO_PREFIX = {
  systemPrompt: 'test',
  memoryIndexText: null,
  identityText: null,
  personaText: null,
  skillIndexText: null,
  toolGuidance: [],
  appendText: null,
  envText: null,
  timestamp: null,
}

function makeBrain(opts: { history?: BrainMessage[] } = {}): OGComputeBrain {
  return new OGComputeBrain({
    privkeyHex: TEST_PK as `0x${string}`,
    rpcUrl: 'https://does-not-matter',
    providerAddress: '0x0000000000000000000000000000000000000000',
    tools: [],
    prefix: NO_PREFIX,
    history: opts.history,
  })
}

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
    const brain = makeBrain()
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

describe('OGComputeBrain channel-keyed history', () => {
  it('seeds default channel from constructor opts.history', () => {
    const seed: BrainMessage[] = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old2' },
    ]
    const brain = makeBrain({ history: seed })
    expect(brain.getChannelHistory(DEFAULT_CHANNEL_KEY)).toEqual(seed)
  })

  it('returns empty for unseen channels', () => {
    const brain = makeBrain()
    expect(brain.getChannelHistory('tui:stdin')).toEqual([])
    expect(brain.getChannelHistory('agent:specter:tg:dm:42')).toEqual([])
  })

  it('setChannelHistory partitions per key', () => {
    const brain = makeBrain()
    brain.setChannelHistory('tui:stdin', [{ role: 'user', content: 'A' }])
    brain.setChannelHistory('agent:specter:tg:dm:42', [{ role: 'user', content: 'B' }])
    expect(brain.getChannelHistory('tui:stdin')).toEqual([{ role: 'user', content: 'A' }])
    expect(brain.getChannelHistory('agent:specter:tg:dm:42')).toEqual([
      { role: 'user', content: 'B' },
    ])
  })

  it('clearChannel only clears the named channel', async () => {
    const brain = makeBrain()
    brain.setChannelHistory('tui:stdin', [{ role: 'user', content: 'A' }])
    brain.setChannelHistory('tg', [{ role: 'user', content: 'B' }])
    await brain.clearChannel('tui:stdin')
    expect(brain.getChannelHistory('tui:stdin')).toEqual([])
    expect(brain.getChannelHistory('tg')).toEqual([{ role: 'user', content: 'B' }])
  })

  it('listChannels enumerates non-empty channels', () => {
    const brain = makeBrain()
    expect(brain.listChannels()).toEqual([])
    brain.setChannelHistory('tui:stdin', [{ role: 'user', content: 'A' }])
    brain.setChannelHistory('tg', [{ role: 'user', content: 'B' }])
    expect(brain.listChannels().sort()).toEqual(['tg', 'tui:stdin'])
  })

  it('getChannelHistory returns a defensive copy', () => {
    const brain = makeBrain()
    brain.setChannelHistory('tui:stdin', [{ role: 'user', content: 'A' }])
    const snapshot = brain.getChannelHistory('tui:stdin') as BrainMessage[]
    snapshot.push({ role: 'user', content: 'mutated' })
    expect(brain.getChannelHistory('tui:stdin').length).toBe(1)
  })
})

describe('OGComputeBrain config defaults', () => {
  it('exposes DEFAULT_MAX_OUTPUT_TOKENS at 4096', () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096)
  })

  it('exposes DEFAULT_CHANNEL_KEY as "default"', () => {
    expect(DEFAULT_CHANNEL_KEY).toBe('default')
  })
})

describe('looksLikeValidJsonString (malformed tool_call args guard)', () => {
  it('accepts valid JSON object string', () => {
    expect(looksLikeValidJsonString('{"query":"x"}')).toBe(true)
  })

  it('accepts valid JSON array string', () => {
    expect(looksLikeValidJsonString('[1,2,3]')).toBe(true)
  })

  it('accepts empty string (no args)', () => {
    expect(looksLikeValidJsonString('')).toBe(true)
  })

  it('rejects truncated object (the May 6 enigma case)', () => {
    expect(looksLikeValidJsonString('{"query": "browser navigate"')).toBe(false)
  })

  it('rejects truncated array', () => {
    expect(looksLikeValidJsonString('[1,2,')).toBe(false)
  })

  it('rejects unbalanced braces', () => {
    expect(looksLikeValidJsonString('{"a":{"b":1}')).toBe(false)
  })
})

describe('stripThinkBlocks (Qwen reasoning_content fallback)', () => {
  it('strips a single think block', () => {
    expect(stripThinkBlocks('<think>thinking out loud</think>actual answer')).toBe('actual answer')
  })

  it('strips multiple think blocks', () => {
    expect(stripThinkBlocks('<think>a</think>x<think>b</think>y')).toBe('xy')
  })

  it('strips multiline think blocks', () => {
    expect(stripThinkBlocks('<think>\nline1\nline2\n</think>\nanswer here')).toBe('answer here')
  })

  it('returns plain text untouched', () => {
    expect(stripThinkBlocks('plain text answer')).toBe('plain text answer')
  })

  it('handles empty input', () => {
    expect(stripThinkBlocks('')).toBe('')
  })

  it('strips even when nothing follows the think block', () => {
    expect(stripThinkBlocks('<think>only thinking, no answer</think>')).toBe('')
  })
})
