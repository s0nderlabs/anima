import type { Address, Hex, PublicClient } from 'viem'
import { ContactStore } from './contacts'
import type { AnimaInboxClient, InboxMessageEvent } from './contract'
import { eciesDecryptFromHex } from './crypto'
import { CursorStore } from './cursor'
import { type Envelope, decodeEnvelope } from './envelope'
import { HistoryStore } from './history'
import { MuteStore } from './mutes'
import { PresenceStore } from './presence'
import { RateLimiter } from './rate-limit'
import { type StorageUploader, resolveInbound } from './storage-spillover'

/**
 * Listener for AnimaInbox.Message events targeting the agent's own EOA.
 * Boot sequence:
 *   1. cursor catch-up via eth_getLogs, paginated by `chunkBlocks`.
 *   2. switch to WS eth_subscribe for live events.
 *   3. on WS drop, re-catch-up from current cursor.
 *
 * Filter chain per inbound:
 *   blocked -> drop silently
 *   mute / global mute -> save to history, no brain queue (presence.bump if away)
 *   not in contacts -> recordPending, surface "X wants to chat" once
 *   rate limited (non-contact only) -> drop
 *   contact + not muted -> push to brain queue, save to history
 */

export interface ListenerOpts {
  agentEoa: Address
  agentPrivkey: Hex
  inbox: AnimaInboxClient
  publicClient: PublicClient
  agentDir: string
  storage: StorageUploader
  /** Block to start from when cursor is unset (typically iNFT mint block). */
  startBlock: bigint
  /** Push delivered messages to the brain queue. */
  onDeliver: (delivered: DeliveredMessage) => void
  /** One-shot operator notification, e.g. "alice wants to chat". */
  onOperatorNotice?: (notice: OperatorNotice) => void
  /** Logs-getLogs chunk size; default 1000 blocks. */
  chunkBlocks?: bigint
  /** Rate limiter config; default 10/60s. */
  rateLimit?: { capacity: number; windowMs: number }
}

export interface DeliveredMessage {
  txHash: Hex
  logIndex: number
  blockNumber: bigint
  from: Address
  /**
   * Friendly name for `from`: contact label if the receiver added the sender
   * as a contact (preferring `.anima.0g` form when known), else null. Chat
   * UI prefers this over the raw address; brain prompt context uses it too.
   */
  fromLabel: string | null
  envelope: Envelope
  /**
   * Chain-event dataHash. For msg envelopes this is ZERO_DATA_HASH (no
   * spillover) or the storage hash when the ciphertext exceeded the inline
   * threshold. For file envelopes this is the encrypted file BODY hash that
   * agent.fetchFile downloads.
   */
  dataHash: Hex
}

export type OperatorNotice =
  | { kind: 'pending-request'; from: Address }
  | { kind: 'rate-limit-drop'; from: Address }
  | { kind: 'decrypt-failed'; from: Address; reason: string }
  | { kind: 'fetch-failed'; from: Address; reason: string }

export class A2AListener {
  private readonly opts: ListenerOpts
  private readonly contacts: ContactStore
  private readonly mutes: MuteStore
  private readonly presence: PresenceStore
  private readonly cursor: CursorStore
  private readonly history: HistoryStore
  private readonly limiter: RateLimiter
  private unwatch: (() => void) | null = null
  private running = false

  constructor(opts: ListenerOpts) {
    this.opts = opts
    this.contacts = new ContactStore(opts.agentDir)
    this.mutes = new MuteStore(opts.agentDir)
    this.presence = new PresenceStore(opts.agentDir)
    this.cursor = new CursorStore(opts.agentDir)
    this.history = new HistoryStore(opts.agentDir)
    const rl = opts.rateLimit ?? { capacity: 10, windowMs: 60_000 }
    this.limiter = new RateLimiter(rl)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    // Seed the cursor on first run. `startBlock` may be 0n (chat doesn't know
    // the iNFT mint block); fall back to current chain head to avoid scanning
    // all of mainnet from genesis on a fresh install.
    if (this.cursor.get() === 0n) {
      const seed =
        this.opts.startBlock > 0n
          ? this.opts.startBlock
          : await this.opts.publicClient.getBlockNumber()
      this.cursor.initIfZero(seed)
    }
    await this.catchUp()
    this.subscribe()
  }

  stop(): void {
    this.running = false
    if (this.unwatch) {
      this.unwatch()
      this.unwatch = null
    }
    this.history.close()
  }

  /** Expose stores for tools to call into. */
  getContacts(): ContactStore {
    return this.contacts
  }
  getMutes(): MuteStore {
    return this.mutes
  }
  getPresence(): PresenceStore {
    return this.presence
  }
  getHistory(): HistoryStore {
    return this.history
  }

  private async catchUp(): Promise<void> {
    const head = await this.opts.publicClient.getBlockNumber()
    const chunk = this.opts.chunkBlocks ?? 1000n
    let from = this.cursor.get() + 1n
    if (from > head) return
    while (from <= head) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n
      const events = await this.opts.inbox.getMessagesFor(this.opts.agentEoa, from, to)
      for (const ev of events) await this.handleEvent(ev)
      this.cursor.set(to)
      from = to + 1n
    }
  }

  private subscribe(): void {
    this.unwatch = this.opts.inbox.watchMessagesFor(this.opts.agentEoa, ev => {
      void this.handleEvent(ev).catch(err => {
        // listener never throws to viem; surface as operator notice instead
        this.opts.onOperatorNotice?.({
          kind: 'decrypt-failed',
          from: ev.from,
          reason: (err as Error).message.slice(0, 120),
        })
      })
      // advance cursor lazily; on each live event update to its block
      if (ev.blockNumber > this.cursor.get()) this.cursor.set(ev.blockNumber)
    })
  }

  private async handleEvent(ev: InboxMessageEvent): Promise<void> {
    // 1. blocked -> drop entirely, no decrypt, no history
    if (this.contacts.isBlocked(ev.from)) return

    // 2. fetch ciphertext (inline or from storage)
    let ciphertext: Uint8Array
    try {
      ciphertext = await resolveInbound({
        payload: ev.payload,
        dataHash: ev.dataHash,
        storage: this.opts.storage,
      })
    } catch (e) {
      this.opts.onOperatorNotice?.({
        kind: 'fetch-failed',
        from: ev.from,
        reason: (e as Error).message.slice(0, 120),
      })
      return
    }

    // 3. decrypt
    let env: Envelope
    try {
      const plaintext = await eciesDecryptFromHex(
        `0x${Buffer.from(ciphertext).toString('hex')}` as Hex,
        this.opts.agentPrivkey,
      )
      env = decodeEnvelope(plaintext)
    } catch (e) {
      this.opts.onOperatorNotice?.({
        kind: 'decrypt-failed',
        from: ev.from,
        reason: (e as Error).message.slice(0, 120),
      })
      return
    }

    // 4. always log to history (regardless of mute / contact state)
    this.history.insert({
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      blockNumber: Number(ev.blockNumber),
      fromAddr: ev.from,
      toAddr: ev.to,
      direction: 'in',
      type: env.type,
      content: env.type === 'msg' ? env.content : (env.caption ?? ''),
      filename: env.type === 'file' ? env.filename : null,
      mime: env.type === 'file' ? env.mime : null,
      size: env.type === 'file' ? env.size : null,
      inReplyTo: env.inReplyTo ?? null,
      ts: Date.now(),
    })

    // 5. mute -> stop here (history kept, brain not notified)
    if (this.mutes.isMuted(ev.from)) {
      if (this.presence.isAway()) this.presence.bump()
      return
    }

    // 6. presence away -> buffer
    if (this.presence.isAway()) {
      this.presence.bump()
      return
    }

    // 7. contact gate
    const contact = this.contacts.find(ev.from)
    if (!contact) {
      // Non-contact path: rate-limit FIRST, then surface pending notice.
      if (this.limiter.shouldDrop(ev.from)) {
        this.opts.onOperatorNotice?.({ kind: 'rate-limit-drop', from: ev.from })
        return
      }
      const isNew = this.contacts.recordPending(ev.from)
      if (isNew) {
        this.opts.onOperatorNotice?.({ kind: 'pending-request', from: ev.from })
      }
      return
    }

    // 8. contact + not muted + online -> deliver to brain
    this.opts.onDeliver({
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      blockNumber: ev.blockNumber,
      from: ev.from,
      fromLabel: contact.name ?? null,
      envelope: env,
      dataHash: ev.dataHash,
    })
  }
}
