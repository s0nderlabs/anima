import { describe, expect, it } from 'bun:test'
import { decodeEnvelope, encodeEnvelope } from './envelope'

describe('envelope: msg type', () => {
  it('roundtrips a simple message', () => {
    const env = encodeEnvelope({ v: 1, type: 'msg', content: 'hello' })
    const decoded = decodeEnvelope(env)
    expect(decoded).toEqual({ v: 1, type: 'msg', content: 'hello' })
  })

  it('preserves inReplyTo when present', () => {
    const env = encodeEnvelope({
      v: 1,
      type: 'msg',
      content: 'reply',
      inReplyTo: '0xabc',
    })
    const decoded = decodeEnvelope(env)
    expect(decoded).toEqual({ v: 1, type: 'msg', content: 'reply', inReplyTo: '0xabc' })
  })

  it('roundtrips utf-8 content', () => {
    const env = encodeEnvelope({ v: 1, type: 'msg', content: 'こんにちは 🦊' })
    expect((decodeEnvelope(env) as { content: string }).content).toBe('こんにちは 🦊')
  })
})

describe('envelope: file type', () => {
  it('roundtrips a file envelope', () => {
    const env = encodeEnvelope({
      v: 1,
      type: 'file',
      filename: 'report.pdf',
      mime: 'application/pdf',
      size: 5_242_880,
      caption: 'q3 numbers',
    })
    const decoded = decodeEnvelope(env)
    expect(decoded).toMatchObject({
      v: 1,
      type: 'file',
      filename: 'report.pdf',
      mime: 'application/pdf',
      size: 5_242_880,
      caption: 'q3 numbers',
    })
  })

  it('omits caption when not set', () => {
    const env = encodeEnvelope({
      v: 1,
      type: 'file',
      filename: 'a.bin',
      mime: 'application/octet-stream',
      size: 12,
    })
    const decoded = decodeEnvelope(env) as unknown as Record<string, unknown>
    expect(decoded.caption).toBeUndefined()
  })
})

describe('envelope: error paths', () => {
  it('rejects invalid JSON', () => {
    const bad = new TextEncoder().encode('not-json')
    expect(() => decodeEnvelope(bad)).toThrow()
  })

  it('rejects unknown version', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ v: 2, type: 'msg', content: 'x' }))
    expect(() => decodeEnvelope(bad)).toThrow(/version/)
  })

  it('rejects unknown type', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ v: 1, type: 'wat' }))
    expect(() => decodeEnvelope(bad)).toThrow(/unknown envelope type/)
  })

  it('rejects msg without content', () => {
    const bad = new TextEncoder().encode(JSON.stringify({ v: 1, type: 'msg' }))
    expect(() => decodeEnvelope(bad)).toThrow(/content/)
  })

  it('rejects file missing filename', () => {
    const bad = new TextEncoder().encode(
      JSON.stringify({ v: 1, type: 'file', mime: 'x/y', size: 1 }),
    )
    expect(() => decodeEnvelope(bad)).toThrow(/missing required fields/)
  })

  it('rejects non-object roots', () => {
    const bad = new TextEncoder().encode('"string-root"')
    expect(() => decodeEnvelope(bad)).toThrow()
  })
})
