import { describe, expect, it } from 'bun:test'
import { htmlToMarkdown, makeWebFetch } from './web-fetch'

describe('web.fetch host-allowlist', () => {
  const tool = makeWebFetch()

  it('rejects file:// URLs', async () => {
    const out = await tool.handler({ url: 'file:///etc/hosts' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/invalid URL|unsupported protocol/)
  })

  it('rejects ftp:// URLs', async () => {
    const out = await tool.handler({ url: 'ftp://example.com/foo' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('unsupported protocol')
  })

  it('rejects loopback IPs (127.0.0.1)', async () => {
    const out = await tool.handler({ url: 'http://127.0.0.1:8080/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects private RFC1918 IPs (10.x)', async () => {
    const out = await tool.handler({ url: 'http://10.0.0.1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects 192.168.x.x', async () => {
    const out = await tool.handler({ url: 'http://192.168.1.1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects link-local (169.254.x.x including AWS metadata)', async () => {
    const out = await tool.handler({ url: 'http://169.254.169.254/latest/meta-data/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects localhost literal', async () => {
    const out = await tool.handler({ url: 'http://localhost/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects .internal TLD', async () => {
    const out = await tool.handler({ url: 'http://service.internal/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })

  it('rejects metadata.google.internal explicitly', async () => {
    const out = await tool.handler({ url: 'http://metadata.google.internal/computeMetadata/v1/' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('host blocked')
  })
})

describe('htmlToMarkdown', () => {
  it('strips script and style tags entirely', () => {
    const html =
      '<html><head><script>alert(1)</script><style>body{}</style></head><body>hi</body></html>'
    expect(htmlToMarkdown(html)).toBe('hi')
  })

  it('converts headings to # syntax', () => {
    expect(htmlToMarkdown('<h1>Title</h1><p>body</p>')).toContain('# Title')
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub')
  })

  it('converts links to [text](href)', () => {
    expect(htmlToMarkdown('<a href="https://example.com">click</a>')).toBe(
      '[click](https://example.com)',
    )
  })

  it('converts list items to - bullets', () => {
    const out = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    expect(out).toContain('- one')
    expect(out).toContain('- two')
  })

  it('decodes common HTML entities', () => {
    expect(htmlToMarkdown('<p>R&amp;D &gt; 0</p>')).toContain('R&D > 0')
    expect(htmlToMarkdown('<p>caf&#233;</p>')).toContain('café')
  })

  it('collapses runs of blank lines', () => {
    const html = '<p>a</p>\n\n\n\n\n<p>b</p>'
    const md = htmlToMarkdown(html)
    expect(md).not.toMatch(/\n{3,}/)
  })

  it('strips HTML comments', () => {
    expect(htmlToMarkdown('<!-- secret --><p>visible</p>')).toBe('visible')
  })
})
