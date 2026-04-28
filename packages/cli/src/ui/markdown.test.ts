import { describe, expect, it } from 'bun:test'
// Import from the .ts file (pure logic) so the test doesn't trigger the
// JSX transform on markdown.tsx. CI's bun runtime resolves react-jsx by
// default unless a per-file pragma or workspace tsconfig override applies,
// and pulling solid-js JSX into the test file isn't worth the coupling.
import { parseMarkdown } from './markdown-parse'

describe('parseMarkdown', () => {
  it('renders plain text as a single segment', () => {
    const segs = parseMarkdown('hello world')
    expect(segs).toHaveLength(1)
    expect(segs[0]?.text).toBe('hello world')
    expect(segs[0]?.bold).toBeUndefined()
  })

  it('parses **bold** as bold segment between plain', () => {
    const segs = parseMarkdown('the **fast** fox')
    const labels = segs.map(s => `${s.text}${s.bold ? '*' : ''}`)
    expect(labels).toContain('fast*')
    expect(segs.find(s => s.text === 'fast')?.bold).toBe(true)
  })

  it('parses *italic* as italic segment', () => {
    const segs = parseMarkdown('the *quick* fox')
    expect(segs.find(s => s.text === 'quick')?.italic).toBe(true)
  })

  it('parses `code` as code-colored segment', () => {
    const segs = parseMarkdown('use `browser.snapshot` next')
    const code = segs.find(s => s.text === 'browser.snapshot')
    expect(code?.fg).toBeDefined()
    expect(code?.fg).not.toBe('#e5e7eb')
  })

  it('renders heading with bold + heading color, drops the # prefix', () => {
    const segs = parseMarkdown('# Title\nbody')
    const titleSeg = segs.find(s => s.text === 'Title')
    expect(titleSeg?.bold).toBe(true)
    expect(titleSeg?.fg).not.toBe('#e5e7eb')
    // The leading '#' should not appear as text
    expect(segs.some(s => s.text.startsWith('#'))).toBe(false)
  })

  it('renders bullet lists with bullet glyph + content', () => {
    const segs = parseMarkdown('- one\n- two')
    const bullets = segs.filter(s => s.text.includes('•'))
    expect(bullets.length).toBe(2)
    // Bullet should be a SEPARATE segment from content (different style)
    expect(segs.find(s => s.text === 'one')).toBeDefined()
    expect(segs.find(s => s.text === 'two')).toBeDefined()
  })

  it('renders fenced code block with code-block color, skips fence lines', () => {
    const segs = parseMarkdown('```ts\nconst x = 1;\nconst y = 2;\n```')
    const codeLines = segs.filter(s => s.text.includes('const'))
    expect(codeLines.length).toBe(2)
    expect(codeLines[0]?.fg).toBeDefined()
    // Fence syntax (```ts and ```) should NOT appear in output
    expect(segs.some(s => s.text.startsWith('```'))).toBe(false)
  })

  it('parses inline code inside bold without breaking either', () => {
    const segs = parseMarkdown('use **`foo`** now')
    // The combined ** + `` is unusual; we accept either bold-with-code or plain-with-code, but no crash
    expect(segs.length).toBeGreaterThan(0)
  })

  it('preserves newlines between blocks', () => {
    const segs = parseMarkdown('one\ntwo\nthree')
    const newlines = segs.filter(s => s.text === '\n')
    expect(newlines.length).toBe(2)
  })

  it('handles the screenshot regression case (mixed bold + inline code + bullets)', () => {
    const text = `**What I did successfully:**
- \`browser.navigate\` → done
- \`browser.type\` worked

**What failed:**
- \`browser.snapshot\` returned home`
    const segs = parseMarkdown(text)
    // Bold "What I did successfully:" present
    expect(segs.find(s => s.text === 'What I did successfully:' && s.bold)).toBeDefined()
    // Inline code segments
    expect(segs.find(s => s.text === 'browser.navigate')).toBeDefined()
    expect(segs.find(s => s.text === 'browser.snapshot')).toBeDefined()
    // No literal ** or ` in output
    expect(segs.some(s => s.text.includes('**'))).toBe(false)
    expect(segs.some(s => s.text.includes('`'))).toBe(false)
  })
})
