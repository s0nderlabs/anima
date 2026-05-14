export type {
  MemoryType,
  MemoryPartition,
  MemoryFrontmatter,
  MemoryTopic,
  MemoryIndexEntry,
  MemoryIndex,
} from './types'
export { MEMORY_TYPES } from './types'
export { parseTopic, stringifyTopic } from './parser'
export { scanForThreats, type ThreatScanResult } from './scan'
export { applyEdit, EditError, type EditOp, type EditAction } from './edit'
export {
  parseIndex,
  stringifyIndex,
  readIndexFile,
  writeIndexFile,
  addEntryLine,
  removeEntryLine,
  INDEX_LINE_LIMIT,
  INDEX_BYTE_LIMIT,
} from './index-file'
export { readTopic, writeTopic, topicPath } from './topic'
export { makeMemorySaveTool, type MemorySaveArgs } from './save-tool'
export { makeMemoryReadTool, type MemoryReadArgs } from './read-tool'
export {
  makeMemoryListTool,
  type MemoryListArgs,
  type MemoryListAgentFile,
  type MemoryListSlotEntry,
} from './list-tool'
export {
  ensureSyntheticIndexEntries,
  STANDARD_SYNTHETIC_INDEX_FILES,
  type SyntheticIndexFile,
  type SyntheticIndexResult,
} from './index-sync'
export {
  syncMemory,
  defaultMemorySyncTargets,
  type SyncMemoryOpts,
  type SyncMemoryResult,
  type SyncTarget,
} from './sync'
export {
  MEMORY_BLOB_VERSION,
  deriveMemoryKey,
  encryptMemoryBytes,
  decryptMemoryBytes,
} from './encryption'
export {
  syncActivityLog,
  type SyncActivityOpts,
  type SyncActivityResult,
} from './activity-sync'
export {
  MemorySyncManager,
  type MemorySyncManagerOpts,
  type FlushResult,
} from './sync-manager'
export {
  syncProfile,
  restoreProfile,
  type ProfileSyncOpts,
  type ProfileSyncResult,
  type RestoreProfileOpts,
} from './profile-sync'
export { readOrNull } from './fs-util'
export {
  PACK_BLOB_VERSION,
  encodePackBlob,
  decodePackBlob,
  isV2Envelope,
  type PackBlob,
  type EncodePackOpts,
} from './pack-blob'
export {
  gatherAgentPack,
  gatherUserPack,
  writeAgentPack,
  writeUserPack,
  type GatherResult,
} from './pack-gather'
