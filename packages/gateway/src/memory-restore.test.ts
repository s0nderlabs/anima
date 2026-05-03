import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type IntelligentDataEntry,
  deriveMemoryKey,
  encryptMemoryBytes,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { restoreMemoryFromChain } from './memory-restore'

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000' as const
const HASH_A = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const HASH_B = '0x2222222222222222222222222222222222222222222222222222222222222222' as const
const HASH_C = '0x3333333333333333333333333333333333333333333333333333333333333333' as const
const CONTRACT_ADDR = '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address

async function setupAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anima-restore-test-'))
  await mkdir(join(dir, 'memory', 'agent'), { recursive: true })
  await mkdir(join(dir, 'memory', 'user'), { recursive: true })
  return dir
}

interface BaseOpts {
  network: '0g-mainnet'
  contractAddress: Address
  tokenId: bigint
  agentPrivkey: Hex
  agentDir: string
  fetchSlots: () => Promise<IntelligentDataEntry[]>
  downloadBlob: (h: string) => Promise<Uint8Array | null>
}

function baseOpts(
  agentDir: string,
  fetchSlots: () => Promise<IntelligentDataEntry[]>,
  downloadBlob: (h: string) => Promise<Uint8Array | null>,
  agentPrivkey: Hex = generatePrivateKey(),
): BaseOpts {
  return {
    network: '0g-mainnet',
    contractAddress: CONTRACT_ADDR,
    tokenId: 6n,
    agentPrivkey,
    agentDir,
    fetchSlots,
    downloadBlob,
  }
}

describe('restoreMemoryFromChain', () => {
  test('no-op when no slots returned (fresh agent)', async () => {
    const dir = await setupAgentDir()
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [],
        async () => null,
      ),
    )
    expect(outcomes).toEqual([])
  })

  test('skips unset slots (dataHash === 0x0)', async () => {
    const dir = await setupAgentDir()
    let downloadCalled = false
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [{ dataDescription: 'memory-index', dataHash: ZERO }],
        async () => {
          downloadCalled = true
          return null
        },
      ),
    )
    expect(downloadCalled).toBe(false)
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason).toBe('unset')
  })

  test('restores memory-index, identity, and activity-log to correct paths', async () => {
    const dir = await setupAgentDir()
    const agentPrivkey = generatePrivateKey()
    const key = deriveMemoryKey(agentPrivkey)
    const blobs = new Map<string, Uint8Array>()
    blobs.set(HASH_A, encryptMemoryBytes(new TextEncoder().encode('# MEMORY\n- index'), key))
    blobs.set(HASH_B, encryptMemoryBytes(new TextEncoder().encode('# Identity\nname: enigma'), key))
    blobs.set(HASH_C, encryptMemoryBytes(new TextEncoder().encode('{"ts":0,"kind":"foo"}\n'), key))

    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [
          { dataDescription: 'memory-index', dataHash: HASH_A },
          { dataDescription: 'identity', dataHash: HASH_B },
          { dataDescription: 'activity-log', dataHash: HASH_C },
        ],
        async h => blobs.get(h) ?? null,
        agentPrivkey,
      ),
    )

    expect(outcomes.filter(o => o.status === 'restored').length).toBe(3)
    expect(await readFile(join(dir, 'memory/MEMORY.md'), 'utf8')).toBe('# MEMORY\n- index')
    expect(await readFile(join(dir, 'memory/agent/identity.md'), 'utf8')).toBe(
      '# Identity\nname: enigma',
    )
    expect(await readFile(join(dir, 'activity.jsonl'), 'utf8')).toBe('{"ts":0,"kind":"foo"}\n')
  })

  test('local non-empty file wins over chain blob', async () => {
    const dir = await setupAgentDir()
    await writeFile(join(dir, 'memory/MEMORY.md'), '# LOCAL WINS')

    const agentPrivkey = generatePrivateKey()
    const key = deriveMemoryKey(agentPrivkey)
    const ciphertext = encryptMemoryBytes(new TextEncoder().encode('# from chain'), key)

    let downloadCalled = false
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [{ dataDescription: 'memory-index', dataHash: HASH_A }],
        async () => {
          downloadCalled = true
          return ciphertext
        },
        agentPrivkey,
      ),
    )

    expect(downloadCalled).toBe(false)
    expect(outcomes[0]!.status).toBe('skipped')
    expect(outcomes[0]!.reason).toBe('local-wins')
    expect(await readFile(join(dir, 'memory/MEMORY.md'), 'utf8')).toBe('# LOCAL WINS')
  })

  test('blob-not-found is per-slot, does not throw', async () => {
    const dir = await setupAgentDir()
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [
          { dataDescription: 'memory-index', dataHash: HASH_A },
          { dataDescription: 'persona', dataHash: HASH_B },
        ],
        async h =>
          h === HASH_A
            ? null
            : encryptMemoryBytes(
                new TextEncoder().encode('# Persona'),
                deriveMemoryKey(generatePrivateKey()),
              ),
      ),
    )

    expect(outcomes.length).toBe(2)
    expect(outcomes[0]!.status).toBe('failed')
    expect(outcomes[0]!.reason).toBe('blob-not-found')
    expect(outcomes[1]!.status).toBe('failed')
  })

  test('keystore + profile slots are filtered before download', async () => {
    const dir = await setupAgentDir()
    let downloadCalled = false
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => [
          { dataDescription: 'keystore', dataHash: HASH_A },
          { dataDescription: 'profile', dataHash: HASH_B },
        ],
        async () => {
          downloadCalled = true
          return null
        },
      ),
    )
    expect(downloadCalled).toBe(false)
    expect(outcomes).toEqual([])
  })

  test('chain read failure is swallowed, returns empty outcomes', async () => {
    const dir = await setupAgentDir()
    const outcomes = await restoreMemoryFromChain(
      baseOpts(
        dir,
        async () => {
          throw new Error('rpc down')
        },
        async () => null,
      ),
    )
    expect(outcomes).toEqual([])
  })
})
