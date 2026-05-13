'use client'

import { zgMainnet } from '@/lib/chain/chain'
import { fetchSlots } from '@/lib/chain/inft'
import { decryptKeystoreBlob, deriveKeystoreKey } from '@/lib/crypto/keystore'
import { deriveMemoryKey } from '@/lib/crypto/memory'
import { keystoreTypedData } from '@/lib/crypto/typed-data'
import { fetchBlobByRootHash } from '@/lib/storage/og'
import { useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useConfig, useConnect, useSignTypedData } from 'wagmi'
import { usePublicClient } from 'wagmi'
import { useAgentContext } from './agent-context'

type UnlockState =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'fetching' }
  | { kind: 'decrypting' }
  | { kind: 'error'; message: string }

type Eip1193Provider = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>
}

type WagmiConnector = { getProvider: () => Promise<unknown> }

export function UnlockKeystore({
  agentAddress,
  onUnlocked,
}: {
  agentAddress: `0x${string}`
  onUnlocked?: () => void
}) {
  const ctx = useAgentContext()
  const client = usePublicClient({ chainId: zgMainnet.id })
  const account = useAccount()
  const config = useConfig()
  const { connectAsync, connectors } = useConnect()
  const { signTypedDataAsync } = useSignTypedData()
  const [state, setState] = useState<UnlockState>({ kind: 'idle' })

  async function unlock() {
    if (!client) {
      setState({ kind: 'error', message: 'no chain client' })
      return
    }
    let signer = account.address
    let activeConnector = account.connector as WagmiConnector | undefined
    if (!signer) {
      const recent =
        typeof window === 'undefined' ? null : localStorage.getItem('wagmi.recentConnectorId')
      const targetId = recent ? recent.replace(/^"|"$/g, '') : null
      const connector =
        connectors.find(c => c.id === targetId) ||
        connectors.find(c => c.type === 'injected') ||
        connectors[0]
      if (!connector) {
        setState({ kind: 'error', message: 'no wallet connector available' })
        return
      }
      try {
        setState({ kind: 'signing' })
        const result = await connectAsync({ connector, chainId: config.chains[0].id })
        signer = result.accounts[0]
        activeConnector = connector as unknown as WagmiConnector
      } catch (err) {
        const msg =
          (err as { shortMessage?: string; message?: string }).shortMessage ||
          (err as Error).message ||
          'connect failed'
        setState({ kind: 'error', message: msg })
        return
      }
    }
    if (!signer) {
      setState({ kind: 'error', message: 'no wallet connected' })
      return
    }
    try {
      const typed = keystoreTypedData(agentAddress)

      setState({ kind: 'fetching' })
      const slots = await fetchSlots(client, ctx.tokenId)
      const keystoreSlot = slots.find(s => s.name === 'keystore')
      if (!keystoreSlot) throw new Error('no keystore slot')
      if (keystoreSlot.isBootstrap) {
        throw new Error(
          'keystore not anchored yet — agent has not completed init sync. Try `anima sync` on the CLI first.',
        )
      }
      const blob = await fetchBlobByRootHash(keystoreSlot.hash)

      // Attempt 1: canonical EIP-712 sig via wagmi/viem. viem auto-adds
      // `EIP712Domain: [{name},{version}]` to types before sending the
      // typed-data to the wallet, producing the standard EIP-712 domain
      // separator. Decrypts every keystore encrypted by a LocalAccount
      // operator signer (raw-privkey, keychain, keystore-file).
      setState({ kind: 'signing' })
      const canonicalSig = (await signTypedDataAsync({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      })) as Hex

      setState({ kind: 'decrypting' })
      let agentPrivkey: Hex | null = null
      try {
        const ksKey = await deriveKeystoreKey(canonicalSig)
        agentPrivkey = await decryptKeystoreBlob(blob, ksKey)
      } catch (canonicalErr) {
        // Attempt 2: WC-legacy variant. Agents init'd via the v0.8.x
        // WalletConnect operator signer (packages/core/src/operator/
        // walletconnect.ts) bypassed viem's hashTypedData entirely and
        // shipped typed-data verbatim through `eth_signTypedData_v4`
        // without an `EIP712Domain` types entry. MetaMask's `sanitizeData`
        // then inserted `EIP712Domain: []` (empty), so the wallet hashed
        // the domain separator over a typeHash of `keccak256("EIP712Domain()")`
        // with no field values — a different hash than the canonical path.
        // Reproduce that by talking to the connector's raw EIP-1193
        // provider directly, sending types without EIP712Domain.
        console.warn('[unlock] canonical decrypt failed, trying WC-legacy variant')
        if (!activeConnector) {
          throw canonicalErr instanceof Error
            ? canonicalErr
            : new Error('canonical decrypt failed and no connector for fallback')
        }
        setState({ kind: 'signing' })
        const provider = (await activeConnector.getProvider()) as Eip1193Provider
        const wcLegacyPayload = JSON.stringify({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        })
        const wcLegacySig = (await provider.request({
          method: 'eth_signTypedData_v4',
          params: [signer, wcLegacyPayload],
        })) as Hex
        setState({ kind: 'decrypting' })
        const ksKey = await deriveKeystoreKey(wcLegacySig)
        agentPrivkey = await decryptKeystoreBlob(blob, ksKey)
        console.log('[unlock] decrypted with WC-legacy empty-EIP712Domain variant')
      }

      if (!agentPrivkey) {
        throw new Error('keystore decrypt failed on every known variant')
      }

      const memoryKey = await deriveMemoryKey(agentPrivkey)
      ctx.setUnlocked({ agentPrivkey, memoryKey, unlockedAt: Date.now() })
      setState({ kind: 'idle' })
      onUnlocked?.()
    } catch (err) {
      const message =
        (err as { shortMessage?: string; message?: string }).shortMessage ||
        (err as Error).message ||
        'unknown error'
      setState({ kind: 'error', message })
    }
  }

  return (
    <div className="grid gap-6 pt-2">
      <div className="grid gap-3">
        <h2
          className="font-display text-[clamp(24px,2.6vw,38px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          Sign to read this agent.
        </h2>
        <p className="max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          The signature derives an AES key, decrypts the keystore in this browser tab, and never
          leaves. Close the tab and the key is gone. No transaction is sent.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={unlock}
          disabled={
            state.kind === 'signing' || state.kind === 'fetching' || state.kind === 'decrypting'
          }
          className="rounded-full bg-[var(--color-ink)] px-7 py-3.5 text-[15px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
        >
          {state.kind === 'idle' ? 'Unlock' : null}
          {state.kind === 'signing' ? 'Signing…' : null}
          {state.kind === 'fetching' ? 'Fetching blob…' : null}
          {state.kind === 'decrypting' ? 'Decrypting…' : null}
          {state.kind === 'error' ? 'Retry' : null}
        </button>
        {state.kind === 'error' ? (
          <p className="font-mono text-[12.5px] text-[var(--color-ink-2)]">{state.message}</p>
        ) : null}
      </div>
    </div>
  )
}
