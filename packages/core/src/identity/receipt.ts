import type { Hex, PublicClient, TransactionReceipt } from 'viem'

/**
 * viem's `waitForTransactionReceipt` throws `TransactionReceiptNotFoundError`
 * from inside its block-watcher when the RPC returns null for a tx that's
 * still propagating. On 0G's eventually-consistent testnet that's common.
 * Wrap with a tolerant poll loop so hackathon-path UX doesn't bail.
 */
export async function waitForReceiptResilient(
  client: PublicClient,
  hash: Hex,
  opts?: { tries?: number; delayMs?: number },
): Promise<TransactionReceipt> {
  const tries = opts?.tries ?? 30
  const delayMs = opts?.delayMs ?? 2000
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      return receipt
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr ?? new Error(`receipt never arrived for ${hash}`)
}
