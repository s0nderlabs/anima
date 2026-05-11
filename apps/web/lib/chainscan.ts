const CHAINSCAN_BASE = 'https://chainscan.0g.ai'

export const CONTRACTS = {
  AnimaAgentNFT: '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
  AnimaInbox: '0xcd9266b1cb31ad9d1a8c6a17a9fd0d9d3e7f2589',
  AnimaMarket: '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB',
  SubnameRegistrar: '0x33d92d6a1f4b88ad7b2c9c1f9b9b62fa8b4fdd98',
} as const

export function txUrl(hash: string) {
  return `${CHAINSCAN_BASE}/tx/${hash}`
}

export function addressUrl(address: string) {
  return `${CHAINSCAN_BASE}/address/${address}`
}

export function tokenUrl(contract: string, tokenId: string | number) {
  return `${CHAINSCAN_BASE}/token/${contract}?tokenId=${tokenId}`
}

export function truncate(value: string, head = 6, tail = 4): string {
  if (!value) return ''
  if (value.length <= head + tail + 2) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}
