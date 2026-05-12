'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createSiweMessage } from 'viem/siwe'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'

export type SiweStatus = 'loading' | 'unauthenticated' | 'signing' | 'authenticated' | 'error'

export type SiweAuth = {
  status: SiweStatus
  address: `0x${string}` | null
  error: string | null
  signIn: () => Promise<boolean>
  signOut: () => Promise<void>
}

const SIGN_TIMEOUT_MS = 60_000

/**
 * Single-step SIWE auth: wallet-connect kicks the sign automatically.
 * Bypasses RainbowKit's AuthenticationProvider so the operator never sees
 * an intermediate "Sign Message" button after picking their wallet.
 */
export function useSiweAuth(): SiweAuth {
  const { address, isConnected, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { disconnectAsync } = useDisconnect()
  const [status, setStatus] = useState<SiweStatus>('loading')
  const [sessionAddress, setSessionAddress] = useState<`0x${string}` | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  // Boot: check whether a server session already exists.
  useEffect(() => {
    let alive = true
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { address?: `0x${string}` | null }) => {
        if (!alive) return
        if (d?.address) {
          setSessionAddress(d.address)
          setStatus('authenticated')
        } else {
          setStatus('unauthenticated')
        }
      })
      .catch(() => {
        if (alive) setStatus('unauthenticated')
      })
    return () => {
      alive = false
    }
  }, [])

  const signIn = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false
    if (!isConnected || !address) {
      setError('connect a wallet first')
      return false
    }
    inFlight.current = true
    setError(null)
    setStatus('signing')
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const nonceResp = await fetch('/api/auth/nonce', { credentials: 'include' })
      const { nonce } = (await nonceResp.json()) as { nonce: string }

      const host = typeof window !== 'undefined' ? window.location.host : ''
      const uri = typeof window !== 'undefined' ? window.location.origin : ''
      const message = createSiweMessage({
        domain: host,
        address,
        statement:
          'Sign in to the Anima console. This signature proves wallet ownership and creates a session cookie. No transactions are sent.',
        uri,
        version: '1',
        chainId: chainId ?? 16661,
        nonce,
      })
      const signaturePromise = signMessageAsync({ message })
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('signing timed out, wallet did not respond')),
          SIGN_TIMEOUT_MS,
        )
      })
      const signature = await Promise.race([signaturePromise, timeoutPromise])

      const verifyResp = await fetch('/api/auth/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })
      if (!verifyResp.ok) {
        const j = (await verifyResp.json().catch(() => ({}))) as { reason?: string }
        throw new Error(j.reason || `verify failed (${verifyResp.status})`)
      }
      setSessionAddress(address)
      setStatus('authenticated')
      return true
    } catch (err) {
      const msg =
        (err as { shortMessage?: string; message?: string }).shortMessage ||
        (err as Error).message ||
        'sign-in failed'
      setError(msg)
      setStatus('unauthenticated')
      return false
    } finally {
      if (timer) clearTimeout(timer)
      inFlight.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected, chainId])

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // best effort
    }
    setSessionAddress(null)
    setStatus('unauthenticated')
    setError(null)
    try {
      await disconnectAsync()
    } catch {
      // best effort
    }
  }, [disconnectAsync])

  // Auto-trigger SIWE the moment a wallet connects, if no session exists.
  useEffect(() => {
    if (!isConnected || !address) return
    if (status !== 'unauthenticated') return
    if (sessionAddress && sessionAddress.toLowerCase() === address.toLowerCase()) return
    // small delay lets the wallet UI close before opening the sign prompt
    const t = setTimeout(() => {
      void signIn()
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, status])

  // If the connected wallet address no longer matches the session, clear it.
  useEffect(() => {
    if (!sessionAddress) return
    if (!isConnected) return
    if (address && address.toLowerCase() !== sessionAddress.toLowerCase()) {
      setSessionAddress(null)
      setStatus('unauthenticated')
    }
  }, [address, isConnected, sessionAddress])

  return {
    status,
    address: status === 'authenticated' ? sessionAddress : null,
    error,
    signIn,
    signOut,
  }
}
