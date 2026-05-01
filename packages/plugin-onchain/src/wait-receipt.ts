/**
 * Wrapper for viem's `waitForTransactionReceipt` with 0G-mainnet-tuned
 * polling. The default 4s poll occasionally times out on 0G even when the
 * tx lands in 1-2s; we bump to 1.5s with a generous retry budget. The
 * helper also catches viem's `TransactionReceiptNotFoundError` (intermittent
 * RPC null responses immediately after inclusion) and retries.
 */

import type { Hex, PublicClient, TransactionReceipt } from 'viem'

const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_POLL_MS = 1_500

export async function waitForReceipt(
  client: PublicClient,
  hash: Hex,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TransactionReceipt> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await client.getTransactionReceipt({ hash })
      return r
    } catch (e) {
      lastErr = e
      // intermittent "not found" — keep polling
    }
    await new Promise(r => setTimeout(r, DEFAULT_POLL_MS))
  }
  throw new Error(
    `tx receipt timeout after ${timeoutMs}ms for ${hash}; lastErr=${(lastErr as Error)?.message ?? 'unknown'}`,
  )
}
