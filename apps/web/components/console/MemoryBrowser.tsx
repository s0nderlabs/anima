'use client'

import { zgMainnet } from '@/lib/chain/chain'
import { type SlotEntry, fetchSlots } from '@/lib/chain/inft'
import { decryptMemoryToText } from '@/lib/crypto/memory'
import {
  OPERATOR_BLOB_SCOPES,
  decryptOperatorBlobToText,
  deriveOperatorBlobKey,
  isOperatorBlobBytes,
} from '@/lib/crypto/operator-blob'
import { unpackIfV2 } from '@/lib/crypto/pack-blob'
import { fetchBlobByRootHash } from '@/lib/storage/og'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSignTypedData } from 'wagmi'
import { usePublicClient } from 'wagmi'
import { useAgentContext } from './agent-context'
import { MarkdownView } from './MarkdownView'

type ViewMode = 'prose' | 'source'

type MemFile = {
  slot: SlotEntry
  status: 'loading' | 'ready' | 'placeholder' | 'error' | 'needs-operator-sig'
  body?: string
  error?: string
  /** Raw bytes cached so the operator-sign button can decrypt without refetch. */
  rawBytes?: Uint8Array
  /**
   * v0.24.0: when the decrypted plaintext is a v2 pack envelope, sibling files
   * (every partition file except the root) live here. memory-index packs
   * agent/*.md; profile packs user/*.md.
   */
  packedFiles?: Record<string, string>
}

const MEMORY_SLOTS = ['memory-index', 'identity', 'persona', 'profile'] as const
type MemorySlotName = (typeof MEMORY_SLOTS)[number]

// Slots surfaced in the rail but not part of the prose-decrypt flow.
const META_SLOTS = ['keystore', 'activity-log'] as const
type MetaSlotName = (typeof META_SLOTS)[number]

type RailSlot = MemorySlotName | MetaSlotName

const slotLabel: Record<RailSlot, string> = {
  'memory-index': 'MEMORY.md',
  identity: 'IDENTITY.md',
  persona: 'PERSONA.md',
  profile: 'PROFILE.md',
  keystore: 'keystore',
  'activity-log': 'activity-log',
}

const slotDescription: Record<RailSlot, string> = {
  'memory-index': 'The agent’s index of every memory file it tends.',
  identity: 'Facts the agent knows about itself.',
  persona: 'How the agent prefers to speak. Optional.',
  profile: 'Your private notes. Operator-only, purged on transfer.',
  keystore: 'Encrypted agent privkey. Used to unlock this view.',
  'activity-log': 'Tool-calls, brain responses, errors.',
}

export function MemoryBrowser({
  tokenId,
  memoryKey,
}: {
  tokenId: bigint
  memoryKey: CryptoKey
}) {
  const client = usePublicClient({ chainId: zgMainnet.id })
  const ctx = useAgentContext()
  const [files, setFiles] = useState<Record<MemorySlotName, MemFile> | null>(null)
  const [active, setActive] = useState<RailSlot>('memory-index')

  const profileKey = ctx.unlocked?.profileKey

  useEffect(() => {
    if (!client) return
    let alive = true
    fetchSlots(client, tokenId).then(async slots => {
      const init = Object.fromEntries(
        MEMORY_SLOTS.map(name => {
          const slot = slots.find(s => s.name === name)!
          return [
            name,
            slot.isBootstrap
              ? { slot, status: 'placeholder' as const }
              : { slot, status: 'loading' as const },
          ]
        }),
      ) as Record<MemorySlotName, MemFile>
      if (!alive) return
      setFiles(init)
      for (const name of MEMORY_SLOTS) {
        const f = init[name]
        if (f.status !== 'loading') continue
        ;(async () => {
          try {
            const bytes = await fetchBlobByRootHash(f.slot.hash)
            // PROFILE slot is operator-encrypted (operator HKDF, scope
            // anima-profile-v1). Detect the JSON envelope and route through
            // the operator-blob path, which needs a separate signature.
            if (name === 'profile' && isOperatorBlobBytes(bytes)) {
              if (profileKey) {
                const text = await decryptOperatorBlobToText(bytes, profileKey)
                if (!alive) return
                const { body, packedFiles } = unpackIfV2(text)
                setFiles(prev =>
                  prev
                    ? {
                        ...prev,
                        [name]: { ...prev[name], status: 'ready', body, packedFiles },
                      }
                    : prev,
                )
                return
              }
              if (!alive) return
              setFiles(prev =>
                prev
                  ? {
                      ...prev,
                      [name]: { ...prev[name], status: 'needs-operator-sig', rawBytes: bytes },
                    }
                  : prev,
              )
              return
            }
            const text = await decryptMemoryToText(bytes, memoryKey)
            if (!alive) return
            const { body, packedFiles } = unpackIfV2(text)
            setFiles(prev =>
              prev
                ? { ...prev, [name]: { ...prev[name], status: 'ready', body, packedFiles } }
                : prev,
            )
          } catch (err) {
            if (!alive) return
            setFiles(prev =>
              prev
                ? {
                    ...prev,
                    [name]: {
                      ...prev[name],
                      status: 'error',
                      error: (err as Error).message,
                    },
                  }
                : prev,
            )
          }
        })()
      }
    })
    return () => {
      alive = false
    }
  }, [client, tokenId, memoryKey, profileKey])

  if (!files) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="font-mono text-[11.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          memory · unsealing
        </span>
        <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Pulling the encrypted index from 0G Storage and decrypting in this tab.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-8 pt-4 md:grid-cols-[260px_minmax(0,1fr)] md:gap-12">
      <Rail tokenId={tokenId} files={files} active={active} onSelect={setActive} />
      <DetailPane tokenId={tokenId} files={files} active={active} />
    </div>
  )
}

type RailState =
  | { kind: 'memory'; status: MemFile['status'] }
  | { kind: 'sealed' }
  | { kind: 'external' }

function railState(slot: RailSlot, files: Record<MemorySlotName, MemFile>): RailState {
  if (slot === 'keystore') return { kind: 'sealed' }
  if (slot === 'activity-log') return { kind: 'external' }
  return { kind: 'memory', status: files[slot].status }
}

function statusToken(state: RailState): { dot: string; tone: string; label: string } {
  if (state.kind === 'sealed') {
    return { dot: '▪', tone: 'text-[var(--color-ink-2)]', label: 'sealed' }
  }
  if (state.kind === 'external') {
    return { dot: '→', tone: 'text-[var(--color-ink-2)]', label: 'activity tab' }
  }
  switch (state.status) {
    case 'loading':
      return { dot: '○', tone: 'text-[var(--color-ink-3)]', label: 'decrypting' }
    case 'ready':
      return { dot: '●', tone: 'text-[var(--color-ink)]', label: 'anchored' }
    case 'placeholder':
      return { dot: '○', tone: 'text-[var(--color-ink-3)]', label: 'placeholder' }
    case 'needs-operator-sig':
      return { dot: '◆', tone: 'text-[var(--color-ink-2)]', label: 'sign to read' }
    case 'error':
      return { dot: '●', tone: 'text-[var(--color-ink-2)]', label: 'error' }
  }
}

function Rail({
  tokenId,
  files,
  active,
  onSelect,
}: {
  tokenId: bigint
  files: Record<MemorySlotName, MemFile>
  active: RailSlot
  onSelect: (s: RailSlot) => void
}) {
  const slots: RailSlot[] = [...MEMORY_SLOTS, ...META_SLOTS]
  return (
    <aside className="md:sticky md:top-28 md:self-start">
      <nav className="-mx-3 flex flex-row gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
        {slots.map(slot => {
          const state = railState(slot, files)
          const isActive = active === slot
          const token = statusToken(state)
          const isExternal = state.kind === 'external'
          const className = `group grid shrink-0 gap-1 rounded-md px-3 py-2.5 text-left transition-colors duration-200 md:shrink ${
            isActive
              ? 'bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)]'
              : 'hover:bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)]'
          }`
          const content = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`font-mono text-[13.5px] tracking-tight ${
                    isActive ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
                  }`}
                >
                  {slotLabel[slot]}
                </span>
                <span
                  aria-hidden
                  className={`font-mono text-[12px] leading-none ${token.tone}`}
                  title={token.label}
                >
                  {token.dot}
                </span>
              </div>
              <p
                className={`text-[12.5px] leading-[1.4] ${
                  isActive ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'
                }`}
              >
                {slotDescription[slot]}
              </p>
            </>
          )
          if (isExternal) {
            return (
              <Link key={slot} href={`/console/${tokenId.toString()}/activity`} className={className}>
                {content}
              </Link>
            )
          }
          return (
            <button key={slot} type="button" onClick={() => onSelect(slot)} className={className}>
              {content}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

function DetailPane({
  tokenId,
  files,
  active,
}: {
  tokenId: bigint
  files: Record<MemorySlotName, MemFile>
  active: RailSlot
}) {
  if (active === 'keystore') return <KeystoreCard />
  if (active === 'activity-log') return <ActivityRedirectCard tokenId={tokenId} />
  return <FileDetail slotName={active} file={files[active]} label={slotLabel[active]} />
}

/**
 * Strip leading YAML frontmatter (`---\n...\n---\n`) from a memory file body.
 * The agent writes these blocks for its own indexing tools; they are metadata,
 * not prose. Source view still renders the raw body so operators can see the
 * full file as written on disk.
 */
function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body
  const match = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? body.slice(match[0].length).replace(/^\s+/, '') : body
}

function FileDetail({
  slotName,
  file,
  label,
}: {
  slotName: MemorySlotName
  file: MemFile
  label: string
}) {
  const [mode, setMode] = useState<ViewMode>('prose')
  /** Which file is selected in the prose pane: undefined = root, else sibling filename. */
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const canToggle = file.status === 'ready' && !!file.body
  const packed = file.packedFiles
  const packedNames = packed ? Object.keys(packed).sort() : []
  // v0.24.0: when a v2 envelope is detected, viewing a sibling pulls its
  // content from the packed map instead of the root body.
  const visibleBody =
    selected && packed ? (packed[selected] ?? '') : (file.body ?? '')
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2
          className="font-display text-[clamp(26px,2.6vw,36px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          {selected ?? label}
        </h2>
        {canToggle ? <ViewToggle mode={mode} onChange={setMode} /> : null}
      </header>
      {file.status === 'loading' ? (
        <p className="font-mono text-[12.5px] tracking-[0.22em] text-[var(--color-ink-3)]">
          decrypting…
        </p>
      ) : file.status === 'placeholder' ? (
        <PlaceholderInline />
      ) : file.status === 'needs-operator-sig' ? (
        <ProfileDecryptPrompt />
      ) : file.status === 'error' ? (
        <p className="font-mono text-[12.5px] tracking-[0.22em] text-[var(--color-ink-2)]">
          could not decrypt · {file.error}
        </p>
      ) : (
        <>
          {packedNames.length > 0 ? (
            <PackedSiblingList
              rootLabel={label}
              siblings={packedNames}
              selected={selected}
              onSelect={setSelected}
              slotName={slotName}
            />
          ) : null}
          <article className="rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] px-6 py-7 shadow-[var(--shadow-card)] sm:px-9 sm:py-10">
            {mode === 'prose' ? (
              <MarkdownView content={stripFrontmatter(visibleBody)} />
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.65] text-[var(--color-ink)]">
                {visibleBody}
              </pre>
            )}
          </article>
        </>
      )}
    </section>
  )
}

function PackedSiblingList({
  rootLabel,
  siblings,
  selected,
  onSelect,
  slotName,
}: {
  rootLabel: string
  siblings: string[]
  selected: string | undefined
  onSelect: (name: string | undefined) => void
  slotName: MemorySlotName
}) {
  const partition = slotName === 'memory-index' ? 'agent/' : 'user/'
  return (
    <nav
      aria-label="Packed sibling files"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-paper)] px-4 py-3"
    >
      <span className="font-mono text-[11.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
        packed · {siblings.length + 1} files
      </span>
      <button
        type="button"
        onClick={() => onSelect(undefined)}
        className={`font-mono text-[12.5px] tracking-tight transition-colors ${
          selected === undefined
            ? 'text-[var(--color-ink)] underline decoration-[var(--color-ink)] underline-offset-[3px]'
            : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
        }`}
      >
        {rootLabel}
      </button>
      {siblings.map(name => (
        <button
          key={name}
          type="button"
          onClick={() => onSelect(name)}
          className={`font-mono text-[12.5px] tracking-tight transition-colors ${
            selected === name
              ? 'text-[var(--color-ink)] underline decoration-[var(--color-ink)] underline-offset-[3px]'
              : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
          }`}
          title={`${partition}${name}`}
        >
          {name}
        </button>
      ))}
    </nav>
  )
}

function ProfileDecryptPrompt() {
  const ctx = useAgentContext()
  const account = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'signing' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function decrypt() {
    if (!ctx.agentEOA) {
      setState({ kind: 'error', message: 'no agent address' })
      return
    }
    if (!account.address) {
      setState({ kind: 'error', message: 'connect a wallet first' })
      return
    }
    try {
      setState({ kind: 'signing' })
      const sig = (await signTypedDataAsync({
        domain: { name: 'Anima Keystore', version: '1' },
        types: {
          AgentKeystore: [
            { name: 'agent', type: 'address' },
            { name: 'purpose', type: 'string' },
          ],
        },
        primaryType: 'AgentKeystore',
        message: {
          agent: ctx.agentEOA,
          purpose: OPERATOR_BLOB_SCOPES.PROFILE,
        },
      })) as Hex
      const key = await deriveOperatorBlobKey(sig, OPERATOR_BLOB_SCOPES.PROFILE)
      ctx.setProfileKey(key)
      setState({ kind: 'idle' })
    } catch (err) {
      const message =
        (err as { shortMessage?: string; message?: string }).shortMessage ||
        (err as Error).message ||
        'sign failed'
      setState({ kind: 'error', message })
    }
  }

  return (
    <article className="rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] px-6 py-7 shadow-[var(--shadow-card)] sm:px-9 sm:py-10">
      <div className="grid gap-4">
        <p className="max-w-[60ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          PROFILE.md is operator-scoped. It uses a different key than the rest of memory, so it
          needs one more signature to derive. The signature stays in this tab; nothing is sent on
          chain.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={decrypt}
            disabled={state.kind === 'signing'}
            className="rounded-full bg-[var(--color-ink)] px-6 py-3 text-[14.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
          >
            {state.kind === 'signing' ? 'Signing…' : 'Sign to decrypt PROFILE.md'}
          </button>
          {state.kind === 'error' ? (
            <p className="font-mono text-[12.5px] text-[var(--color-ink-2)]">{state.message}</p>
          ) : null}
        </div>
      </div>
    </article>
  )
}

function PlaceholderInline() {
  return (
    <p className="max-w-[60ch] text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
      The agent has not written to this file yet. Once it does,{' '}
      <code className="font-mono text-[14px] text-[var(--color-ink)]">/sync</code> anchors it on
      chain.
    </p>
  )
}

function KeystoreCard() {
  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2
          className="font-display text-[clamp(26px,2.6vw,36px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          keystore
        </h2>
      </header>
      <p className="max-w-[60ch] text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
        The agent’s private key, AES-GCM wrapped under your operator signature. It’s on chain so a
        new device can re-attach to this agent: connect the same wallet, sign once, the wallet
        unwraps the key, the key decrypts memory.
      </p>
      <p className="max-w-[60ch] text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
        You are already past this gate; that’s why the rest of the tab is readable. The contents
        are not displayed because revealing them would defeat the gate.
      </p>
    </section>
  )
}

function ActivityRedirectCard({ tokenId }: { tokenId: bigint }) {
  return (
    <section className="grid gap-5">
      <header>
        <h2
          className="font-display text-[clamp(26px,2.6vw,36px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          activity-log
        </h2>
      </header>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-6 py-7">
        <p className="max-w-[60ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          Anchored on chain but rendered separately. It is a temporal event stream (tool-calls,
          brain responses, errors), not a mutable document.
        </p>
        <Link
          href={`/console/${tokenId.toString()}/activity`}
          className="group mt-5 inline-flex items-center gap-1.5 text-[14px] text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:decoration-[var(--color-ink)]"
        >
          <span>Open the activity tab</span>
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>
      </div>
    </section>
  )
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const base = 'font-mono text-[11.5px] tracking-[0.22em] transition-colors duration-200'
  return (
    <div className="flex items-baseline gap-3">
      <button
        type="button"
        onClick={() => onChange('prose')}
        className={`${base} ${
          mode === 'prose'
            ? 'text-[var(--color-ink)]'
            : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        prose
      </button>
      <span aria-hidden className="font-mono text-[11.5px] text-[var(--color-ink-3)]">
        ·
      </span>
      <button
        type="button"
        onClick={() => onChange('source')}
        className={`${base} ${
          mode === 'source'
            ? 'text-[var(--color-ink)]'
            : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        source
      </button>
    </div>
  )
}
