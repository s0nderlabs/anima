import { describe, expect, it } from 'bun:test'
import type { Hex } from 'viem'
import {
  INLINE_CIPHERTEXT_THRESHOLD,
  type StorageUploader,
  ZERO_DATA_HASH,
  buildSendArgs,
  resolveInbound,
} from './storage-spillover'

function inMemoryStorage(): StorageUploader & { puts: number; gets: number } {
  const blobs = new Map<string, Uint8Array>()
  let puts = 0
  let gets = 0
  let counter = 1
  return {
    get puts() {
      return puts
    },
    get gets() {
      return gets
    },
    async put(bytes: Uint8Array) {
      puts++
      // Use a counter-derived hash so all-zero ciphertexts don't collide with
      // ZERO_DATA_HASH.
      const id = counter++
      const hash = `0x${id.toString(16).padStart(64, '0')}` as Hex
      blobs.set(hash.toLowerCase(), bytes)
      return hash
    },
    async get(dataHash: Hex) {
      gets++
      const b = blobs.get(dataHash.toLowerCase())
      if (!b) throw new Error(`no blob for ${dataHash}`)
      return b
    },
  }
}

describe('buildSendArgs', () => {
  it('inline path: returns hex payload + zero hash', async () => {
    const ct = new Uint8Array(100)
    const storage = inMemoryStorage()
    const out = await buildSendArgs({ ciphertext: ct, storage })
    expect(out.payload.startsWith('0x')).toBe(true)
    expect(out.payload.length).toBe(2 + 200) // 0x + 100 bytes hex
    expect(out.dataHash).toBe(ZERO_DATA_HASH)
    expect(storage.puts).toBe(0)
  })

  it('storage path: empty payload + real dataHash when above threshold', async () => {
    const ct = new Uint8Array(INLINE_CIPHERTEXT_THRESHOLD + 100)
    const storage = inMemoryStorage()
    const out = await buildSendArgs({ ciphertext: ct, storage })
    expect(out.payload).toBe('0x')
    expect(out.dataHash).not.toBe(ZERO_DATA_HASH)
    expect(storage.puts).toBe(1)
  })

  it('forces storage when forceStorage=true even for tiny payload', async () => {
    const ct = new Uint8Array(10)
    const storage = inMemoryStorage()
    const out = await buildSendArgs({ ciphertext: ct, storage, forceStorage: true })
    expect(out.payload).toBe('0x')
    expect(out.dataHash).not.toBe(ZERO_DATA_HASH)
    expect(storage.puts).toBe(1)
  })

  it('boundary: exactly threshold goes to storage', async () => {
    const ct = new Uint8Array(INLINE_CIPHERTEXT_THRESHOLD)
    const storage = inMemoryStorage()
    const out = await buildSendArgs({ ciphertext: ct, storage })
    expect(out.payload).toBe('0x')
    expect(storage.puts).toBe(1)
  })

  it('boundary: one below threshold stays inline', async () => {
    const ct = new Uint8Array(INLINE_CIPHERTEXT_THRESHOLD - 1)
    const storage = inMemoryStorage()
    const out = await buildSendArgs({ ciphertext: ct, storage })
    expect(out.payload.length).toBe(2 + (INLINE_CIPHERTEXT_THRESHOLD - 1) * 2)
    expect(storage.puts).toBe(0)
  })
})

describe('resolveInbound', () => {
  it('returns inline payload when dataHash is zero', async () => {
    const storage = inMemoryStorage()
    const original = new Uint8Array([1, 2, 3, 4, 5])
    const out = await resolveInbound({
      payload: '0x0102030405' as Hex,
      dataHash: ZERO_DATA_HASH,
      storage,
    })
    expect(out).toEqual(original)
    expect(storage.gets).toBe(0)
  })

  it('fetches from storage when payload empty + dataHash set', async () => {
    const storage = inMemoryStorage()
    const big = new Uint8Array(500)
    big.fill(7)
    const hash = await storage.put(big)
    const out = await resolveInbound({
      payload: '0x' as Hex,
      dataHash: hash,
      storage,
    })
    expect(out).toEqual(big)
    expect(storage.gets).toBe(1)
  })

  it('throws when both payload and dataHash are empty', async () => {
    const storage = inMemoryStorage()
    await expect(
      resolveInbound({ payload: '0x' as Hex, dataHash: ZERO_DATA_HASH, storage }),
    ).rejects.toThrow(/inbound message has neither/)
  })

  it('prefers inline when both are set', async () => {
    const storage = inMemoryStorage()
    const out = await resolveInbound({
      payload: '0xabcd' as Hex,
      dataHash: `0x${'aa'.repeat(32)}` as Hex,
      storage,
    })
    expect(out).toEqual(new Uint8Array([0xab, 0xcd]))
    expect(storage.gets).toBe(0)
  })
})
