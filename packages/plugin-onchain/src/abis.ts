/**
 * Typed ABIs for plugin-onchain. Small ABIs use `parseAbi` inline so viem can
 * infer arg/return types. The big vendored JSON ABIs (SwapRouter, Quoter,
 * Factory) load via JSON import + `as Abi` cast — too large to inline,
 * generated from the canonical JAINE testnet artifacts (bytecode-equivalent
 * on mainnet, verified May 1 2026).
 */

import { type Abi, parseAbi } from 'viem'
import factoryJson from '../abis/factory.json' with { type: 'json' }
import quoterJson from '../abis/quoter.json' with { type: 'json' }
import swapRouterJson from '../abis/swap-router.json' with { type: 'json' }

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])

export const WETH9_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address to, uint256 wad) returns (bool)',
  'function approve(address spender, uint256 wad) returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

// `aggregate3` is `payable` on-chain but we only ever call it for batched
// reads (no msg.value). Marking it `view` here lets viem's `readContract`
// type-narrowing keep `aggregate3` callable; the runtime contract still
// accepts the call without msg.value.
export const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
])

export const GIMO_POOL_ABI = parseAbi([
  'function stake(string referrer) payable',
  'function unstake(uint256 amount)',
  'function withdraw()',
  'event Staked(address indexed user, uint256 amount0g, uint256 stogMinted, string referrer)',
  'event Unstaked(address indexed user, uint256 stogBurned, uint256 amount0g)',
  'event Withdrawn(address indexed user, uint256 amount0g)',
])

export const STOG_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function getRate() view returns (uint256)',
])

export const SWAP_ROUTER_ABI = swapRouterJson as Abi
export const QUOTER_ABI = quoterJson as Abi
export const FACTORY_ABI = factoryJson as Abi

/** All known function fragments concatenated, for `analysis.decodeCalldata`. */
export const ALL_KNOWN_ABIS: Abi = [
  ...(SWAP_ROUTER_ABI as readonly unknown[]),
  ...(QUOTER_ABI as readonly unknown[]),
  ...(FACTORY_ABI as readonly unknown[]),
  ...(WETH9_ABI as readonly unknown[]),
  ...(ERC20_ABI as readonly unknown[]),
  ...(MULTICALL3_ABI as readonly unknown[]),
  ...(GIMO_POOL_ABI as readonly unknown[]),
  ...(STOG_ABI as readonly unknown[]),
] as Abi
