// Tests for the v0.24.11 robustness fixes in A2AListener:
//  - handleEvent idempotency (no double brain-wake on duplicate event)
//  - periodic safety-net catch-up (recovers events the live subscribe missed)
//
// We don't spin a real chain — these tests stub the AnimaInboxClient with a
// scripted event queue and verify the listener's filter chain + idempotency
// works end-to-end through the real handleEvent / history / contacts / cursor
// stores.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derivePubkeyHex } from '@s0nderlabs/anima-core'
import type { Address, Hex, PublicClient } from 'viem'
import type { AnimaInboxClient, InboxMessageEvent } from './contract'
import { eciesEncryptToHex } from './crypto'
import { CursorStore } from './cursor'
import { encodeEnvelope } from './envelope'
import { A2AListener, type DeliveredMessage, type OperatorNotice } from './listener'
import type { StorageUploader } from './storage-spillover'

const ALICE: Address = '0x1234567890123456789012345678901234567890'
const BOB_PRIV: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
const BOB_ADDR: Address = '0x19e7e376e7c213b7e7e9c2a8e9e7c213b7e7e9c2'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'a2a-listener-test-'))

// Pre-encrypted ciphertext for "hello" sent from ALICE to BOB.
async function buildEvent(opts: {
  from?: Address
  to?: Address
  bobPubkey: Hex
  content: string
  txHash: Hex
  logIndex: number
  blockNumber: bigint
}): Promise<InboxMessageEvent> {
  const envBytes = encodeEnvelope({ v: 1, type: 'msg', content: opts.content })
  const ciphertextHex = await eciesEncryptToHex(envBytes, opts.bobPubkey)
  return {
    from: opts.from ?? ALICE,
    to: opts.to ?? BOB_ADDR,
    payload: ciphertextHex,
    dataHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    blockNumber: opts.blockNumber,
    txHash: opts.txHash,
    logIndex: opts.logIndex,
  }
}

interface StubScript {
  // Events to return on next getMessagesFor call. Drained on read.
  pending: InboxMessageEvent[]
  liveQueue: InboxMessageEvent[]
  liveCallbacks: ((m: InboxMessageEvent) => void)[]
}

function stubInbox(script: StubScript): AnimaInboxClient {
  return {
    address: '0xaaaa' as Address,
    async send(): Promise<Hex> {
      throw new Error('not used in test')
    },
    async getMessagesFor(_: Address, from: bigint, to: bigint): Promise<InboxMessageEvent[]> {
      // Return events whose blockNumber falls in [from, to].
      return script.pending.filter(e => e.blockNumber >= from && e.blockNumber <= to)
    },
    watchMessagesFor(_: Address, cb: (m: InboxMessageEvent) => void): () => void {
      script.liveCallbacks.push(cb)
      // Fire any already-queued live events immediately.
      for (const e of script.liveQueue.splice(0)) cb(e)
      return () => {
        const idx = script.liveCallbacks.indexOf(cb)
        if (idx >= 0) script.liveCallbacks.splice(idx, 1)
      }
    },
  } as unknown as AnimaInboxClient
}

function stubPublicClient(head = 1000n): PublicClient {
  return {
    async getBlockNumber(): Promise<bigint> {
      return head
    },
  } as unknown as PublicClient
}

const stubStorage: StorageUploader = {
  async put(): Promise<Hex> {
    throw new Error('not used')
  },
  async get(): Promise<Uint8Array> {
    throw new Error('inline ciphertext only in test')
  },
}

// Derive BOB's pubkey for ECIES encryption in the events.
const BOB_PUBKEY: Hex = derivePubkeyHex(BOB_PRIV)

describe('A2AListener idempotency + safety-net (v0.24.11)', () => {
  it('handleEvent does NOT re-wake brain when same event delivered twice', async () => {
    const pubkey = BOB_PUBKEY
    const d = tempDir()

    const script: StubScript = { pending: [], liveQueue: [], liveCallbacks: [] }
    const inbox = stubInbox(script)
    const client = stubPublicClient(1000n)

    const delivered: DeliveredMessage[] = []
    const notices: OperatorNotice[] = []

    const listener = new A2AListener({
      agentEoa: BOB_ADDR,
      agentPrivkey: BOB_PRIV,
      inbox,
      publicClient: client,
      agentDir: d,
      storage: stubStorage,
      startBlock: 999n,
      onDeliver: m => delivered.push(m),
      onOperatorNotice: n => notices.push(n),
      catchUpIntervalMs: 0, // disable periodic timer; we drive manually
    })

    // Pre-approve ALICE as a contact so onDeliver fires (otherwise pending).
    listener.getContacts().add(ALICE, 'alice')

    await listener.start()

    const ev = await buildEvent({
      bobPubkey: pubkey,
      content: 'one',
      txHash: '0xev1' as Hex,
      logIndex: 0,
      blockNumber: 999n,
    })

    // First delivery via live subscribe path.
    for (const cb of script.liveCallbacks) cb(ev)
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 50))

    // Second delivery — same (txHash, logIndex). Must be idempotent.
    for (const cb of script.liveCallbacks) cb(ev)
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 50))

    expect(delivered.length).toBe(1)
    expect(delivered[0]?.envelope.type).toBe('msg')
    if (delivered[0]?.envelope.type === 'msg') {
      expect(delivered[0].envelope.content).toBe('one')
    }
    expect(notices.length).toBe(0)
    expect(listener.getHistory().search({ peer: ALICE }).length).toBe(1)

    listener.stop()
    rmSync(d, { recursive: true, force: true })
  })

  it('safety-net catch-up recovers events the live subscribe missed', async () => {
    const pubkey = BOB_PUBKEY
    const d = tempDir()

    // Build TWO events. We'll route one through live (succeeds) and one
    // through getMessagesFor only (simulates the live-drift bug).
    const evLive = await buildEvent({
      bobPubkey: pubkey,
      content: 'live-delivered',
      txHash: '0xlive' as Hex,
      logIndex: 0,
      blockNumber: 998n,
    })
    const evDropped = await buildEvent({
      bobPubkey: pubkey,
      content: 'live-missed-but-rescanned',
      txHash: '0xmissed' as Hex,
      logIndex: 0,
      blockNumber: 999n,
    })

    // getMessagesFor returns BOTH (RPC has them). The live subscribe only
    // delivers evLive — evDropped is silently skipped, mirroring the prod
    // drift behavior.
    const script: StubScript = {
      pending: [evLive, evDropped],
      liveQueue: [],
      liveCallbacks: [],
    }
    const inbox = stubInbox(script)
    const client = stubPublicClient(1000n)

    const delivered: DeliveredMessage[] = []
    const listener = new A2AListener({
      agentEoa: BOB_ADDR,
      agentPrivkey: BOB_PRIV,
      inbox,
      publicClient: client,
      agentDir: d,
      storage: stubStorage,
      startBlock: 0n, // initIfZero falls back to head=1000n
      onDeliver: m => delivered.push(m),
      catchUpIntervalMs: 0, // disable timer; we run safety scan manually
      catchUpSafetyBlocks: 500n,
    })
    listener.getContacts().add(ALICE, 'alice')

    // Pre-seed cursor so the FIRST start() catch-up only scans head+1 to
    // head (no-op) — simulates a daemon that's been running and "thinks" it
    // has caught up.
    listener.getHistory() // ensure dir created
    new CursorStore(d).initIfZero(1000n)

    await listener.start()
    // start() catches up from cursor+1 (1001) > head (1000) → no-op.
    // Live: only evLive fires through subscribe.
    for (const cb of script.liveCallbacks) cb(evLive)
    await new Promise(r => setTimeout(r, 30))

    expect(delivered.length).toBe(1)
    expect(listener.getHistory().search({ peer: ALICE }).length).toBe(1)

    // Now drive a safety-net catch-up manually. It should re-scan the last
    // 500 blocks, find evDropped (which the live subscribe missed), insert
    // it, and onDeliver it. evLive is in history already → INSERT OR IGNORE
    // → no double-wake.
    // @ts-expect-error: accessing private for the test surface
    await listener.catchUp({ safety: true })

    expect(delivered.length).toBe(2)
    const contents = delivered.map(d => (d.envelope.type === 'msg' ? d.envelope.content : ''))
    expect(contents).toContain('live-delivered')
    expect(contents).toContain('live-missed-but-rescanned')

    listener.stop()
    rmSync(d, { recursive: true, force: true })
  })

  it('safety-net replay through already-stored events stays no-op', async () => {
    const pubkey = BOB_PUBKEY
    const d = tempDir()

    const ev = await buildEvent({
      bobPubkey: pubkey,
      content: 'hi',
      txHash: '0xreplay' as Hex,
      logIndex: 0,
      blockNumber: 500n,
    })

    const script: StubScript = { pending: [ev], liveQueue: [], liveCallbacks: [] }
    const inbox = stubInbox(script)
    const client = stubPublicClient(1000n)
    const delivered: DeliveredMessage[] = []

    const listener = new A2AListener({
      agentEoa: BOB_ADDR,
      agentPrivkey: BOB_PRIV,
      inbox,
      publicClient: client,
      agentDir: d,
      storage: stubStorage,
      startBlock: 1n,
      onDeliver: m => delivered.push(m),
      catchUpIntervalMs: 0,
      catchUpSafetyBlocks: 1000n,
    })
    listener.getContacts().add(ALICE, 'alice')
    await listener.start()
    // start() seeds cursor to startBlock=1, then catchUp scans 2..1000 and
    // finds ev at block 500. Should deliver once.
    expect(delivered.length).toBe(1)

    // Now run safety-net 3 times. INSERT OR IGNORE + bail-on-duplicate
    // must keep deliver-count at 1.
    for (let i = 0; i < 3; i++) {
      // @ts-expect-error: accessing private for the test surface
      await listener.catchUp({ safety: true })
    }
    expect(delivered.length).toBe(1)
    expect(listener.getHistory().search({ peer: ALICE }).length).toBe(1)

    listener.stop()
    rmSync(d, { recursive: true, force: true })
  })
})
