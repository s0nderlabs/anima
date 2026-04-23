import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AnimaConfig } from '@s0nderlabs/anima-core'

/**
 * Walks upward from cwd looking for `anima.config.ts`. Returns the loaded
 * module's default export (our AnimaConfig) + the resolved path, or null if
 * not found.
 */
export async function findAndLoadConfig(
  startDir: string = process.cwd(),
): Promise<{ config: AnimaConfig; path: string } | null> {
  let dir = resolve(startDir)
  while (true) {
    const candidate = resolve(dir, 'anima.config.ts')
    if (existsSync(candidate)) {
      const mod = (await import(candidate)) as { default: AnimaConfig }
      if (!mod.default) throw new Error(`anima.config.ts at ${candidate} has no default export`)
      return { config: mod.default, path: candidate }
    }
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}
