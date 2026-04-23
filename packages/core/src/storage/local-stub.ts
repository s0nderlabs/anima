import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Storage } from './types'

/**
 * Local-disk Storage stub. Layout under `${root}/storage-stub`:
 *   kv/<streamId>/<url-encoded-key>         — latest value
 *   log/<streamId>.jsonl                    — append-only JSONL
 *   blob/<cid>                              — immutable by content hash
 */
export class LocalStubStorage implements Storage {
  constructor(private readonly root: string) {}

  private kvPath(stream: string, key: string): string {
    return join(this.root, 'storage-stub', 'kv', stream, encodeURIComponent(key))
  }

  private logPath(stream: string): string {
    return join(this.root, 'storage-stub', 'log', `${stream}.jsonl`)
  }

  private blobPath(cid: string): string {
    return join(this.root, 'storage-stub', 'blob', cid)
  }

  async putKV(stream: string, key: string, value: Uint8Array): Promise<void> {
    const p = this.kvPath(stream, key)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, value)
  }

  async getKV(stream: string, key: string): Promise<Uint8Array | null> {
    return await readOrNull(this.kvPath(stream, key))
  }

  async appendLog(stream: string, entry: Uint8Array): Promise<string> {
    const p = this.logPath(stream)
    await mkdir(join(p, '..'), { recursive: true })
    const cid = cidOf(entry)
    const line = JSON.stringify({ cid, hex: Buffer.from(entry).toString('hex'), ts: Date.now() })
    await appendFile(p, `${line}\n`)
    return cid
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const cid = cidOf(bytes)
    const p = this.blobPath(cid)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, bytes)
    return cid
  }

  async getBlob(cid: string): Promise<Uint8Array | null> {
    return await readOrNull(this.blobPath(cid))
  }
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function cidOf(bytes: Uint8Array): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`
}
