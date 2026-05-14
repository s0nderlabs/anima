import { describe, expect, test } from 'bun:test'
import { PACK_BLOB_VERSION, decodePackBlob, encodePackBlob, isV2Envelope } from './pack-blob'

describe('pack-blob v2 envelope', () => {
  test('encode + decode round-trips single root', () => {
    const bytes = encodePackBlob({ root: '# MEMORY.md\n\nentries' })
    expect(isV2Envelope(bytes)).toBe(true)
    const blob = decodePackBlob(bytes)
    expect(blob.v).toBe(PACK_BLOB_VERSION)
    expect(blob.root).toBe('# MEMORY.md\n\nentries')
    expect(blob.files).toEqual({})
  })

  test('encode + decode round-trips with files map', () => {
    const bytes = encodePackBlob({
      root: '# profile',
      files: {
        'operator-preferences.md': '# Operator Preferences\n\ndark mode',
        'hackathon-deadline.md': 'May 16 2026',
      },
    })
    const blob = decodePackBlob(bytes)
    expect(blob.root).toBe('# profile')
    expect(blob.files['operator-preferences.md']).toContain('dark mode')
    expect(blob.files['hackathon-deadline.md']).toBe('May 16 2026')
  })

  test('encode rejects unsafe filenames', () => {
    expect(() => encodePackBlob({ root: 'x', files: { '../etc/passwd.md': 'hax' } })).toThrow(
      /unsafe filename/,
    )
    expect(() => encodePackBlob({ root: 'x', files: { 'no-dot-md': 'x' } })).toThrow(
      /unsafe filename/,
    )
    expect(() => encodePackBlob({ root: 'x', files: { 'UPPERCASE.md': 'x' } })).toThrow(
      /unsafe filename/,
    )
    expect(() => encodePackBlob({ root: 'x', files: { 'has spaces.md': 'x' } })).toThrow(
      /unsafe filename/,
    )
    expect(() => encodePackBlob({ root: 'x', files: { '.md': 'x' } })).toThrow(/unsafe filename/)
  })

  test('isV2Envelope rejects legacy markdown', () => {
    const md = new TextEncoder().encode('# Heading\n\ncontent')
    expect(isV2Envelope(md)).toBe(false)
  })

  test('isV2Envelope rejects v1 JSON without v:2', () => {
    const v1 = new TextEncoder().encode('{"version":1,"data":"x"}')
    expect(isV2Envelope(v1)).toBe(false)
  })

  test('isV2Envelope rejects garbage', () => {
    const junk = new Uint8Array([0xff, 0x00, 0xab, 0xcd])
    expect(isV2Envelope(junk)).toBe(false)
    expect(isV2Envelope(new Uint8Array(0))).toBe(false)
  })

  test('isV2Envelope tolerates leading whitespace', () => {
    const bytes = new TextEncoder().encode('   {"v":2,"root":"x","files":{}}')
    expect(isV2Envelope(bytes)).toBe(true)
  })

  test('decode rejects mismatched version', () => {
    const bytes = new TextEncoder().encode('{"v":999,"root":"x"}')
    expect(() => decodePackBlob(bytes)).toThrow(/expected v=2/)
  })

  test('decode tolerates unsafe filenames by dropping them', () => {
    const bytes = new TextEncoder().encode(
      '{"v":2,"root":"x","files":{"ok.md":"y","../bad.md":"hax"}}',
    )
    const blob = decodePackBlob(bytes)
    expect(blob.files['ok.md']).toBe('y')
    expect(blob.files['../bad.md']).toBeUndefined()
  })

  test('handles large blobs (~100 small files)', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 100; i++) {
      files[`learned-${i}.md`] = `fact ${i}\n`.repeat(50)
    }
    const bytes = encodePackBlob({ root: '# MEMORY', files })
    expect(bytes.length).toBeGreaterThan(1000)
    const blob = decodePackBlob(bytes)
    expect(Object.keys(blob.files).length).toBe(100)
    expect(blob.files['learned-50.md']).toContain('fact 50')
  })
})
