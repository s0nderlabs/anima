// @s0nderlabs/anima-core: always-on infrastructure for the anima harness.
export const VERSION = '0.0.0'

export * from './config'
export { agentPaths, placeholderAgentId } from './paths'

export type {
  AnimaEvent,
  EventPayload,
  EventSource,
  Listener,
  RouterDeps,
} from './events'
export { EventQueue, newEventId, listeners, routeLoop } from './events'

export type { ToolCall, ToolDef, ToolResult, ToolSchema, JSONSchema } from './tools'
export { ToolRegistry, zodToJsonSchema, coerceBool, coerceInt } from './tools'

export type {
  Brain,
  BrainInferInput,
  BrainTurn,
  BrainMessage,
  BrainProvider,
  BrainProviderOpts,
  FrozenPrefix,
  OGComputeBrainOpts,
} from './brain'
export {
  StubBrain,
  OGComputeBrain,
  buildFrozenPrefix,
  renderFrozenPrefix,
  DEFAULT_SYSTEM_PROMPT,
  openComputeLedger,
  getLedgerBalance,
  depositToLedger,
  type OpenLedgerOpts,
  type LedgerStatus,
  BrokerPool,
  VISION_PROVIDER_DEFAULTS,
  type BrokerPoolOpts,
  type ProviderHandle,
  type ChatCompletionMessage,
  type ChatCompletionRequest,
  type ChatCompletionResult,
} from './brain'

export type {
  MemoryType,
  MemoryPartition,
  MemoryFrontmatter,
  MemoryTopic,
  MemoryIndexEntry,
  MemoryIndex,
  EditOp,
  EditAction,
  ThreatScanResult,
} from './memory'
export {
  parseTopic,
  stringifyTopic,
  scanForThreats,
  applyEdit,
  EditError,
  parseIndex,
  stringifyIndex,
  readIndexFile,
  writeIndexFile,
  addEntryLine,
  removeEntryLine,
  readTopic,
  writeTopic,
  topicPath,
  makeMemorySaveTool,
  type MemorySaveArgs,
  makeMemoryReadTool,
  type MemoryReadArgs,
  INDEX_LINE_LIMIT,
  INDEX_BYTE_LIMIT,
  syncMemory,
  defaultMemorySyncTargets,
  type SyncMemoryOpts,
  type SyncMemoryResult,
  type SyncTarget,
  MEMORY_BLOB_VERSION,
  deriveMemoryKey,
  encryptMemoryBytes,
  decryptMemoryBytes,
  syncActivityLog,
  type SyncActivityOpts,
  type SyncActivityResult,
  MemorySyncManager,
  type MemorySyncManagerOpts,
  type FlushResult,
} from './memory'

export type { Storage } from './storage'
export {
  LocalStubStorage,
  OGStorage,
  type OGStorageOpts,
  INDEXER_URL,
  downloadBlobByRoot,
  downloadBlobViaDiscoveredNodes,
  encrypt as encryptBytes,
  decrypt as decryptBytes,
  packEnvelope,
  unpackEnvelope,
  type EncryptedEnvelope,
} from './storage'

export {
  encryptKey,
  decryptKey,
  generateAgentWallet,
  saveKeystore,
  loadKeystore,
  type EncryptedKeystore,
  type AgentWalletMaterial,
  OPERATOR_KEYSTORE_VERSION,
  encryptAgentKey,
  decryptAgentKey,
  encodeKeystoreBytes,
  decodeKeystoreBytes,
  sniffKeystoreVersion,
  type OperatorEncryptedKeystore,
} from './wallet'

export type { AgentIdentity, IdentityProvider } from './identity'
export {
  StubIdentity,
  AnimaAgentNFTClient,
  AnimaAgentNFTReader,
  AGENT_NFT_ABI,
  buildMintEntries,
  bootstrapHashFor,
  ANIMA_AGENT_NFT_ADDRESS,
  EXPLORER_BASE,
  INTELLIGENT_DATA_SLOTS,
  type IntelligentDataSlot,
  type IntelligentDataEntry,
  type MintParams,
  type MintResult,
  type UpdateSlot,
  type NetworkName,
  slotIndex,
  explorerTxUrl,
  explorerTokenUrl,
  mintAgent,
  iNFTAgentId,
  type MintAgentOpts,
  persistKeystoreToStorage,
  restoreKeystoreFromStorage,
  uploadKeystore,
  saveKeystoreLocally,
  uploadAndAnchorKeystore,
  fetchKeystore,
  fetchAndDecryptKeystore,
  type UploadKeystoreOpts,
  type UploadKeystoreResult,
  type FetchKeystoreOpts,
  type FetchKeystoreResult,
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
} from './identity'

export {
  SannClient,
  SANN_ADDRESSES,
  sannNamehash,
  subnameNode,
  readRegistryOwner,
  type SannClientOpts,
  AnimaRegistrarClient,
  ANIMA_REGISTRAR_ADDRESS,
  isLabelTaken,
  mainnetReadOnlyClient,
  type AnimaRegistrarClientOpts,
  SUBNAME_LABEL_RE,
  validateSubnameLabel,
  type SubnameValidation,
} from './naming'

export {
  type OperatorSigner,
  KeychainOperatorSigner,
  KeystoreFileOperatorSigner,
  RawPrivkeyOperatorSigner,
  WalletConnectOperatorSigner,
  ANIMA_WC_PROJECT_ID,
  type WalletConnectOperatorSignerOptions,
} from './operator'
export { waitForReceiptResilient } from './identity/receipt'
export {
  MIN_GAS_PRICE,
  STORAGE_SUBMIT_GAS,
  getGasPriceWithFloor,
  makeViemClients,
  ogChain,
  type ViemClients,
} from './chain'

export { Runtime, type RuntimeDeps, ActivityLog, type ActivityEntry } from './runtime'

export {
  encryptToPubkey,
  decryptWithPrivkey,
  generateBootstrapKeypair,
  type Option3Envelope,
} from './migration'

export {
  HookBus,
  type HookName,
  type HookHandler,
  type PreToolCallContext,
  type PreToolCallResult,
  type PostToolCallContext,
  loadPlugins,
  type PluginContext,
  type NativePlugin,
  type PluginLoadResult,
  type PluginLoaderDeps,
  type DelegateBrainFactory,
  type DelegateBrainFactoryOpts,
  type DelegateBrainHandle,
  type DelegateBrainTurn,
  type VisionInferFn,
  type VisionInferInput,
  type VisionInferImage,
  makeToolSearchTool,
  type ToolSearchArgs,
} from './plugins'

export {
  detectDangerousCommand,
  DANGEROUS_PATTERNS,
  PathGuard,
  type PathGuardOpts,
  type PathGuardResult,
  redactEnv,
  type EnvRedactResult,
  PermissionService,
  type PermissionMode,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionPrompter,
  type PermissionServiceOpts,
  type DangerousMatch,
} from './permission'

export type { SkillFrontmatter, SkillRef, SkillSource } from './skills'
export {
  scanSkills,
  parseFrontmatter as parseSkillFrontmatter,
  matchTriggers as matchSkillTriggers,
  matchFilePattern,
  matchBashPattern,
  type SkillScannerOptions,
  type SkillTriggerMatch,
} from './skills'

export {
  discoverMcpServers,
  McpManager,
  McpStdioClient,
  type McpDiscoveryOptions,
  type McpServerConfig,
  type McpServerStdio,
  type McpServerHttp,
  type McpToolMeta,
  type McpDiscoveryResult,
} from './mcp'

export {
  discoverClaudeExtras,
  type ClaudeExtrasOptions,
  type ClaudeCommand,
  type ClaudeAgent,
  type ClaudeExtrasDiscoveryResult,
} from './claude-plugins'

export {
  LocalBackend,
  MacOSSandboxExecBackend,
  DockerBackend,
  makeSandboxBackend,
  buildSeatbeltProfile,
  type SandboxBackend,
  type SandboxBackendOpts,
  type SandboxMode,
  type SandboxSpawnRequest,
  type WrappedSpawn,
  type SeatbeltProfileOpts,
  type MakeSandboxOpts,
  type DockerBackendOpts,
} from './sandbox'
