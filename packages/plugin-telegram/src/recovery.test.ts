import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BotTokenLockedError,
  acquireTelegramTokenLock,
  classifyStartFailure,
  clearWebhookBeforePolling,
} from './recovery'

let lockDir: string

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'anima-recovery-test-'))
})

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true })
})

describe('acquireTelegramTokenLock', () => {
  it('returns release/refresh handle when nothing else holds the token', () => {
    const lock = acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })
    expect(lock.release).toBeFunction()
    expect(lock.refresh).toBeFunction()
    expect(lock.refresh()).toBe(true)
    lock.release()
  })

  it('throws BotTokenLockedError when the same token is held', () => {
    const a = acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })
    expect(() => acquireTelegramTokenLock('123:fake-token-a', { rootDir: lockDir })).toThrow(
      BotTokenLockedError,
    )
    a.release()
  })

  it('different tokens do not collide', () => {
    const a = acquireTelegramTokenLock('111:token-x', { rootDir: lockDir })
    const b = acquireTelegramTokenLock('222:token-y', { rootDir: lockDir })
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    a.release()
    b.release()
  })

  it('release allows re-acquire by another caller', () => {
    const a = acquireTelegramTokenLock('agent:t', { rootDir: lockDir })
    a.release()
    const b = acquireTelegramTokenLock('agent:t', { rootDir: lockDir })
    expect(b).toBeDefined()
    b.release()
  })
})

describe('classifyStartFailure', () => {
  it('classifies error_code 409 as conflict + retryable', () => {
    const v = classifyStartFailure({ error_code: 409, message: 'Conflict' })
    expect(v.kind).toBe('conflict')
    expect(v.retryable).toBe(true)
  })

  it('classifies error_code 401 as auth + non-retryable', () => {
    const v = classifyStartFailure({ error_code: 401, message: 'Unauthorized' })
    expect(v.kind).toBe('auth')
    expect(v.retryable).toBe(false)
  })

  it('classifies ECONNRESET as network + retryable', () => {
    const v = classifyStartFailure(new Error('connect ECONNRESET 1.2.3.4'))
    expect(v.kind).toBe('network')
    expect(v.retryable).toBe(true)
  })

  it('classifies socket hang up as network', () => {
    const v = classifyStartFailure(new Error('socket hang up'))
    expect(v.kind).toBe('network')
  })

  it('classifies aborted as cancelled', () => {
    const v = classifyStartFailure(new Error('AbortError: aborted'))
    expect(v.kind).toBe('cancelled')
    expect(v.retryable).toBe(false)
  })

  it('falls through to fatal for unknown errors', () => {
    const v = classifyStartFailure(new Error('something weird'))
    expect(v.kind).toBe('fatal')
    expect(v.retryable).toBe(false)
  })
})

describe('clearWebhookBeforePolling', () => {
  it('calls bot.api.deleteWebhook with drop_pending_updates=false', async () => {
    let called = false
    let receivedArgs: unknown
    const fakeBot = {
      api: {
        deleteWebhook: async (args: unknown) => {
          called = true
          receivedArgs = args
        },
      },
    }
    await clearWebhookBeforePolling(fakeBot as never)
    expect(called).toBe(true)
    expect(receivedArgs).toEqual({ drop_pending_updates: false })
  })

  it('swallows deleteWebhook errors', async () => {
    const fakeBot = {
      api: {
        deleteWebhook: async () => {
          throw new Error('telegram down')
        },
      },
    }
    await expect(clearWebhookBeforePolling(fakeBot as never)).resolves.toBeUndefined()
  })
})
