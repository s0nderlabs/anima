import { test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StubBrain } from '../brain/stub'
import { defineConfig } from '../config'
import { StubIdentity } from '../identity/stub'
import { LocalStubStorage } from '../storage/local-stub'
import { Runtime } from './runtime'

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const prev = process.env.ANIMA_ROOT
  const tmp = mkdtempSync(join(tmpdir(), 'anima-root-'))
  process.env.ANIMA_ROOT = tmp
  try {
    return await fn(tmp)
  } finally {
    process.env.ANIMA_ROOT = prev
    rmSync(tmp, { recursive: true, force: true })
  }
}

test('runtime boots, seeds memory dir, routes stub brain echo', async () => {
  await withTempRoot(async root => {
    const ownerAddr = '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec'
    const agentAddr = `0x${'a'.repeat(40)}`
    const identity = new StubIdentity(ownerAddr, agentAddr)
    const brain = new StubBrain()
    const storage = new LocalStubStorage(join(root, 'storage-stub-test'))

    const runtime = new Runtime({
      config: defineConfig({ network: '0g-testnet' }),
      identity,
      brain,
      storage,
    })

    await runtime.start()

    await runtime.fire({
      source: 'stdin',
      payload: { label: 'hello', data: 'hello world' },
    })

    await new Promise(r => setTimeout(r, 50))

    await runtime.stop()
  })
})
