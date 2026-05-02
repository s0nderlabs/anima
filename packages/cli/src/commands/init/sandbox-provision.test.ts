import { afterEach, describe, expect, test } from 'bun:test'
import type { SandboxRecord } from '@s0nderlabs/anima-core'
import { createSandboxWithOrphanRetry, pickPermissionMode } from './sandbox-provision'

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

describe('createSandboxWithOrphanRetry', () => {
  function rec(id: string, name: string): SandboxRecord {
    return { id, name, state: 'started' } as unknown as SandboxRecord
  }

  test('passes through on first-try success', async () => {
    let createCalls = 0
    let listCalls = 0
    const provider = {
      createSandbox: async () => {
        createCalls++
        return rec('sb-1', 'phantom')
      },
      listSandboxes: async () => {
        listCalls++
        return []
      },
      deleteSandbox: async () => {},
    }
    const r = await createSandboxWithOrphanRetry(provider, 'snap', 'phantom', () => {})
    expect(r.id).toBe('sb-1')
    expect(createCalls).toBe(1)
    expect(listCalls).toBe(0)
  })

  test('on 409 with name collision: deletes orphan, retries, succeeds', async () => {
    let createCalls = 0
    const deleted: string[] = []
    const provider = {
      createSandbox: async () => {
        createCalls++
        if (createCalls === 1) {
          throw new Error(
            'POST /api/sandbox: 409 {"message":"Sandbox with name phantom already exists"}',
          )
        }
        return rec('sb-2', 'phantom')
      },
      listSandboxes: async () => [rec('sb-orphan', 'phantom'), rec('sb-other', 'enigma')],
      deleteSandbox: async (id: string) => {
        deleted.push(id)
      },
    }
    const msgs: string[] = []
    const r = await createSandboxWithOrphanRetry(provider, 'snap', 'phantom', m => msgs.push(m))
    expect(r.id).toBe('sb-2')
    expect(createCalls).toBe(2)
    expect(deleted).toEqual(['sb-orphan'])
    expect(msgs.some(m => m.includes('cleaning up'))).toBe(true)
  })

  test('non-409 errors propagate without cleanup', async () => {
    let listCalls = 0
    const provider = {
      createSandbox: async () => {
        throw new Error('POST /api/sandbox: 503 service unavailable')
      },
      listSandboxes: async () => {
        listCalls++
        return []
      },
      deleteSandbox: async () => {},
    }
    await expect(
      createSandboxWithOrphanRetry(provider, 'snap', 'phantom', () => {}),
    ).rejects.toThrow(/503/)
    expect(listCalls).toBe(0)
  })

  test('409 without a name (anonymous create) propagates without cleanup', async () => {
    let listCalls = 0
    const provider = {
      createSandbox: async () => {
        throw new Error('POST /api/sandbox: 409 {"message":"already exists"}')
      },
      listSandboxes: async () => {
        listCalls++
        return []
      },
      deleteSandbox: async () => {},
    }
    await expect(
      createSandboxWithOrphanRetry(provider, 'snap', undefined, () => {}),
    ).rejects.toThrow(/409/)
    expect(listCalls).toBe(0)
  })

  test('409 with empty list: re-throws original error (no orphan to clean)', async () => {
    let createCalls = 0
    const provider = {
      createSandbox: async () => {
        createCalls++
        throw new Error('POST /api/sandbox: 409 already exists')
      },
      listSandboxes: async () => [rec('sb-other', 'enigma')], // no phantom
      deleteSandbox: async () => {},
    }
    await expect(
      createSandboxWithOrphanRetry(provider, 'snap', 'phantom', () => {}),
    ).rejects.toThrow(/409/)
    expect(createCalls).toBe(1)
  })
})
