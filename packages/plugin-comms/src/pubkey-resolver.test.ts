import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derivePubkeyHex } from '@s0nderlabs/anima-core'
import type { Address, Hex, PublicClient } from 'viem'
import { PubkeyResolver } from './pubkey-resolver'

const ALICE_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ALICE_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address // arbitrary, not derived

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anima-pubkey-test-'))
}

function fakeSann(records: Record<string, Record<string, string>>) {
  // records: { node => { key => value } }
  return {
    async readText(node: Hex, key: string): Promise<string> {
      const e = records[node.toLowerCase()]
      if (!e) throw new Error(`no node ${node}`)
      const v = e[key]
      if (v === undefined) throw new Error(`no key ${key}`)
      return v
    },
  }
}

describe('PubkeyResolver: input format', () => {
  it('rejects empty input', async () => {
    const dir = tempDir()
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({}),
    })
    await expect(r.resolve('   ')).rejects.toThrow(/empty recipient/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects raw 0x EOA with directive', async () => {
    const dir = tempDir()
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({}),
    })
    await expect(r.resolve(`0x${'a'.repeat(40)}`)).rejects.toThrow(/use .anima.0g name|MVP/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects unknown formats', async () => {
    const dir = tempDir()
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({}),
    })
    await expect(r.resolve('alice@example.com')).rejects.toThrow(/unrecognized/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects non-anima .0g names', async () => {
    const dir = tempDir()
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({}),
    })
    await expect(r.resolve('foo.bar.0g')).rejects.toThrow(/only \*.anima.0g/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('PubkeyResolver: subname text records', () => {
  it('returns eoa + pubkey for a fully published subname', async () => {
    const dir = tempDir()
    const { subnameNode } = require('@s0nderlabs/anima-core')
    const node = subnameNode('alice')
    const pubkey = derivePubkeyHex(ALICE_PRIV)
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({ [node.toLowerCase()]: { address: ALICE_ADDR, pubkey } }),
    })
    const out = await r.resolve('alice.anima.0g')
    expect(out.eoa.toLowerCase()).toBe(ALICE_ADDR.toLowerCase())
    expect(out.pubkey.toLowerCase()).toBe(pubkey.toLowerCase())
    expect(out.name).toBe('alice.anima.0g')
    expect(out.source).toBe('subname-text-record')
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws when address record is missing', async () => {
    const dir = tempDir()
    const { subnameNode } = require('@s0nderlabs/anima-core')
    const node = subnameNode('lonely')
    const pubkey = derivePubkeyHex(ALICE_PRIV)
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({ [node.toLowerCase()]: { pubkey } }),
    })
    await expect(r.resolve('lonely.anima.0g')).rejects.toThrow(/address text record not set/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws with backfill directive when pubkey record missing', async () => {
    const dir = tempDir()
    const { subnameNode } = require('@s0nderlabs/anima-core')
    const node = subnameNode('legacy')
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann: fakeSann({ [node.toLowerCase()]: { address: ALICE_ADDR } }),
    })
    await expect(r.resolve('legacy.anima.0g')).rejects.toThrow(/publish-pubkey/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('caches results for repeat lookups', async () => {
    const dir = tempDir()
    const { subnameNode } = require('@s0nderlabs/anima-core')
    const _node = subnameNode('cached')
    const pubkey = derivePubkeyHex(ALICE_PRIV)
    let calls = 0
    const sann = {
      async readText(_node: Hex, _key: string) {
        calls++
        return _key === 'address' ? ALICE_ADDR : pubkey
      },
    }
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann,
    })
    const a = await r.resolve('cached.anima.0g')
    const b = await r.resolve('cached.anima.0g')
    expect(a.source).toBe('subname-text-record')
    expect(b.source).toBe('cache')
    expect(calls).toBe(2) // two reads on first lookup, none on second
    expect(existsSync(join(dir, 'comms', 'pubkey-cache.json'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('invalidate() drops a cached row', async () => {
    const dir = tempDir()
    const { subnameNode } = require('@s0nderlabs/anima-core')
    const _node = subnameNode('drop')
    const pubkey = derivePubkeyHex(ALICE_PRIV)
    let calls = 0
    const sann = {
      async readText(_node: Hex, _key: string) {
        calls++
        return _key === 'address' ? ALICE_ADDR : pubkey
      },
    }
    const r = new PubkeyResolver({
      publicClient: {} as unknown as PublicClient,
      agentDir: dir,
      sann,
    })
    await r.resolve('drop.anima.0g')
    r.invalidate('drop.anima.0g')
    await r.resolve('drop.anima.0g')
    expect(calls).toBe(4) // re-read after invalidate
    rmSync(dir, { recursive: true, force: true })
  })
})
