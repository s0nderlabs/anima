import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_COMPACTION_OPTS,
  SUMMARY_SYSTEM_PROMPT,
  compactHistory,
  estimateTokens,
  shouldCompact,
} from './compaction'
import type { BrainMessage } from './types'

const u = (content: string): BrainMessage => ({ role: 'user', content })
const a = (content: string): BrainMessage => ({ role: 'assistant', content })

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('rounds up content length / 3.5', () => {
    // 7 chars / 3.5 = 2 tokens
    expect(estimateTokens([u('1234567')])).toBe(2)
  })

  it('sums across messages', () => {
    expect(estimateTokens([u('hello'), a('world!')])).toBeGreaterThan(0)
    expect(estimateTokens([u('hello'), a('world!')])).toBe(Math.ceil(5 / 3.5) + Math.ceil(6 / 3.5))
  })

  it('counts tool_calls overhead', () => {
    const withTools: BrainMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'x', name: 'shell.run', args: { command: 'ls' } }],
    }
    expect(estimateTokens([withTools])).toBeGreaterThan(0)
  })
})

describe('shouldCompact', () => {
  // Trigger tokens = threshold * contextWindow = 0.5 * 1000 = 500.
  // Min history length to consider = keepRecent * 2 + 4 = 8 messages.
  const opts = { threshold: 0.5, contextWindow: 1000, keepRecent: 2 }

  it('returns null when history too short to compact', () => {
    expect(shouldCompact([], null, opts)).toBeNull()
    expect(shouldCompact([u('a'), a('b')], null, opts)).toBeNull()
  })

  it('returns null when token count below threshold', () => {
    const tiny: BrainMessage[] = []
    for (let i = 0; i < 20; i++) tiny.push(u('x'))
    // 20 single-char messages → ~20 tokens, threshold = 500
    expect(shouldCompact(tiny, null, opts)).toBeNull()
  })

  it('returns trigger tokens when estimate exceeds threshold', () => {
    const big: BrainMessage[] = []
    for (let i = 0; i < 20; i++) big.push(u('x'.repeat(100)))
    // 20 × ~29 tokens = ~580 tokens; threshold = 500
    const r = shouldCompact(big, null, opts)
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThan(500)
  })

  it('uses lastTurnPromptTokens when larger than estimate', () => {
    const small: BrainMessage[] = []
    for (let i = 0; i < 20; i++) small.push(u('x'))
    const r = shouldCompact(small, 999, opts)
    expect(r).toBe(999)
  })

  it('uses estimate when larger than lastTurnPromptTokens', () => {
    const big: BrainMessage[] = []
    for (let i = 0; i < 20; i++) big.push(u('x'.repeat(100)))
    const est = estimateTokens(big)
    const r = shouldCompact(big, 50, opts)
    expect(r).toBe(est)
  })

  it('respects keepRecent cutoff', () => {
    // keepRecent=100 → min 204 messages required
    const opts2 = { threshold: 0.001, contextWindow: 100, keepRecent: 100 }
    const ten: BrainMessage[] = []
    for (let i = 0; i < 50; i++) ten.push(u('x'.repeat(1000)))
    expect(shouldCompact(ten, null, opts2)).toBeNull()
  })
})

describe('compactHistory', () => {
  it('returns unchanged when history shorter than keepRecent*2', async () => {
    const opts = { ...DEFAULT_COMPACTION_OPTS, keepRecent: 4 }
    const h = [u('1'), a('2'), u('3'), a('4')]
    const result = await compactHistory(h, opts, async () => 'summary')
    expect(result).toEqual(h)
  })

  it('folds older into a summary message', async () => {
    const opts = { ...DEFAULT_COMPACTION_OPTS, keepRecent: 2 }
    const h: BrainMessage[] = []
    for (let i = 0; i < 10; i++) h.push(u(`msg ${i}`))
    const result = await compactHistory(h, opts, async older => {
      expect(older.length).toBe(6) // 10 - keepRecent*2
      return 'OLDER SUMMARY'
    })
    // Expected: [summary, ...last 4 messages]
    expect(result.length).toBe(5)
    expect(result[0]?.role).toBe('user')
    expect(result[0]?.content).toContain('<previous-context-summary>')
    expect(result[0]?.content).toContain('OLDER SUMMARY')
    expect(result[1]?.content).toBe('msg 6')
    expect(result[4]?.content).toBe('msg 9')
  })

  it('wraps summary in tag', async () => {
    const opts = { ...DEFAULT_COMPACTION_OPTS, keepRecent: 2 }
    const h: BrainMessage[] = []
    for (let i = 0; i < 10; i++) h.push(u(`msg ${i}`))
    const result = await compactHistory(h, opts, async () => 'X')
    expect(result[0]?.content).toMatch(
      /^<previous-context-summary>\nX\n<\/previous-context-summary>$/,
    )
  })

  it('propagates summarize errors', async () => {
    const opts = { ...DEFAULT_COMPACTION_OPTS, keepRecent: 1 }
    const h: BrainMessage[] = []
    for (let i = 0; i < 10; i++) h.push(u(`msg ${i}`))
    await expect(
      compactHistory(h, opts, async () => {
        throw new Error('summarize fail')
      }),
    ).rejects.toThrow('summarize fail')
  })
})

describe('SUMMARY_SYSTEM_PROMPT', () => {
  it('mentions key elements to preserve', () => {
    const lower = SUMMARY_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('facts')
    expect(lower).toContain('decisions')
    expect(lower).toContain('tool outputs')
  })

  it('forbids preamble', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/preamble/i)
  })
})

describe('DEFAULT_COMPACTION_OPTS', () => {
  it('targets Qwen 1M with conservative threshold', () => {
    expect(DEFAULT_COMPACTION_OPTS.contextWindow).toBe(1_000_000)
    expect(DEFAULT_COMPACTION_OPTS.threshold).toBeGreaterThan(0)
    expect(DEFAULT_COMPACTION_OPTS.threshold).toBeLessThan(1)
    expect(DEFAULT_COMPACTION_OPTS.keepRecent).toBeGreaterThan(0)
  })
})
