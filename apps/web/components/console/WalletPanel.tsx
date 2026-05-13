'use client'

import {
  LEDGER_MANAGER_ABI,
  LEDGER_MANAGER_MAINNET,
  SANDBOX_PROVIDER_GALILEO,
  SANDBOX_SERVING_ABI,
  SANDBOX_SETTLEMENT_GALILEO,
} from '@/lib/chain/abi'
import { explorerAddrUrl, zgMainnet, zgTestnet } from '@/lib/chain/chain'
import { formatBalanceOG, shortAddress } from '@/lib/format'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'

export function WalletPanel({ agentAddress }: { agentAddress: Address | null }) {
  if (!agentAddress) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="font-mono text-[12px] tracking-[0.04em] text-[var(--color-ink-3)]">
          wallet · waiting on subname
        </span>
        <p className="max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          We could not resolve this agent’s wallet address from the SANN registry. Once registered,
          the agent EOA shows here with its on-chain balance.
        </p>
      </div>
    )
  }
  return <Inner agentAddress={agentAddress} />
}

function Inner({ agentAddress }: { agentAddress: Address }) {
  const operator = useAccount()
  const STALE_TIME = 30_000
  const native = useBalance({
    address: agentAddress,
    chainId: zgMainnet.id,
    query: { staleTime: STALE_TIME, refetchOnWindowFocus: false },
  })
  const ledger = useReadContract({
    chainId: zgMainnet.id,
    address: LEDGER_MANAGER_MAINNET,
    abi: LEDGER_MANAGER_ABI,
    functionName: 'getLedger',
    args: [agentAddress],
    query: { retry: 0, staleTime: STALE_TIME, refetchOnWindowFocus: false },
  })
  const sandbox = useReadContract({
    chainId: zgTestnet.id,
    address: SANDBOX_SETTLEMENT_GALILEO,
    abi: SANDBOX_SERVING_ABI,
    functionName: 'getBalance',
    args: operator.address ? [operator.address, SANDBOX_PROVIDER_GALILEO] : undefined,
    query: {
      enabled: !!operator.address,
      retry: 0,
      staleTime: STALE_TIME,
      refetchOnWindowFocus: false,
    },
  })

  const [shimmer, setShimmer] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShimmer(true), 60)
    return () => clearTimeout(t)
  }, [])

  const ledgerData = ledger.data as
    | { availableBalance: bigint; totalBalance: bigint }
    | undefined
  const ledgerExists = !!ledgerData && ledgerData.totalBalance > 0n
  const sandboxWei = (sandbox.data as bigint | undefined) ?? 0n

  return (
    <div
      className="grid gap-14 pt-6"
      style={{
        opacity: shimmer ? 1 : 0,
        transition: 'opacity 0.6s cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      <Section title="0G Mainnet">
        <Row
          label="Native gas"
          state={
            native.isLoading
              ? { kind: 'loading' }
              : native.error
                ? { kind: 'error', message: native.error.message }
                : native.data
                  ? { kind: 'ready', primary: formatBalanceOG(native.data.value) }
                  : { kind: 'unset', text: 'No native balance.' }
          }
          footer={<AddressLink address={agentAddress} label={shortAddress(agentAddress, 10, 8)} />}
        />

        <Row
          label="Compute ledger"
          state={
            ledger.isLoading
              ? { kind: 'loading' }
              : ledger.error
                ? { kind: 'error', message: ledger.error.message }
                : !ledgerExists
                  ? {
                      kind: 'unset',
                      text: 'No ledger yet. Brain inference draws from this envelope, opened by anima init.',
                    }
                  : {
                      kind: 'ready',
                      primary: formatBalanceOG(ledgerData.availableBalance),
                      breakdown: [
                        {
                          label: 'locked',
                          value: formatBalanceOG(
                            ledgerData.totalBalance - ledgerData.availableBalance,
                          ),
                        },
                        { label: 'total', value: formatBalanceOG(ledgerData.totalBalance) },
                      ],
                    }
          }
          footer={
            <AddressLink
              address={LEDGER_MANAGER_MAINNET}
              label={`ledger ${shortAddress(LEDGER_MANAGER_MAINNET, 6, 4)}`}
            />
          }
        />
      </Section>

      <Section title="Galileo Testnet">
        <Row
          label="Sandbox reserve"
          state={
            !operator.address
              ? { kind: 'unset', text: 'Connect your operator wallet to read the sandbox reserve.' }
              : sandbox.isLoading
                ? { kind: 'loading' }
                : sandbox.error
                  ? { kind: 'error', message: sandbox.error.message }
                  : sandboxWei === 0n
                    ? {
                        kind: 'unset',
                        text: 'No reserve. Funded by the operator only when the agent runs in the 0G Sandbox harness.',
                      }
                    : {
                        kind: 'ready',
                        primary: formatBalanceOG(sandboxWei),
                        sub: operator.address
                          ? `funded by operator ${shortAddress(operator.address, 6, 4)}`
                          : '',
                      }
          }
          footer={
            <AddressLink
              address={SANDBOX_SETTLEMENT_GALILEO}
              label={`settlement ${shortAddress(SANDBOX_SETTLEMENT_GALILEO, 6, 4)}`}
              testnet
            />
          }
        />
      </Section>

      <p className="max-w-[60ch] text-[14.5px] leading-[1.65] text-[var(--color-ink-3)]">
        Sends and swaps stay in the CLI and Telegram. The console is read-only.
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-7">
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[12px] tracking-[0.04em] text-[var(--color-ink-3)]">
          {title}
        </span>
        <span className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <div className="grid gap-9">{children}</div>
    </section>
  )
}

type RowState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unset'; text: string }
  | {
      kind: 'ready'
      primary: string
      sub?: string
      breakdown?: { label: string; value: string }[]
    }

function Row({
  label,
  state,
  footer,
}: {
  label: string
  state: RowState
  footer: ReactNode
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-8">
      <div className="grid gap-1">
        <span className="font-mono text-[14px] tracking-[0.005em] text-[var(--color-ink)]">
          {label}
        </span>
        <span className="font-mono text-[12px] leading-[1.5] text-[var(--color-ink-3)]">
          {footer}
        </span>
      </div>
      <div className="grid gap-1.5 sm:justify-items-end sm:text-right">
        {state.kind === 'loading' && (
          <span className="font-mono text-[13px] text-[var(--color-ink-3)]">reading chain…</span>
        )}
        {state.kind === 'error' && (
          <span className="max-w-[44ch] font-mono text-[12.5px] leading-[1.55] text-[var(--color-ink-2)]">
            error · {state.message}
          </span>
        )}
        {state.kind === 'unset' && (
          <p className="max-w-[44ch] text-[14px] leading-[1.6] text-[var(--color-ink-3)] sm:text-right">
            {state.text}
          </p>
        )}
        {state.kind === 'ready' && (
          <>
            <p
              className="font-display font-light leading-[1] text-[var(--color-ink)]"
              style={{
                fontSize: 'clamp(28px, 2.8vw, 36px)',
                fontVariationSettings: '"opsz" 72, "SOFT" 20, "WONK" 0',
              }}
            >
              {state.primary}
              <span className="ml-2 align-baseline font-mono text-[0.42em] tracking-[0.04em] text-[var(--color-ink-2)]">
                0G
              </span>
            </p>
            {state.sub && (
              <span className="font-mono text-[12.5px] leading-[1.55] text-[var(--color-ink-3)]">
                {state.sub}
              </span>
            )}
            {state.breakdown && state.breakdown.length > 0 && (
              <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[12.5px] leading-[1.55] text-[var(--color-ink-3)] sm:justify-end">
                {state.breakdown.map((b) => (
                  <div key={b.label} className="contents">
                    <dt className="text-[var(--color-ink-3)]">{b.label}</dt>
                    <dd className="text-right text-[var(--color-ink-2)]">{b.value} 0G</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function AddressLink({
  address,
  label,
  testnet = false,
}: {
  address: Address
  label: string
  testnet?: boolean
}) {
  return (
    <Link
      href={testnet ? `https://chainscan-galileo.0g.ai/address/${address}` : explorerAddrUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 font-mono text-[12px] text-[var(--color-ink-3)] transition hover:text-[var(--color-ink)]"
    >
      {label} <span aria-hidden>↗</span>
    </Link>
  )
}
