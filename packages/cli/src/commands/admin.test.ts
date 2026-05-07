import { describe, expect, test } from 'bun:test'
import { parseAdminArgs, runAdmin } from './admin'

describe('parseAdminArgs', () => {
  test('errors with usage when no subcommand', () => {
    const r = parseAdminArgs([])
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('unreachable')
    expect(r.error).toMatch(/usage/i)
    expect(r.error).toMatch(/autotopup-tick/)
  })

  test('errors on unknown subcommand', () => {
    const r = parseAdminArgs(['nope'])
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('unreachable')
    expect(r.error).toMatch(/unknown subcommand/)
    expect(r.error).toMatch(/'nope'/)
  })

  test('parses autotopup-tick', () => {
    const r = parseAdminArgs(['autotopup-tick'])
    expect('error' in r).toBe(false)
    if ('error' in r) throw new Error(r.error)
    expect(r.sub).toBe('autotopup-tick')
  })
})

describe('runAdmin dispatch', () => {
  test('runAdmin is callable + accepts AdminArgs shape', () => {
    expect(typeof runAdmin).toBe('function')
    expect(runAdmin.length).toBe(1)
  })
})
