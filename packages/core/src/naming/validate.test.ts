import { describe, expect, test } from 'bun:test'
import { SUBNAME_LABEL_RE, validateSubnameLabel } from './validate'

describe('validateSubnameLabel', () => {
  test('accepts simple lowercase labels', () => {
    expect(validateSubnameLabel('alice').ok).toBe(true)
    expect(validateSubnameLabel('bob123').ok).toBe(true)
    expect(validateSubnameLabel('hello').ok).toBe(true)
  })

  test('accepts 3 chars (lower bound)', () => {
    expect(validateSubnameLabel('abc').ok).toBe(true)
  })

  test('rejects 2 chars or fewer', () => {
    expect(validateSubnameLabel('ab').ok).toBe(false)
    expect(validateSubnameLabel('a').ok).toBe(false)
    expect(validateSubnameLabel('').ok).toBe(false)
  })

  test('accepts 32 chars (upper bound)', () => {
    expect(validateSubnameLabel(`a${'1'.repeat(30)}a`).ok).toBe(true) // 32
  })

  test('rejects 33 chars or more', () => {
    expect(validateSubnameLabel('a'.repeat(33)).ok).toBe(false)
  })

  test('rejects uppercase', () => {
    expect(validateSubnameLabel('Alice').ok).toBe(false)
    expect(validateSubnameLabel('aLice').ok).toBe(false)
    expect(validateSubnameLabel('ALICE').ok).toBe(false)
  })

  test('rejects leading hyphen', () => {
    expect(validateSubnameLabel('-alice').ok).toBe(false)
  })

  test('rejects trailing hyphen', () => {
    expect(validateSubnameLabel('alice-').ok).toBe(false)
  })

  test('accepts internal hyphens', () => {
    expect(validateSubnameLabel('al-ice').ok).toBe(true)
    expect(validateSubnameLabel('al-ic-e').ok).toBe(true)
  })

  test('rejects spaces', () => {
    expect(validateSubnameLabel('al ice').ok).toBe(false)
  })

  test('rejects underscores, dots, special chars', () => {
    expect(validateSubnameLabel('al_ice').ok).toBe(false)
    expect(validateSubnameLabel('al.ice').ok).toBe(false)
    expect(validateSubnameLabel('al!ice').ok).toBe(false)
    expect(validateSubnameLabel('al@ice').ok).toBe(false)
  })

  test('rejects unicode / emoji', () => {
    expect(validateSubnameLabel('aliçe').ok).toBe(false)
    expect(validateSubnameLabel('alice🚀').ok).toBe(false)
  })

  test('rejects double hyphens at edges (covered by leading/trailing checks)', () => {
    expect(validateSubnameLabel('--ab').ok).toBe(false)
    expect(validateSubnameLabel('ab--').ok).toBe(false)
  })

  test('regex matches the wizard inline regex behavior', () => {
    expect(SUBNAME_LABEL_RE.test('alice')).toBe(true)
    expect(SUBNAME_LABEL_RE.test('Alice')).toBe(false)
    expect(SUBNAME_LABEL_RE.test('alice-')).toBe(false)
    expect(SUBNAME_LABEL_RE.test('-alice')).toBe(false)
    expect(SUBNAME_LABEL_RE.test('ab')).toBe(false)
    expect(SUBNAME_LABEL_RE.test('a'.repeat(33))).toBe(false)
  })

  test('reason field is informative', () => {
    const r = validateSubnameLabel('Alice')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/lowercase/)
  })
})
