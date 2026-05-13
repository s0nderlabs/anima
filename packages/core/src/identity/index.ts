export type { AgentIdentity, IdentityProvider } from './types'
export { StubIdentity } from './stub'

export {
  AnimaAgentNFTClient,
  AnimaAgentNFTReader,
  buildMintEntries,
  bootstrapHashFor,
} from './contract'
export { AGENT_NFT_ABI } from './abi'
export {
  ANIMA_AGENT_NFT_ADDRESS,
  ANIMA_INBOX_ADDRESS,
  ANIMA_MARKET_ADDRESS,
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
export { derivePubkeyHex } from './pubkey'
export {
  persistKeystoreToStorage,
  reEncryptKeystoreForRecipient,
  restoreKeystoreFromStorage,
} from './keystore-storage'
export {
  type BuildTransferHashesArgs,
  type TransferProofPreimageArgs,
  buildTransferHashes,
  signTransferProof,
  transferProofPreimage,
} from './transfer'
export {
  uploadKeystore,
  saveKeystoreLocally,
  uploadAndAnchorKeystore,
  fetchKeystore,
  fetchAndDecryptKeystore,
  type UploadKeystoreOpts,
  type UploadKeystoreResult,
  type FetchKeystoreOpts,
  type FetchKeystoreResult,
} from './keystore-blob'
export {
  inspectAgent,
  inspectSlot,
  inspectTx,
  diffAgent,
  type InspectAgentOpts,
  type InspectAgentResult,
  type SlotInspection,
  type DecryptStatus,
  type SlotDiff,
  type DiffAgentOpts,
  type TxInspection,
} from './inspect'
