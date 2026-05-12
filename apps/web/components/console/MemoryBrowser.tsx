'use client'

import { type SlotEntry, fetchSlots } from '@/lib/chain/inft'
import { decryptMemoryToText } from '@/lib/crypto/memory'
import { fetchBlobByRootHash } from '@/lib/storage/og'
import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { zgMainnet } from '@/lib/chain/chain'
import { MarkdownView } from './MarkdownView'

type MemFile = {
  slot: SlotEntry
  status: 'loading' | 'ready' | 'placeholder' | 'error'
  body?: string
  error?: string
}

const MEMORY_SLOTS = ['memory-index', 'identity', 'persona', 'profile'] as const
type MemorySlotName = (typeof MEMORY_SLOTS)[number]

const slotLabel: Record<MemorySlotName, string> = {
  'memory-index': 'MEMORY.md',
  identity: 'identity.md',
  persona: 'persona.md',
  profile: 'profile.md',
}

const slotDescription: Record<MemorySlotName, string> = {
  'memory-index': 'The agent’s index of every memory file it tends.',
  identity: 'Facts the agent knows about itself.',
  persona: 'How the agent prefers to speak. Optional.',
  profile: 'Reserved. Likely empty for now.',
}

export function MemoryBrowser({
  tokenId,
  memoryKey,
}: {
  tokenId: bigint
  memoryKey: CryptoKey
}) {
  const client = usePublicClient({ chainId: zgMainnet.id })
  const [files, setFiles] = useState<Record<MemorySlotName, MemFile> | null>(null)

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
      // Decrypt each non-placeholder slot in parallel.
      for (const name of MEMORY_SLOTS) {
        const f = init[name]
        if (f.status !== 'loading') continue
        ;(async () => {
          try {
            const bytes = await fetchBlobByRootHash(f.slot.hash)
            const text = await decryptMemoryToText(bytes, memoryKey)
            if (!alive) return
            setFiles(prev =>
              prev ? { ...prev, [name]: { ...prev[name], status: 'ready', body: text } } : prev,
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
  }, [client, tokenId, memoryKey])

  if (!files) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">MEMORY · UNSEALING</span>
        <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Pulling the encrypted index from 0G Storage and decrypting in this tab.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-12 pt-4">
      {MEMORY_SLOTS.map(name => {
        const file = files[name]
        return (
          <FileBlock
            key={name}
            label={slotLabel[name]}
            description={slotDescription[name]}
            file={file}
            isIndex={name === 'memory-index'}
          />
        )
      })}
    </div>
  )
}

function FileBlock({
  label,
  description,
  file,
  isIndex,
}: {
  label: string
  description: string
  file: MemFile
  isIndex: boolean
}) {
  return (
    <article className="grid gap-4">
      <header className="grid gap-1">
        <span className="kicker">{label.toUpperCase()}</span>
        <p className="text-[15px] leading-[1.6] text-[var(--color-ink-2)]">{description}</p>
      </header>
      {file.status === 'loading' ? (
        <p className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          decrypting…
        </p>
      ) : file.status === 'placeholder' ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-paper)] px-5 py-6">
          <p className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
            slot bootstrap · not yet anchored
          </p>
          <p className="mt-2 text-[15px] leading-[1.55] text-[var(--color-ink-2)]">
            The agent has not written to this file yet. Once it does, /sync anchors it on chain.
          </p>
        </div>
      ) : file.status === 'error' ? (
        <p className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
          could not decrypt · {file.error}
        </p>
      ) : (
        <div
          className={
            isIndex
              ? 'rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] px-6 py-7 shadow-[var(--shadow-card)] sm:px-9 sm:py-10'
              : 'rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-6 py-6 sm:px-9 sm:py-7'
          }
        >
          <MarkdownView content={file.body ?? ''} />
        </div>
      )}
    </article>
  )
}
