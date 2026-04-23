import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseTopic, stringifyTopic } from './parser'
import type { MemoryPartition, MemoryTopic } from './types'

export async function readTopic(
  dir: string,
  partition: MemoryPartition,
  slug: string,
): Promise<MemoryTopic | null> {
  const path = topicPath(dir, partition, slug)
  const raw = await readFile(path, 'utf8').catch(e => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  })
  if (raw === null) return null
  return parseTopic(partition, slug, raw)
}

export async function writeTopic(dir: string, topic: MemoryTopic): Promise<void> {
  const path = topicPath(dir, topic.partition, topic.slug)
  await mkdir(dirname(path), { recursive: true })

  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  const body = stringifyTopic(topic)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

export function topicPath(dir: string, partition: MemoryPartition, slug: string): string {
  return join(dir, 'memory', partition, `${slug}.md`)
}
