import { readFile, rename, writeFile } from 'node:fs/promises'
import type { MemoryIndex, MemoryIndexEntry } from './types'

/** Max enforced by Claude Code conventions — loaded into every prompt. */
export const INDEX_LINE_LIMIT = 200
export const INDEX_BYTE_LIMIT = 25 * 1024

const ENTRY_RE = /^-\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*[-—]\s*(.*))?$/

export function parseIndex(raw: string): MemoryIndex {
  const lines = raw.split('\n')
  const entries = new Map<string, MemoryIndexEntry>()
  for (const line of lines) {
    const m = line.match(ENTRY_RE)
    if (m?.[1] && m[2]) {
      const title = m[1]
      const file = m[2]
      const hook = m[3] ?? ''
      entries.set(file, { file, title, hook: hook.trim() })
    }
  }
  return { lines, entries }
}

export function stringifyIndex(index: MemoryIndex): string {
  const joined = index.lines.join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

export async function readIndexFile(path: string): Promise<MemoryIndex> {
  const raw = await readFile(path, 'utf8').catch(e => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  })
  return parseIndex(raw)
}

export async function writeIndexFile(path: string, index: MemoryIndex): Promise<void> {
  const content = stringifyIndex(index)
  if (content.length > INDEX_BYTE_LIMIT) {
    throw new Error(`MEMORY.md exceeds ${INDEX_BYTE_LIMIT}-byte cap (got ${content.length})`)
  }
  if (index.lines.length > INDEX_LINE_LIMIT) {
    throw new Error(`MEMORY.md exceeds ${INDEX_LINE_LIMIT}-line cap (got ${index.lines.length})`)
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

export function addEntryLine(index: MemoryIndex, entry: MemoryIndexEntry): MemoryIndex {
  if (index.entries.has(entry.file)) return index
  const line = `- [${entry.title}](${entry.file}) — ${entry.hook}`
  const next: MemoryIndex = {
    lines: [...index.lines, line],
    entries: new Map(index.entries),
  }
  next.entries.set(entry.file, entry)
  return next
}

export function removeEntryLine(index: MemoryIndex, file: string): MemoryIndex {
  if (!index.entries.has(file)) return index
  const filtered = index.lines.filter(line => {
    const m = line.match(ENTRY_RE)
    return !(m && m[2] === file)
  })
  const next: MemoryIndex = {
    lines: filtered,
    entries: new Map(index.entries),
  }
  next.entries.delete(file)
  return next
}
