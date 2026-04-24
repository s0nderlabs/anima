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
export {
  syncMemory,
  defaultSyncTargets,
  type SyncMemoryOpts,
  type SyncMemoryResult,
  type SyncTarget,
} from './sync'
