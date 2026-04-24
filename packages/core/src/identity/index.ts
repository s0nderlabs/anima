export type { AgentIdentity, IdentityProvider } from './types'
export { StubIdentity } from './stub'

export {
  AnimaAgentNFTClient,
  buildMintEntries,
  bootstrapHashFor,
} from './contract'
export { AGENT_NFT_ABI } from './abi'
export {
  ANIMA_AGENT_NFT_ADDRESS,
  EXPLORER_BASE,
  type NetworkName,
  explorerTxUrl,
  explorerTokenUrl,
} from './deployments'
export {
  INTELLIGENT_DATA_SLOTS,
  type IntelligentDataSlot,
  type IntelligentDataEntry,
  type MintParams,
  type MintResult,
  type UpdateSlot,
  slotIndex,
} from './intelligent-data'
export { mintAgent, iNFTAgentId, type MintAgentOpts } from './mint'
