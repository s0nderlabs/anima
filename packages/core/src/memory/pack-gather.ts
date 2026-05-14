/**
 * v0.24.0: gather + write helpers for the slot 0 (memory-index) and slot 3
 * (profile) pack-blob envelopes. Both slots now bundle the root file plus
 * every sibling file in the partition that v0.23.x would have left on
 * local disk only.
 *
 * Slot 0 (agent key, transfers with iNFT):
 *   - root: memory/MEMORY.md
 *   - files: memory/agent/*.md EXCEPT identity.md (slot 1) + persona.md (slot 2)
 *
 * Slot 3 (operator PROFILE key, purges on transfer):
 *   - root: memory/user/profile.md
 *   - files: memory/user/*.md EXCEPT profile.md (it's already the root)
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PackBlob } from './pack-blob'

/** Files inside memory/agent/ that have their own slot and must NOT be packed. */
const AGENT_PACK_EXCLUDED = new Set(['identity.md', 'persona.md'])

/** Files inside memory/user/ that must NOT be packed (profile.md is the root). */
const USER_PACK_EXCLUDED = new Set(['profile.md'])

export interface GatherResult {
  /** Root file content (empty string if root file is missing/empty). */
  root: string
  /** Sibling files keyed by filename. */
  files: Record<string, string>
}

/**
 * Read the agent partition into a {root, files} shape ready for `encodePackBlob`.
 * Missing files yield empty strings; missing partition dir yields empty files.
 */
export async function gatherAgentPack(memoryDir: string): Promise<GatherResult> {
  const rootPath = join(memoryDir, 'MEMORY.md')
  const partitionDir = join(memoryDir, 'agent')
  return gatherPack(rootPath, partitionDir, AGENT_PACK_EXCLUDED)
}

/**
 * Read the user partition into a {root, files} shape ready for `encodePackBlob`.
 * Missing files yield empty strings; missing partition dir yields empty files.
 */
export async function gatherUserPack(memoryDir: string): Promise<GatherResult> {
  const rootPath = join(memoryDir, 'user', 'profile.md')
  const partitionDir = join(memoryDir, 'user')
  return gatherPack(rootPath, partitionDir, USER_PACK_EXCLUDED)
}

async function gatherPack(
  rootPath: string,
  partitionDir: string,
  excludedFilenames: Set<string>,
): Promise<GatherResult> {
  const root = await readOptional(rootPath)
  const files: Record<string, string> = {}
  let entries: string[]
  try {
    entries = await readdir(partitionDir)
  } catch {
    return { root, files }
  }
  for (const name of entries) {
    if (excludedFilenames.has(name)) continue
    if (!name.endsWith('.md')) continue
    const content = await readOptional(join(partitionDir, name))
    if (content.length === 0) continue
    files[name] = content
  }
  return { root, files }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Write the decoded pack contents back to the agent partition. Used by the
 * gateway restore path on cold start. Idempotent: writes the root file and
 * every entry in `files`; does NOT delete files that already exist on disk
 * but are not in the pack (local-wins on conflict).
 */
export async function writeAgentPack(memoryDir: string, blob: PackBlob): Promise<void> {
  const rootPath = join(memoryDir, 'MEMORY.md')
  const partitionDir = join(memoryDir, 'agent')
  await writePack(rootPath, partitionDir, blob)
}

/** Write the decoded user-partition pack back to disk. Idempotent (see writeAgentPack). */
export async function writeUserPack(memoryDir: string, blob: PackBlob): Promise<void> {
  const rootPath = join(memoryDir, 'user', 'profile.md')
  const partitionDir = join(memoryDir, 'user')
  await writePack(rootPath, partitionDir, blob)
}

async function writePack(rootPath: string, partitionDir: string, blob: PackBlob): Promise<void> {
  if (blob.root.length > 0) {
    await mkdir(dirname(rootPath), { recursive: true })
    await writeFile(rootPath, blob.root)
  }
  await mkdir(partitionDir, { recursive: true })
  for (const [name, content] of Object.entries(blob.files)) {
    await writeFile(join(partitionDir, name), content)
  }
}
