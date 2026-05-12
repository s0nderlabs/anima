'use client'

import { useState } from 'react'
import type { Address } from 'viem'
import { isValidEoa, writeAgentEoa } from '@/lib/agent-eoa-cache'
import { useAgentContext } from './agent-context'

export function AgentEoaInput() {
  const ctx = useAgentContext()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    const v = value.trim()
    if (!isValidEoa(v)) {
      setError('Not a valid 0x address (40 hex chars).')
      return
    }
    writeAgentEoa(ctx.tokenId, v as Address)
    ctx.setAgentEOA(v as Address)
    setError(null)
  }

  return (
    <div className="grid gap-5 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-paper)] px-6 py-7 sm:px-9 sm:py-8">
      <div className="grid gap-3">
        <h2
          className="font-display text-[clamp(22px,2.2vw,30px)] font-light leading-[1.15] tracking-tight text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          Paste this agent’s wallet address.
        </h2>
        <p className="max-w-[60ch] text-[15px] leading-[1.6] text-[var(--color-ink-2)]">
          The console couldn’t resolve it from the SANN registry. The agent’s wallet address is
          required to derive the keystore decryption key. You can find it locally:
        </p>
        <div className="font-mono text-[13.5px] leading-7 text-[var(--color-ink)]">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-cream)] px-4 py-3">
            <span className="select-none text-[var(--color-ink-3)]">$ </span>
            anima inspect --json | jq -r '.agent.address'
          </div>
        </div>
      </div>
      <div className="grid gap-3">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoCapitalize="none"
          className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-cream)] px-4 py-3 font-mono text-[14px] text-[var(--color-ink)] outline-none transition focus:border-[var(--color-ink)]"
        />
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={submit}
            className="rounded-full bg-[var(--color-ink)] px-6 py-3 text-[14px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]"
          >
            Use address
          </button>
          {error ? (
            <p className="font-mono text-[12.5px] text-[var(--color-ink-2)]">{error}</p>
          ) : null}
        </div>
        <p className="text-[13.5px] leading-[1.55] text-[var(--color-ink-3)]">
          Cached in this browser per token id. Clears on local storage wipe.
        </p>
      </div>
    </div>
  )
}
