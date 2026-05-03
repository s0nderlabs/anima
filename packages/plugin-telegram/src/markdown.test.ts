import { describe, expect, it } from 'bun:test'
import { escapeMarkdownV2, isMarkdownParseError, stripMarkdownV2 } from './markdown'

describe('escapeMarkdownV2', () => {
  it('escapes all reserved characters', () => {
    expect(escapeMarkdownV2('a_b*c')).toBe('a\\_b\\*c')
    expect(escapeMarkdownV2('hello [world]')).toBe('hello \\[world\\]')
    expect(escapeMarkdownV2('1.2.3')).toBe('1\\.2\\.3')
    expect(escapeMarkdownV2('a-b+c')).toBe('a\\-b\\+c')
    expect(escapeMarkdownV2('!hi')).toBe('\\!hi')
  })

  it('passes plain text untouched', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world')
    expect(escapeMarkdownV2('abc 123')).toBe('abc 123')
  })

  it('escapes backslashes themselves', () => {
    expect(escapeMarkdownV2('path\\to')).toBe('path\\\\to')
  })
})

describe('stripMarkdownV2', () => {
  it('removes escape backslashes', () => {
    expect(stripMarkdownV2('a\\.b\\.c')).toBe('a.b.c')
    expect(stripMarkdownV2('hello\\!')).toBe('hello!')
  })

  it('strips bold markers', () => {
    expect(stripMarkdownV2('*hello*')).toBe('hello')
    expect(stripMarkdownV2('this is *bold*.')).toBe('this is bold.')
  })

  it('strips spoiler markers', () => {
    expect(stripMarkdownV2('this is ||hidden||.')).toBe('this is hidden.')
  })

  it('strips strikethrough markers', () => {
    expect(stripMarkdownV2('~deleted~ now')).toBe('deleted now')
  })

  it('preserves plain text', () => {
    expect(stripMarkdownV2('hello world')).toBe('hello world')
  })

  it('strips a chain of formatting on one line', () => {
    expect(stripMarkdownV2('*bold* and ~strike~ together')).toBe('bold and strike together')
  })
})

describe('isMarkdownParseError', () => {
  it('matches the canonical TG parse error string', () => {
    expect(isMarkdownParseError(new Error("Bad Request: can't parse entities: ..."))).toBe(true)
  })

  it('matches hermes-cited variant', () => {
    expect(isMarkdownParseError(new Error('cannot parse entities at offset 5'))).toBe(true)
  })

  it('is false for unrelated errors', () => {
    expect(isMarkdownParseError(new Error('Forbidden'))).toBe(false)
    expect(isMarkdownParseError(new Error('ECONNRESET'))).toBe(false)
  })
})
