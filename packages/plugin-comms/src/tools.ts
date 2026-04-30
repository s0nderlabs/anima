import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { PathGuard, type ToolDef, coerceInt } from '@s0nderlabs/anima-core'
import { type Address, type Hex, getAddress } from 'viem'
import { z } from 'zod'
import type { ContactStore } from './contacts'
import type { AnimaInboxClient } from './contract'
import { eciesDecryptFromHex, eciesEncryptToHex } from './crypto'
import { encodeEnvelope } from './envelope'
import type { HistoryStore } from './history'
import { ALL_KEY, type MuteStore, parseDurationMs } from './mutes'
import type { PresenceStore } from './presence'
import type { PubkeyResolver } from './pubkey-resolver'
import { type StorageUploader, buildSendArgs } from './storage-spillover'

export interface CommsDeps {
  inbox: AnimaInboxClient
  resolver: PubkeyResolver
  storage: StorageUploader
  contacts: ContactStore
  mutes: MuteStore
  presence: PresenceStore
  history: HistoryStore
  /** Listener handle; tools can introspect (e.g. to know agentEoa). */
  agentEoa: Address
  agentDir: string
  /** Agent privkey: required for agent.fetchFile to ECIES-decrypt blob bodies. */
  agentPrivkey: Hex
}

/**
 * Resolve a `who` argument that may be an `.anima.0g` name, a raw 0x address,
 * OR a contact label the operator added via `agent.contact_add`. Returns
 * null on malformed input or unresolvable name; callers surface that as a
 * tool error so the brain sees a consistent failure shape.
 *
 * Why fall back to contact labels: the brain naturally writes `to: "specter"`
 * after seeing it as a contact in `agent.contacts`, since labels are how it
 * thinks about peers it has met before. Resolving via the local table is
 * cheaper than re-resolving a full `.0g` name on every send.
 */
/**
 * Resolve a `who` argument that may be an `.anima.0g` name, a raw 0x address,
 * OR a contact label the operator added via `agent.contact_add`. Returns
 * null on malformed input or unresolvable name; callers surface that as a
 * tool error so the brain sees a consistent failure shape.
 *
 * Why fall back to contact labels: the brain naturally writes `to: "specter"`
 * after seeing it as a contact in `agent.contacts`, since labels are how it
 * thinks about peers it has met before. Resolving via the local table is
 * cheaper than re-resolving a full `.0g` name on every send.
 *
 * Exported so market-tools.ts can reuse the same resolver chain.
 */
export async function resolveAddrOrName(
  deps: { resolver: PubkeyResolver; contacts: ContactStore },
  who: string,
): Promise<{ addr: Address; name: string | null } | null> {
  if (who.endsWith('.0g')) {
    const r = await deps.resolver.resolve(who).catch(() => null)
    if (!r) return null
    return { addr: r.eoa, name: r.name ?? who }
  }
  if (who.startsWith('0x') && who.length === 42) {
    return { addr: getAddress(who) as Address, name: null }
  }
  const local = deps.contacts.findByLabel(who)
  if (local) return { addr: local.addr, name: local.name ?? who }
  return null
}

/**
 * Resolve recipient (label/0x/.0g) → encrypt → send. ECIES needs the recipient's
 * uncompressed pubkey, which lives only on .anima.0g text records (forward-only),
 * so we always need a .0g name to look up. Raw 0x without a known label fails
 * fast since there's no reverse mapping.
 */
async function sendCore(deps: CommsDeps, to: string, plaintext: Uint8Array, forceStorage = false) {
  const r = await resolveAddrOrName(deps, to)
  if (!r) {
    throw new Error(
      `unrecognized recipient: ${to}. Use a .anima.0g name, 0x address, or contact label.`,
    )
  }
  const lookupName = r.name?.endsWith('.0g')
    ? r.name
    : to.startsWith('0x')
      ? null
      : `${to}.anima.0g`
  if (!lookupName) {
    throw new Error(`raw 0x address ${to} has no published pubkey; reach via .anima.0g name`)
  }
  const resolved = await deps.resolver.resolve(lookupName).catch(() => null)
  if (!resolved) {
    throw new Error(`recipient ${to} has no .anima.0g pubkey published; cannot encrypt`)
  }
  const ciphertextHex = await eciesEncryptToHex(plaintext, resolved.pubkey)
  const ciphertextBytes = Buffer.from(ciphertextHex.slice(2), 'hex')
  const args = await buildSendArgs({
    ciphertext: new Uint8Array(ciphertextBytes),
    storage: deps.storage,
    forceStorage,
  })
  // Send to resolver's current eoa (not r.addr) so the recipient address
  // matches the pubkey we encrypted to. If a .0g name was transferred since a
  // contact was cached, r.addr (cached) and resolved.eoa (current) can differ;
  // sending to the cached address with the new pubkey would silently fail.
  const txHash = await deps.inbox.send(resolved.eoa, args.payload, args.dataHash)
  const recipient = {
    eoa: resolved.eoa,
    pubkey: resolved.pubkey,
    name: resolved.name ?? lookupName,
  }
  return { txHash, recipient, dataHash: args.dataHash, inline: args.payload !== '0x' }
}

// ─── 1. agent.message ───────────────────────────────────────────────────────

const MessageSchema = z.object({
  to: z.string().min(1).describe('Recipient: an .anima.0g name. Raw EOAs require name resolution.'),
  content: z.string().min(1).describe('Plain-text message body.'),
  in_reply_to: z
    .string()
    .optional()
    .describe('Optional tx hash of an earlier message to thread under.'),
})
type MessageArgs = z.infer<typeof MessageSchema>

export function makeMessage(deps: CommsDeps): ToolDef<MessageArgs> {
  return {
    name: 'agent.message',
    description:
      'Send a private encrypted message to another anima agent by `.anima.0g` name. Routes through AnimaInbox singleton on 0G mainnet. Content is ECIES-encrypted to the recipient pubkey; chain only sees ciphertext.',
    searchHint: 'message send a2a chat encrypted dm',
    schema: MessageSchema,
    handler: async args => {
      try {
        const env = encodeEnvelope({
          v: 1,
          type: 'msg',
          content: args.content,
          ...(args.in_reply_to ? { inReplyTo: args.in_reply_to } : {}),
        })
        const { txHash, recipient, dataHash, inline } = await sendCore(deps, args.to, env)
        deps.history.insert({
          txHash,
          logIndex: -1,
          blockNumber: 0,
          fromAddr: deps.agentEoa,
          toAddr: recipient.eoa,
          direction: 'out',
          type: 'msg',
          content: args.content,
          filename: null,
          mime: null,
          size: null,
          inReplyTo: args.in_reply_to ?? null,
          ts: Date.now(),
        })
        return {
          ok: true,
          data: {
            txHash,
            to: recipient.name ?? recipient.eoa,
            inlineCiphertext: inline,
            dataHash: inline ? null : dataHash,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 2. agent.sendFile ──────────────────────────────────────────────────────

const SendFileSchema = z.object({
  to: z.string().min(1),
  path: z.string().min(1).describe('Absolute path on disk to the file.'),
  caption: z.string().optional(),
})
type SendFileArgs = z.infer<typeof SendFileSchema>

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

export function makeSendFile(deps: CommsDeps): ToolDef<SendFileArgs> {
  const guard = new PathGuard({ agentDir: deps.agentDir })
  return {
    name: 'agent.sendFile',
    description:
      'Send a file (any binary, up to 10 MB) to another anima. File body is ECIES-encrypted, uploaded to 0G Storage; the inline event payload only carries an encrypted metadata envelope (filename, mime, size, caption).',
    searchHint: 'send file attach upload binary',
    schema: SendFileSchema,
    handler: async args => {
      try {
        if (!isAbsolute(args.path)) {
          return { ok: false, error: `path must be absolute: ${args.path}` }
        }
        const allowed = guard.check(args.path)
        if (!allowed.allowed) return { ok: false, error: allowed.reason ?? 'protected path' }
        const bytes = readFileSync(args.path)
        if (bytes.byteLength > MAX_FILE_BYTES) {
          return {
            ok: false,
            error: `file too large: ${bytes.byteLength} bytes (limit ${MAX_FILE_BYTES})`,
          }
        }
        const recipient = await deps.resolver.resolve(args.to)

        // Encrypt file body to 0G Storage as a separate dataHash blob.
        const fileCt = await eciesEncryptToHex(new Uint8Array(bytes), recipient.pubkey)
        const fileBytes = Buffer.from(fileCt.slice(2), 'hex')
        const fileDataHash = await deps.storage.put(new Uint8Array(fileBytes))

        // Inline envelope carries the metadata (also ECIES-encrypted).
        const filename = args.path.split('/').pop() ?? 'file'
        const env = encodeEnvelope({
          v: 1,
          type: 'file',
          filename,
          mime: 'application/octet-stream',
          size: bytes.byteLength,
          ...(args.caption ? { caption: args.caption } : {}),
        })
        const envCt = await eciesEncryptToHex(env, recipient.pubkey)
        const envBytes = Buffer.from(envCt.slice(2), 'hex')

        // Send: payload is the metadata envelope (small), dataHash points
        // to the encrypted file body (potentially big).
        const txHash = await deps.inbox.send(
          recipient.eoa,
          `0x${Buffer.from(envBytes).toString('hex')}` as Hex,
          fileDataHash,
        )
        deps.history.insert({
          txHash,
          logIndex: -1,
          blockNumber: 0,
          fromAddr: deps.agentEoa,
          toAddr: recipient.eoa,
          direction: 'out',
          type: 'file',
          content: args.caption ?? '',
          filename,
          mime: 'application/octet-stream',
          size: bytes.byteLength,
          inReplyTo: null,
          ts: Date.now(),
        })
        return {
          ok: true,
          data: { txHash, filename, size: bytes.byteLength, dataHash: fileDataHash },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 3. agent.fetchFile ────────────────────────────────────────────────────

const FetchFileSchema = z.object({
  data_hash: z.string().min(1).describe('0G Storage hash from a prior file message.'),
  save_to: z.string().min(1).describe('Absolute path where the file should be written.'),
})
type FetchFileArgs = z.infer<typeof FetchFileSchema>

export function makeFetchFile(deps: CommsDeps): ToolDef<FetchFileArgs> {
  const guard = new PathGuard({ agentDir: deps.agentDir })
  return {
    name: 'agent.fetchFile',
    description:
      'Download a file referenced by a prior file message. Decrypts via the agent privkey and writes to disk at `save_to`. Path must be absolute and outside protected dirs.',
    searchHint: 'fetch download file attachment receive',
    schema: FetchFileSchema,
    handler: async args => {
      try {
        if (!isAbsolute(args.save_to)) {
          return { ok: false, error: `save_to must be absolute: ${args.save_to}` }
        }
        const allowed = guard.check(args.save_to)
        if (!allowed.allowed) return { ok: false, error: allowed.reason ?? 'protected path' }
        const dataHash = (
          args.data_hash.startsWith('0x') ? args.data_hash : `0x${args.data_hash}`
        ) as Hex
        const cipherBytes = await deps.storage.get(dataHash)
        const cipherHex = `0x${Buffer.from(cipherBytes).toString('hex')}` as Hex
        const plain = await eciesDecryptFromHex(cipherHex, deps.agentPrivkey)
        const dir = dirname(args.save_to)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(args.save_to, plain)
        return { ok: true, data: { saved: args.save_to, size: plain.byteLength } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 4. agent.history ──────────────────────────────────────────────────────

const HistorySchema = z.object({
  peer: z.string().optional().describe('Filter by peer address or .anima.0g name.'),
  limit: coerceInt.refine(n => n > 0 && n <= 200, 'limit 1..200').optional(),
})
type HistoryArgs = z.infer<typeof HistorySchema>

export function makeHistory(deps: CommsDeps): ToolDef<HistoryArgs> {
  return {
    name: 'agent.history',
    description:
      'Query local message history. Optionally filter by peer (address or `.anima.0g` name); returns up to `limit` most recent rows.',
    searchHint: 'history search messages past chat log',
    schema: HistorySchema,
    handler: async args => {
      let peer: Address | undefined
      if (args.peer) {
        const r = await resolveAddrOrName(deps, args.peer)
        if (!r) return { ok: false, error: `cannot resolve ${args.peer}` }
        peer = r.addr
      }
      const rows = deps.history.search({ peer, limit: args.limit })
      return { ok: true, data: { count: rows.length, messages: rows } }
    },
  }
}

// ─── 5. agent.contact_add ──────────────────────────────────────────────────

const ContactAddSchema = z.object({
  who: z.string().min(1),
  label: z.string().optional(),
})
type ContactAddArgs = z.infer<typeof ContactAddSchema>

export function makeContactAdd(deps: CommsDeps): ToolDef<ContactAddArgs> {
  return {
    name: 'agent.contact_add',
    description:
      'Approve a sender as a known contact. After this, inbound messages from them route to the brain queue (instead of waiting in pending).',
    searchHint: 'contact add approve allow whitelist accept',
    schema: ContactAddSchema,
    handler: async args => {
      const r = await resolveAddrOrName(deps, args.who)
      if (!r) return { ok: false, error: `cannot resolve ${args.who}` }
      // Prefer the .anima.0g name when available (it's portable + resolves
      // back to the same address). Custom `args.label` is a nickname; we
      // store the canonical name and let the brain look up either form.
      const name = r.name ?? args.label ?? undefined
      deps.contacts.add(r.addr, name)
      return { ok: true, data: { addr: r.addr, name: name ?? null } }
    },
  }
}

// ─── 6. agent.contact_remove ──────────────────────────────────────────────

const ContactRemoveSchema = z.object({ who: z.string().min(1) })
type ContactRemoveArgs = z.infer<typeof ContactRemoveSchema>

export function makeContactRemove(deps: CommsDeps): ToolDef<ContactRemoveArgs> {
  return {
    name: 'agent.contact_remove',
    description:
      'Remove a sender from contacts. Future inbound messages from them go back to pending.',
    searchHint: 'contact remove unfriend',
    schema: ContactRemoveSchema,
    handler: async args => {
      const r = await resolveAddrOrName(deps, args.who)
      if (!r) return { ok: false, error: `cannot resolve ${args.who}` }
      const had = deps.contacts.remove(r.addr)
      return { ok: true, data: { removed: had, addr: r.addr } }
    },
  }
}

// ─── 7. agent.contacts ───────────────────────────────────────────────────

export function makeContacts(deps: CommsDeps): ToolDef<Record<string, never>> {
  return {
    name: 'agent.contacts',
    description:
      'List approved contacts, pending requests (unknown senders awaiting approval), and blocked addresses.',
    searchHint: 'contacts list peers',
    schema: z.object({}),
    handler: async () => {
      return {
        ok: true,
        data: {
          contacts: deps.contacts.list(),
          pending: deps.contacts.listPending(),
          blocked: deps.contacts.listBlocked(),
        },
      }
    },
  }
}

// ─── 8. agent.block ───────────────────────────────────────────────────────

const BlockSchema = z.object({ who: z.string().min(1) })
type BlockArgs = z.infer<typeof BlockSchema>

export function makeBlock(deps: CommsDeps): ToolDef<BlockArgs> {
  return {
    name: 'agent.block',
    description:
      'Hard-deny a sender. Their messages are dropped before decryption and never logged or shown.',
    searchHint: 'block deny ignore ban',
    schema: BlockSchema,
    handler: async args => {
      const r = await resolveAddrOrName(deps, args.who)
      if (!r) return { ok: false, error: `cannot resolve ${args.who}` }
      deps.contacts.block(r.addr)
      return { ok: true, data: { blocked: r.addr } }
    },
  }
}

// ─── 9. agent.mute ───────────────────────────────────────────────────────

const MuteSchema = z.object({
  who: z.string().min(1).describe(`Address, .anima.0g name, or "all" to mute everyone.`),
  duration: z
    .string()
    .optional()
    .describe('Duration like "30m", "1h", "1d", "7d". Omit for indefinite.'),
})
type MuteArgs = z.infer<typeof MuteSchema>

export function makeMute(deps: CommsDeps): ToolDef<MuteArgs> {
  return {
    name: 'agent.mute',
    description:
      'Silence inbound notifications from a sender (or "all"). Messages still save to history; sender sees nothing change. Optionally timed (e.g. "30m").',
    searchHint: 'mute silence quiet do not disturb',
    schema: MuteSchema,
    handler: async args => {
      const ms = parseDurationMs(args.duration ?? null)
      if (args.who === 'all' || args.who === '*' || args.who === 'everyone') {
        deps.mutes.mute(ALL_KEY, ms)
        return { ok: true, data: { muted: 'all', durationMs: ms } }
      }
      const r = await resolveAddrOrName(deps, args.who)
      if (!r) return { ok: false, error: `cannot resolve ${args.who}` }
      deps.mutes.mute(r.addr, ms)
      return { ok: true, data: { muted: r.addr, durationMs: ms } }
    },
  }
}

// ─── 10. agent.unmute ────────────────────────────────────────────────────

const UnmuteSchema = z.object({ who: z.string().min(1) })
type UnmuteArgs = z.infer<typeof UnmuteSchema>

export function makeUnmute(deps: CommsDeps): ToolDef<UnmuteArgs> {
  return {
    name: 'agent.unmute',
    description: 'Lift a mute on a sender (or "all").',
    searchHint: 'unmute unblock allow notifications',
    schema: UnmuteSchema,
    handler: async args => {
      if (args.who === 'all' || args.who === '*' || args.who === 'everyone') {
        const had = deps.mutes.unmute(ALL_KEY)
        return { ok: true, data: { unmuted: 'all', wasMuted: had } }
      }
      const r = await resolveAddrOrName(deps, args.who)
      if (!r) return { ok: false, error: `cannot resolve ${args.who}` }
      const had = deps.mutes.unmute(r.addr)
      return { ok: true, data: { unmuted: r.addr, wasMuted: had } }
    },
  }
}

// ─── 11. agent.presence ──────────────────────────────────────────────────

const PresenceSchema = z.object({
  state: z.enum(['online', 'away']).describe('online or away'),
  message: z
    .string()
    .optional()
    .describe('Optional status text shown to senders if hint is enabled.'),
})
type PresenceArgs = z.infer<typeof PresenceSchema>

export function makePresence(deps: CommsDeps): ToolDef<PresenceArgs> {
  return {
    name: 'agent.presence',
    description:
      "Set anima's presence: `online` lets messages route to brain immediately; `away` buffers them and reports a single summary on flip back.",
    searchHint: 'presence away online status afk back',
    schema: PresenceSchema,
    handler: async args => {
      const flush = deps.presence.set(args.state, args.message ?? null)
      return {
        ok: true,
        data: { state: args.state, message: args.message ?? null, flushed: flush.flushed },
      }
    },
  }
}
