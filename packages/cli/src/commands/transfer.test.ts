import { describe, expect, test } from 'bun:test'
import { parseTransferArgs } from './transfer'

const REF = 'eip155:16661:0x9e71d79f06f956d4d2666b5c93dafab721c84721:7'
const TO = '0x06B74fe8070C96D92e3a2A8A871849Ac81e4c09e'
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

describe('parseTransferArgs', () => {
  test('minimum: ref + --to', () => {
    const r = parseTransferArgs([REF, '--to', TO])
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.ref).toBe(REF)
    expect(r.to.toLowerCase()).toBe(TO.toLowerCase())
    expect(r.dryRun).toBeUndefined()
    expect(r.yes).toBeUndefined()
    expect(r.noPurge).toBeUndefined()
  })

  test('--dry-run flag', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--dry-run'])
    if ('error' in r) throw new Error(r.error)
    expect(r.dryRun).toBe(true)
  })

  test('--yes shorthand -y', () => {
    const r = parseTransferArgs([REF, '--to', TO, '-y'])
    if ('error' in r) throw new Error(r.error)
    expect(r.yes).toBe(true)
  })

  test('--no-purge', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--no-purge'])
    if ('error' in r) throw new Error(r.error)
    expect(r.noPurge).toBe(true)
  })

  test('--recipient-key with 0x prefix', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--recipient-key', KEY])
    if ('error' in r) throw new Error(r.error)
    expect(r.recipientKey).toBe(KEY)
  })

  test('--recipient-key without 0x prefix gets normalized', () => {
    const stripped = KEY.slice(2)
    const r = parseTransferArgs([REF, '--to', TO, '--recipient-key', stripped])
    if ('error' in r) throw new Error(r.error)
    expect(r.recipientKey).toBe(KEY)
  })

  test('--oracle-key with 0x prefix', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--oracle-key', KEY])
    if ('error' in r) throw new Error(r.error)
    expect(r.oracleKey).toBe(KEY)
  })

  test('--oracle-key without 0x prefix gets normalized', () => {
    const stripped = KEY.slice(2)
    const r = parseTransferArgs([REF, '--to', TO, '--oracle-key', stripped])
    if ('error' in r) throw new Error(r.error)
    expect(r.oracleKey).toBe(KEY)
  })

  test('error: missing ref', () => {
    const r = parseTransferArgs(['--to', TO])
    expect('error' in r).toBe(true)
  })

  test('error: missing --to', () => {
    const r = parseTransferArgs([REF])
    expect('error' in r).toBe(true)
  })

  test('error: invalid --to address', () => {
    const r = parseTransferArgs([REF, '--to', '0xnotanaddress'])
    expect('error' in r).toBe(true)
  })

  test('error: invalid --recipient-key length', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--recipient-key', '0xdeadbeef'])
    expect('error' in r).toBe(true)
  })

  test('error: invalid --oracle-key length', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--oracle-key', '0xdeadbeef'])
    expect('error' in r).toBe(true)
  })

  test('error: --oracle-key without value', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--oracle-key'])
    expect('error' in r).toBe(true)
  })

  test('error: unknown flag', () => {
    const r = parseTransferArgs([REF, '--to', TO, '--bogus'])
    expect('error' in r).toBe(true)
  })

  test('error: unexpected positional', () => {
    const r = parseTransferArgs([REF, 'bonus-arg', '--to', TO])
    expect('error' in r).toBe(true)
  })

  test('flag order does not matter', () => {
    const r = parseTransferArgs(['--dry-run', '--to', TO, REF, '--yes'])
    if ('error' in r) throw new Error(r.error)
    expect(r.ref).toBe(REF)
    expect(r.dryRun).toBe(true)
    expect(r.yes).toBe(true)
  })
})
