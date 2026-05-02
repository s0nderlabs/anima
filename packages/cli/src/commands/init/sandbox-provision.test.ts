import { afterEach, describe, expect, test } from 'bun:test'
import { pickPermissionMode } from './sandbox-provision'

describe('pickPermissionMode', () => {
  const original = process.env.ANIMA_PERMISSIONS

  function unset(): void {
    process.env.ANIMA_PERMISSIONS = undefined
  }

  afterEach(() => {
    if (original === undefined) unset()
    else process.env.ANIMA_PERMISSIONS = original
  })

  test('default is off when env unset', () => {
    unset()
    expect(pickPermissionMode()).toBe('off')
  })

  test('accepts prompt + strict + off, case-insensitive, trimmed', () => {
    process.env.ANIMA_PERMISSIONS = 'prompt'
    expect(pickPermissionMode()).toBe('prompt')
    process.env.ANIMA_PERMISSIONS = '  STRICT  '
    expect(pickPermissionMode()).toBe('strict')
    process.env.ANIMA_PERMISSIONS = 'Off'
    expect(pickPermissionMode()).toBe('off')
  })

  test('falls back to off on unknown value (no crash)', () => {
    process.env.ANIMA_PERMISSIONS = 'yolo'
    expect(pickPermissionMode()).toBe('off')
    process.env.ANIMA_PERMISSIONS = ''
    expect(pickPermissionMode()).toBe('off')
  })
})
