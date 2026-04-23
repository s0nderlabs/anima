export const MEMORY_TYPES = [
  'agent-identity',
  'agent-persona',
  'agent-learned',
  'user',
  'user-convos',
  'user-private',
  'feedback',
  'project',
  'reference',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export type MemoryPartition = 'agent' | 'user' | 'public'

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
  /** ISO timestamp, set on first write. */
  createdAt?: string
  /** ISO timestamp, updated on every write. */
  updatedAt?: string
  /** Free-form extra fields preserved on round-trip. */
  [key: string]: unknown
}

export interface MemoryTopic {
  partition: MemoryPartition
  /** Filename without `.md` extension, e.g. `feedback-testing`. */
  slug: string
  frontmatter: MemoryFrontmatter
  /** Full markdown body below frontmatter. */
  body: string
}

export interface MemoryIndexEntry {
  file: string
  title: string
  hook: string
}

export interface MemoryIndex {
  /** Raw lines from MEMORY.md preserved in order. */
  lines: string[]
  /** Parsed index entries keyed by file. */
  entries: Map<string, MemoryIndexEntry>
}
