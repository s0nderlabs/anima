/**
 * @s0nderlabs/anima-plugin-comms
 *
 * A2A messaging via AnimaInbox singleton on 0G Chain. Encrypts to recipient
 * pubkey published via .0g text record; decrypts inbound via the agent's own
 * privkey; pushes envelope-decoded events to the brain queue. The plugin
 * registers 11 brain limbs and one gateway listener.
 *
 * Required side-band ctx (`(ctx as any).comms` field added in Phase 7):
 *   - agentEoa, agentPrivkeyHex
 *   - publicClient, walletClient
 *   - sann (readText)
 *   - storage (put / get on 0G Storage)
 *   - inboxAddress (AnimaInbox singleton)
 *   - startBlock (catch-up floor, e.g. iNFT mint block)
 *   - onDeliver, onOperatorNotice (gateway hooks)
 *
 * Without `ctx.comms`, the plugin registers nothing (graceful no-op for
 * unit-test loaders that don't supply the extras).
 */

import type { NativePlugin, ToolDef } from '@s0nderlabs/anima-core'
import { AnimaInboxClient } from './contract'
import { A2AListener } from './listener'
import { AnimaMarketClient } from './market'
import { MarketListener } from './market-listener'
import {
  makeMarketAcceptResult,
  makeMarketClaimTimeout,
  makeMarketCreateJob,
  makeMarketDispute,
  makeMarketForceClose,
  makeMarketGetJob,
  makeMarketListMyJobs,
  makeMarketMarkDone,
  makeMarketProposeSplit,
} from './market-tools'
import { PubkeyResolver } from './pubkey-resolver'
import {
  makeBlock,
  makeContactAdd,
  makeContactRemove,
  makeContacts,
  makeFetchFile,
  makeHistory,
  makeMessage,
  makeMute,
  makePresence,
  makeSendFile,
  makeUnmute,
} from './tools'

export {
  AnimaInboxClient,
  ANIMA_INBOX_ABI,
  type InboxMessageEvent,
} from './contract'
export {
  AnimaMarketClient,
  ANIMA_MARKET_ABI,
  JOB_STATUS,
  JOB_STATUS_LABEL,
  type Job,
  type JobStatus,
  type JobCreatedEvent,
} from './market'
export { MarketListener, type JobEvent } from './market-listener'
export { MARKETPLACE_GUIDANCE } from './market-guidance'
export {
  formatJobEvent,
  formatJobEventForBrain,
  isActor,
  isJobTerminalKind,
  isParticipant,
  jobEventShouldWakeBrain,
} from './market-format'
export { eciesEncryptToHex, eciesDecryptFromHex } from './crypto'
export {
  type Envelope,
  type MessageEnvelope,
  type FileEnvelope,
  encodeEnvelope,
  decodeEnvelope,
} from './envelope'
export {
  type StorageUploader,
  INLINE_CIPHERTEXT_THRESHOLD,
  ZERO_DATA_HASH,
  buildSendArgs,
  resolveInbound,
} from './storage-spillover'
export { PubkeyResolver, ensureOwnPubkeyPublished } from './pubkey-resolver'
export { ContactStore } from './contacts'
export { MuteStore, ALL_KEY, parseDurationMs } from './mutes'
export { PresenceStore } from './presence'
export { HistoryStore, type HistoryRow } from './history'
export { CursorStore } from './cursor'
export { RateLimiter } from './rate-limit'
export { A2AListener, type DeliveredMessage, type OperatorNotice } from './listener'

const plugin: NativePlugin = {
  name: 'comms',
  register: ctx => {
    const comms = (ctx as unknown as { comms?: CommsRuntimeContext }).comms
    if (!comms) return // soft-init: tests / non-comms contexts

    const inbox = new AnimaInboxClient({
      address: comms.inboxAddress,
      publicClient: comms.publicClient,
      walletClient: comms.walletClient,
    })

    const resolver = new PubkeyResolver({
      publicClient: comms.publicClient,
      agentDir: ctx.agentDir,
      sann: comms.sann,
    })

    const listener = new A2AListener({
      agentEoa: comms.agentEoa,
      agentPrivkey: comms.agentPrivkeyHex,
      inbox,
      publicClient: comms.publicClient,
      agentDir: ctx.agentDir,
      storage: comms.storage,
      startBlock: comms.startBlock,
      onDeliver: comms.onDeliver,
      onOperatorNotice: comms.onOperatorNotice,
    })

    ctx.registerListener({
      name: 'a2a-inbox',
      start: async () => {
        await listener.start()
      },
      stop: async () => {
        listener.stop()
      },
    } as never)

    const deps = {
      inbox,
      resolver,
      storage: comms.storage,
      contacts: listener.getContacts(),
      mutes: listener.getMutes(),
      presence: listener.getPresence(),
      history: listener.getHistory(),
      agentEoa: comms.agentEoa,
      agentDir: ctx.agentDir,
      agentPrivkey: comms.agentPrivkeyHex,
    }

    ctx.registerTool(makeMessage(deps) as ToolDef)
    ctx.registerTool(makeSendFile(deps) as ToolDef)
    ctx.registerTool(makeFetchFile(deps) as ToolDef)
    ctx.registerTool(makeHistory(deps) as ToolDef)
    ctx.registerTool(makeContactAdd(deps) as ToolDef)
    ctx.registerTool(makeContactRemove(deps) as ToolDef)
    ctx.registerTool(makeContacts(deps) as ToolDef)
    ctx.registerTool(makeBlock(deps) as ToolDef)
    ctx.registerTool(makeMute(deps) as ToolDef)
    ctx.registerTool(makeUnmute(deps) as ToolDef)
    ctx.registerTool(makePresence(deps) as ToolDef)

    // Phase 8: AnimaMarket escrow. Optional — only registers if the harness
    // injected `comms.marketAddress` (chat.tsx wiring).
    if (comms.marketAddress) {
      const market = new AnimaMarketClient({
        address: comms.marketAddress,
        publicClient: comms.publicClient,
        walletClient: comms.walletClient,
      })
      const marketListener = new MarketListener({
        agentEoa: comms.agentEoa,
        market,
        publicClient: comms.publicClient,
        startBlock: comms.startBlock,
        onEvent: comms.onJobEvent ?? (() => {}),
      })
      ctx.registerListener({
        name: 'a2a-market',
        start: async () => {
          await marketListener.start()
        },
        stop: async () => {
          marketListener.stop()
        },
      } as never)

      const marketDeps = {
        market,
        resolver,
        contacts: listener.getContacts(),
        agentEoa: comms.agentEoa,
      }
      ctx.registerTool(makeMarketCreateJob(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketMarkDone(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketAcceptResult(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketDispute(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketClaimTimeout(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketForceClose(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketProposeSplit(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketGetJob(marketDeps) as ToolDef)
      ctx.registerTool(makeMarketListMyJobs(marketDeps) as ToolDef)
    }
  },
}

/**
 * Side-band runtime context the harness injects when starting a real chat.
 * Defined as a plain object on PluginContext under `comms` so we don't have
 * to widen the core's PluginContext type for an optional plugin-specific
 * payload.
 */
export interface CommsRuntimeContext {
  agentEoa: `0x${string}`
  agentPrivkeyHex: `0x${string}`
  publicClient: import('viem').PublicClient
  walletClient: import('viem').WalletClient
  sann: { readText: (node: `0x${string}`, key: string) => Promise<string> }
  storage: import('./storage-spillover').StorageUploader
  inboxAddress: `0x${string}`
  startBlock: bigint
  onDeliver: (m: import('./listener').DeliveredMessage) => void
  onOperatorNotice?: (n: import('./listener').OperatorNotice) => void
  /** Optional: AnimaMarket address. When set, plugin registers 9 market.* limbs + listener. */
  marketAddress?: `0x${string}`
  /** Push job lifecycle events to the harness for TUI rendering. */
  onJobEvent?: (e: import('./market-listener').JobEvent) => void
}

export default plugin
