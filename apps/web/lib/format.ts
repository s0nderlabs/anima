import type { Address, Hex } from 'viem'

export function shortAddress(a: Address | string, head = 6, tail = 4): string {
  if (!a) return ''
  if (a.length <= head + tail + 2) return a
  return `${a.slice(0, head)}…${a.slice(-tail)}`
}

export function shortHash(h: Hex | string, head = 8, tail = 6): string {
  if (!h) return ''
  if (h.length <= head + tail + 2) return h
  return `${h.slice(0, head)}…${h.slice(-tail)}`
}

export function formatBigInt(n: bigint): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatBalanceOG(weiBigInt: bigint, decimals = 4): string {
  // 0G has 18 decimals like ETH.
  const negative = weiBigInt < 0n
  const w = negative ? -weiBigInt : weiBigInt
  const base = 10n ** 18n
  const whole = w / base
  const frac = w % base
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`
}
