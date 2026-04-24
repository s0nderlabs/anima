import {
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
} from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { type AnimaNetwork, NETWORK_CHAIN_ID, NETWORK_RPC } from './config'

/** 0G networks enforce a minimum fee. 2.5 gwei matches the observed RPC floor. */
export const MIN_GAS_PRICE = 2_500_000_000n

export function ogChain(network: AnimaNetwork): Chain {
  return defineChain({
    id: NETWORK_CHAIN_ID[network],
    name: network === '0g-mainnet' ? '0G Aristotle' : '0G Galileo Testnet',
    nativeCurrency: { name: 'ZeroG', symbol: '0G', decimals: 18 },
    rpcUrls: { default: { http: [NETWORK_RPC[network]] } },
  })
}

export interface ViemClients {
  chain: Chain
  account: PrivateKeyAccount
  publicClient: PublicClient
  walletClient: WalletClient
}

export function makeViemClients(opts: { network: AnimaNetwork; privkeyHex: Hex }): ViemClients {
  const chain = ogChain(opts.network)
  const account = privateKeyToAccount(opts.privkeyHex)
  const transport = http(NETWORK_RPC[opts.network])
  const publicClient = createPublicClient({ transport, chain })
  const walletClient = createWalletClient({ transport, account, chain })
  return { chain, account, publicClient, walletClient }
}
