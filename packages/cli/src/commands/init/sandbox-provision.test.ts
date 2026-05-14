import { afterEach, describe, expect, test } from 'bun:test'
import type { SandboxRecord } from '@s0nderlabs/anima-core'
import {
  type ResumeArchivedSandboxOpts,
  type SandboxProvisionOpts,
  createSandboxWithOrphanRetry,
  ensureSandboxArchived,
  ensureSandboxStarted,
  extractBootstrapProgressLine,
  pickPermissionMode,
  resolveHandoffPlugins,
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

describe('ensureSandboxArchived', () => {
  function fakeProvider(stateSequence: Array<SandboxRecord['state']>) {
    let i = 0
    let stops = 0
    let archives = 0
    const provider = {
      getSandbox: async (id: string) =>
        ({ id, state: stateSequence[Math.min(i++, stateSequence.length - 1)] }) as SandboxRecord,
      stopSandbox: async () => {
        stops += 1
      },
      archiveSandbox: async () => {
        archives += 1
      },
    }
    return { provider, archivesCalled: () => archives, stopsCalled: () => stops }
  }

  test('no-op when sandbox already archived', async () => {
    const { provider, archivesCalled, stopsCalled } = fakeProvider(['archived'])
    const r = await ensureSandboxArchived(provider as never, 'sb-a1')
    expect(r.alreadyArchived).toBe(true)
    expect(r.initialState).toBe('archived')
    expect(r.finalState).toBe('archived')
    expect(r.stoppedFirst).toBe(false)
    expect(archivesCalled()).toBe(0)
    expect(stopsCalled()).toBe(0)
  })

  test('throws on error state without calling stop or archive', async () => {
    const { provider, archivesCalled, stopsCalled } = fakeProvider(['error'])
    await expect(ensureSandboxArchived(provider as never, 'sb-a2')).rejects.toThrow(/error state/)
    expect(archivesCalled()).toBe(0)
    expect(stopsCalled()).toBe(0)
  })

  test('stopped → archiving → archived: skips stop, calls /archive', async () => {
    // Phase 1 reads state once (stopped — no stop needed).
    // Phase 2 reads state, sees stopped, calls archive.
    // Then poll loop reads archiving → archived.
    const { provider, archivesCalled, stopsCalled } = fakeProvider([
      'stopped',
      'stopped',
      'archiving',
      'archived',
    ])
    const r = await ensureSandboxArchived(provider as never, 'sb-a3', { intervalMs: 1 })
    expect(r.alreadyArchived).toBe(false)
    expect(r.initialState).toBe('stopped')
    expect(r.finalState).toBe('archived')
    expect(r.stoppedFirst).toBe(false)
    expect(stopsCalled()).toBe(0)
    expect(archivesCalled()).toBe(1)
  })

  test('started → stopping → stopped → archiving → archived: two-phase', async () => {
    const { provider, archivesCalled, stopsCalled } = fakeProvider([
      'started',
      'stopping',
      'stopped',
      'stopped',
      'archiving',
      'archived',
    ])
    const r = await ensureSandboxArchived(provider as never, 'sb-a4', { intervalMs: 1 })
    expect(r.initialState).toBe('started')
    expect(r.finalState).toBe('archived')
    expect(r.stoppedFirst).toBe(true)
    expect(stopsCalled()).toBe(1)
    expect(archivesCalled()).toBe(1)
  })

  test('transient state (archiving) on entry: does NOT re-issue /archive', async () => {
    const { provider, archivesCalled, stopsCalled } = fakeProvider([
      'archiving',
      'archiving',
      'archived',
    ])
    const r = await ensureSandboxArchived(provider as never, 'sb-a5', { intervalMs: 1 })
    expect(r.finalState).toBe('archived')
    expect(stopsCalled()).toBe(0)
    expect(archivesCalled()).toBe(0)
  })

  test('throws if archive deadline expires', async () => {
    const { provider } = fakeProvider(['stopped', 'stopped', 'archiving', 'archiving', 'archiving'])
    await expect(
      ensureSandboxArchived(provider as never, 'sb-a6', { intervalMs: 1, deadlineMs: 30 }),
    ).rejects.toThrow(/did not reach archived/)
  })

  test('throws if stop deadline expires', async () => {
    const { provider } = fakeProvider(['started', 'stopping', 'stopping', 'stopping'])
    await expect(
      ensureSandboxArchived(provider as never, 'sb-a7', { intervalMs: 1, deadlineMs: 30 }),
    ).rejects.toThrow(/did not reach stopped/)
  })

  test('throws if state transitions to error mid-archive', async () => {
    const { provider } = fakeProvider(['stopped', 'stopped', 'archiving', 'error'])
    await expect(
      ensureSandboxArchived(provider as never, 'sb-a8', { intervalMs: 1 }),
    ).rejects.toThrow(/error during archive/)
  })

  test('throws if state transitions to error mid-stop', async () => {
    const { provider } = fakeProvider(['started', 'stopping', 'error'])
    await expect(
      ensureSandboxArchived(provider as never, 'sb-a9', { intervalMs: 1 }),
    ).rejects.toThrow(/error during stop/)
  })
})

describe('ResumeArchivedSandboxOpts shape', () => {
  // Regression guard for the v0.19.18 fix: every pause→resume cycle on
  // anima resume must be able to ship telegram secrets to the restored
  // gateway, otherwise the TG listener silently drops on resume. This
  // test fails to compile if anyone removes the telegramSecrets field
  // from the interface.
  test('telegramSecrets field is part of the public interface', () => {
    type WithTg = Required<Pick<ResumeArchivedSandboxOpts, 'telegramSecrets'>>
    const sample: WithTg['telegramSecrets'] = {
      botToken: '123:abcdef',
      allowedUserIds: [42],
    }
    expect(sample.botToken).toBe('123:abcdef')
    expect(sample.allowedUserIds).toEqual([42])
  })
})

describe('SandboxProvisionOpts shape (v0.21.19 telegramSecrets plumbing)', () => {
  // Regression guard for Bug 1 in feedback-reprovision-skips-tg-and-probe-bug.
  // Before v0.21.19, runReprovisionUpgrade + runDeploy both called
  // runSandboxProvision without passing telegramSecrets, so fresh containers
  // booted TG-less. The reprovision path is the recovery sledgehammer
  // operators reach for after canary cycles or stale-UUID 403s; it MUST
  // produce a fully working agent, not a half-configured one missing TG.
  // This test compiles only if the field is still on the opts.
  test('telegramSecrets field is part of the public interface', () => {
    type WithTg = Required<Pick<SandboxProvisionOpts, 'telegramSecrets'>>
    const sample: WithTg['telegramSecrets'] = {
      botToken: '456:zyxwvu',
      allowedUserIds: [99],
    }
    expect(sample.botToken).toBe('456:zyxwvu')
    expect(sample.allowedUserIds).toEqual([99])
  })
})

describe('extractBootstrapProgressLine (v0.24.4 STAGE-aware surfacing)', () => {
  // Bug closed by v0.24.4 Bundle 5: operator stared at "launching bootstrap"
  // spinner for 30s with no updates because (a) the poll loop only surfaced
  // every 6th tick (~30s) and (b) the surface line was whatever raw `[$(date)
  // ...]` log entry happened to land in `tail -n 1`. Now the bootstrap script
  // emits explicit `STAGE: ...` markers and this helper prefers them.

  test('prefers the last STAGE marker over raw tail lines (last-wins, prefix stripped)', () => {
    const tail = [
      '[2026-05-15T10:00:01Z] bootstrap-start (mode=npm)',
      'STAGE: updating package index',
      '[apt update attempt 1/3]',
      'STAGE: installing system deps (build-essential, curl, git, xvfb)',
      '[apt install attempt 1/3]',
      'STAGE: installing bun runtime',
      'curl: downloading bun...',
    ].join('\n')
    expect(extractBootstrapProgressLine(tail)).toBe('installing bun runtime')
  })

  test('returns the most recent STAGE even if non-STAGE lines follow it', () => {
    const tail = [
      'STAGE: installing chrome for browser tools',
      '[browser deps]',
      'Downloading Chromium 119...',
      'progress 42%',
    ].join('\n')
    // Should still pick the STAGE line — operator cares about the stage,
    // not which sub-step within the stage is mid-stream.
    expect(extractBootstrapProgressLine(tail)).toBe('installing chrome for browser tools')
  })

  test('falls back to filter/pop when no STAGE marker is present (older gateway)', () => {
    const tail = [
      '[2026-05-15T10:00:01Z] bootstrap-start (mode=npm)',
      '  sandbox=sb-abc',
      '[apt update attempt 1/3]',
      'Reading package lists... Done',
    ].join('\n')
    expect(extractBootstrapProgressLine(tail)).toBe('Reading package lists... Done')
  })

  test('filters bash setlocale warnings out of the fallback', () => {
    const tail = [
      'STAGE-less old log',
      'bash: warning: setlocale: LC_ALL: cannot change locale',
      'real progress here',
      'bash: warning: setlocale: LC_ALL: cannot change locale',
    ].join('\n')
    expect(extractBootstrapProgressLine(tail)).toBe('real progress here')
  })

  test('strips exactly one `STAGE: ` prefix (does not double-strip)', () => {
    const tail = 'STAGE: STAGE: nested'
    expect(extractBootstrapProgressLine(tail)).toBe('STAGE: nested')
  })

  test('returns undefined for empty tail', () => {
    expect(extractBootstrapProgressLine('')).toBeUndefined()
    expect(extractBootstrapProgressLine('   \n   \n')).toBeUndefined()
  })

  test('STAGE markers from v0.24.4 bootstrap script match the documented set', () => {
    // Lock the canonical labels so a future bootstrap.ts rename surfaces
    // here. The first 6 are the steps the operator sees in order; the last
    // is the success terminator the poll loop detects via DONE_MARKER too.
    const stages = [
      'updating package index',
      'installing system deps (build-essential, curl, git, xvfb)',
      'installing bun runtime',
      'installing anima (0.24.4)',
      'installing chrome for browser tools',
      'starting harness daemon',
      'harness ready',
    ]
    for (const stage of stages) {
      const tail = ['some prior line', `STAGE: ${stage}`, 'noise after'].join('\n')
      expect(extractBootstrapProgressLine(tail)).toBe(stage)
    }
  })
})

describe('resolveHandoffPlugins (v0.24.5 auto-include telegram)', () => {
  test('no caller list + no TG secrets → safe default', () => {
    expect(resolveHandoffPlugins(undefined, false)).toEqual(['system', 'comms', 'onchain'])
  })

  test('no caller list + TG secrets → default plus telegram', () => {
    expect(resolveHandoffPlugins(undefined, true)).toEqual([
      'system',
      'comms',
      'onchain',
      'telegram',
    ])
  })

  test('caller list already has telegram + TG secrets → unchanged', () => {
    const caller = ['system', 'telegram'] as const
    const out = resolveHandoffPlugins([...caller], true)
    expect(out).toEqual(['system', 'telegram'])
  })

  test('caller list missing telegram + TG secrets → appends telegram', () => {
    const out = resolveHandoffPlugins(['system', 'onchain'], true)
    expect(out).toEqual(['system', 'onchain', 'telegram'])
  })

  test('caller list missing telegram + no TG secrets → unchanged (no implicit add)', () => {
    const out = resolveHandoffPlugins(['system', 'onchain'], false)
    expect(out).toEqual(['system', 'onchain'])
  })
})
