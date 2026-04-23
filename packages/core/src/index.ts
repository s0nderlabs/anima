// @s0nderlabs/anima-core — always-on infrastructure for the anima runtime.
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
export { ToolRegistry, zodToJsonSchema } from './tools'

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
  INDEX_LINE_LIMIT,
  INDEX_BYTE_LIMIT,
} from './memory'

export type { Storage } from './storage'
export { LocalStubStorage } from './storage'

export {
  encryptKey,
  decryptKey,
  generateAgentWallet,
  saveKeystore,
  loadKeystore,
  type EncryptedKeystore,
  type AgentWalletMaterial,
} from './wallet'

export type { AgentIdentity, IdentityProvider } from './identity'
export { StubIdentity } from './identity'

export { Runtime, type RuntimeDeps, ActivityLog, type ActivityEntry } from './runtime'
