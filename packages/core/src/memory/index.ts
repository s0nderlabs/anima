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
