import { formatEther } from 'viem'

/**
 * Render a wei bigint as a 6-decimal 0G string. Matches the statusline,
 * `anima ledger balance`, and `anima balance` output styles. Always emits
 * exactly 6 decimal places (zero-padded) so columns align.
 */
export function format0G(wei: bigint): string {
  const raw = formatEther(wei)
  const [whole, frac = ''] = raw.split('.')
  return `${whole}.${frac.padEnd(6, '0').slice(0, 6)}`
}
