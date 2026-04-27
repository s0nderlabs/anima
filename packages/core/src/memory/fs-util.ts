import { readFile } from 'node:fs/promises'

/**
 * Read a file as bytes; return null on ENOENT, rethrow other errors.
 * Used wherever an "absent file is fine, anything else is a bug" semantic
 * is needed (memory sync, activity log sync, on-chain diff vs local).
 */
export async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
