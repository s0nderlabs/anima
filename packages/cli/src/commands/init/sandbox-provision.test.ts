import { afterEach, describe, expect, test } from 'bun:test'
import type { SandboxRecord } from '@s0nderlabs/anima-core'
import {
  createSandboxWithOrphanRetry,
  ensureSandboxStarted,
  pickPermissionMode,
} from './sandbox-provision'

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

describe('ensureSandboxStarted', () => {
  function fakeProvider(stateSequence: Array<SandboxRecord['state']>) {
    let i = 0
    let starts = 0
    const provider = {
      getSandbox: async (id: string) =>
        ({ id, state: stateSequence[Math.min(i++, stateSequence.length - 1)] }) as SandboxRecord,
      startSandbox: async () => {
        starts += 1
      },
    }
    return { provider, startsCalled: () => starts }
  }

  test('no-op when sandbox already started', async () => {
    const { provider, startsCalled } = fakeProvider(['started'])
    const r = await ensureSandboxStarted(provider as never, 'sb-1')
    expect(r.alreadyStarted).toBe(true)
    expect(r.initialState).toBe('started')
    expect(r.finalState).toBe('started')
    expect(startsCalled()).toBe(0)
  })

  test('throws on error state without calling start', async () => {
    const { provider, startsCalled } = fakeProvider(['error'])
    await expect(ensureSandboxStarted(provider as never, 'sb-2')).rejects.toThrow(/error state/)
    expect(startsCalled()).toBe(0)
  })

  test('stopped → started: calls /start, polls until state flips', async () => {
    const { provider, startsCalled } = fakeProvider(['stopped', 'starting', 'started'])
    const r = await ensureSandboxStarted(provider as never, 'sb-3', { intervalMs: 1 })
    expect(r.alreadyStarted).toBe(false)
    expect(r.initialState).toBe('stopped')
    expect(r.finalState).toBe('started')
    expect(startsCalled()).toBe(1)
  })

  test('archived → restoring → started: calls /start, accepts long path', async () => {
    const { provider, startsCalled } = fakeProvider([
      'archived',
      'restoring',
      'restoring',
      'starting',
      'started',
    ])
    const msgs: string[] = []
    const r = await ensureSandboxStarted(provider as never, 'sb-4', {
      intervalMs: 1,
      onProgress: m => msgs.push(m),
    })
    expect(r.alreadyStarted).toBe(false)
    expect(r.initialState).toBe('archived')
    expect(r.finalState).toBe('started')
    expect(startsCalled()).toBe(1)
    // Progress should mention the friendly "archived" wording at least once
    expect(msgs.some(m => m.includes('archived'))).toBe(true)
  })

  test('transient state (restoring): does NOT re-issue /start', async () => {
    const { provider, startsCalled } = fakeProvider(['restoring', 'restoring', 'started'])
    const r = await ensureSandboxStarted(provider as never, 'sb-5', { intervalMs: 1 })
    expect(r.finalState).toBe('started')
    // initial state was already transient → don't double-fire /start
    expect(startsCalled()).toBe(0)
  })

  test('throws if deadline expires without reaching started', async () => {
    const { provider } = fakeProvider(['stopped', 'starting', 'starting', 'starting'])
    await expect(
      ensureSandboxStarted(provider as never, 'sb-6', {
        intervalMs: 1,
        stoppedDeadlineMs: 50,
      }),
    ).rejects.toThrow(/did not reach started/)
  })

  test('throws if state transitions to error mid-poll', async () => {
    const { provider } = fakeProvider(['stopped', 'starting', 'error'])
    await expect(
      ensureSandboxStarted(provider as never, 'sb-7', { intervalMs: 1 }),
    ).rejects.toThrow(/error state during resume/)
  })
})
