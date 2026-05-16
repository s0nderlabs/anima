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
 *   4. v0.24.11: periodic safety-net catch-up re-scans the last
 *      `catchUpSafetyBlocks` every `catchUpIntervalMs` to recover events the
 *      live subscription silently dropped on long-running daemons.
 *      Idempotency: INSERT OR IGNORE in HistoryStore + handleEvent bails
 *      before any side effect when the row is a duplicate.
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
  /**
   * How many blocks to re-scan backward from the cursor on every periodic
   * catch-up tick. The live `watchContractEvent` subscription has been
   * observed to silently miss events after long uptimes (v0.24.x bug,
   * diagnosed May 16 2026); this safety window catches them. Default 240
   * blocks (~12 min on 0G's ~3s block time, well within RPC log-window
   * limits). Idempotency comes from `INSERT OR IGNORE` + handleEvent's
   * bail-on-duplicate path.
   */
  catchUpSafetyBlocks?: bigint
  /**
   * How often to run the safety-net periodic catch-up. Default 60s. Set to
   * 0 to disable (e.g. unit tests that drive the listener manually).
   */
  catchUpIntervalMs?: number
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
  private periodicTimer: ReturnType<typeof setInterval> | null = null

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
    // v0.24.11: safety-net periodic catch-up. Live `watchContractEvent` has
    // been observed to silently drift in long-running daemons (May 16 2026)
    // — onLogs stops firing for new events even though the subscription
    // handle is still alive. This timer re-scans the last
    // catchUpSafetyBlocks every catchUpIntervalMs; INSERT OR IGNORE +
    // handleEvent's bail-on-duplicate keep it idempotent so the brain
    // never re-wakes for a message it already processed.
    const intervalMs = this.opts.catchUpIntervalMs ?? 60_000
    if (intervalMs > 0) {
      this.periodicTimer = setInterval(() => {
        void this.catchUp({ safety: true }).catch(() => {
          // swallow — next tick will retry. Errors are not actionable
          // here; the operator-notice channel is reserved for per-event
          // failures (fetch/decrypt), not periodic-scan transients.
        })
      }, intervalMs)
      // Don't keep the bun event loop alive solely for this timer; the
      // daemon owns its own lifecycle.
      this.periodicTimer.unref?.()
    }
  }

  stop(): void {
    this.running = false
    if (this.unwatch) {
      this.unwatch()
      this.unwatch = null
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
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

  /**
   * Pull events from `cursor+1` (or `cursor-safety` for safety-net mode) to
   * the current chain head, in chunked getLogs calls. handleEvent is
   * idempotent — replays of already-inserted events no-op via INSERT OR
   * IGNORE + bail-on-duplicate.
   *
   * @param opts.safety When `true`, re-scan the last `catchUpSafetyBlocks`
   *   from the cursor BACKWARD instead of forward-only. Used by the periodic
   *   safety-net tick to catch events the live subscription missed.
   */
  private async catchUp(opts: { safety?: boolean } = {}): Promise<void> {
    const head = await this.opts.publicClient.getBlockNumber()
    const chunk = this.opts.chunkBlocks ?? 1000n
    const cursor = this.cursor.get()
    let from: bigint
    if (opts.safety) {
      const safety = this.opts.catchUpSafetyBlocks ?? 240n
      from = cursor > safety ? cursor - safety : 1n
    } else {
      from = cursor + 1n
    }
    if (from > head) return
    while (from <= head) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n
      const events = await this.opts.inbox.getMessagesFor(this.opts.agentEoa, from, to)
      for (const ev of events) await this.handleEvent(ev)
      // Advance cursor only when the scan is making forward progress beyond
      // the current value; safety-net re-scans never move the cursor
      // backward (that would defeat their own next tick's bound).
      if (to > cursor) this.cursor.set(to)
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

    // 1b. v0.24.11: cheap duplicate gate BEFORE the expensive resolve+decrypt
    //    steps. The safety-net periodic catch-up (every 60s) re-scans the
    //    last `catchUpSafetyBlocks` blocks; without this PK lookup we would
    //    re-fetch every spillover blob from 0G Storage (HTTP, retried) AND
    //    re-run ECIES decrypt for every inline message in the window, every
    //    minute. The final INSERT OR IGNORE in step 4 still defends against
    //    concurrent first-time inserts (live + safety-net racing on a fresh
    //    event), but the common case (replay of an already-stored row)
    //    short-circuits here.
    if (this.history.has(ev.txHash, ev.logIndex)) return

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

    // 4. always log to history (regardless of mute / contact state). The
    //    return value is `true` if this is the first time we're recording
    //    the (txHash, logIndex) pair, `false` if a previous tick (live
    //    subscribe OR earlier safety-net catch-up) already recorded it.
    //    Duplicate replays must bail BEFORE steps 5-8 so the brain isn't
    //    re-woken / contact-recorded-twice / rate-limit-double-charged for
    //    a message it already saw.
    const inserted = this.history.insert({
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
    if (!inserted) return

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
