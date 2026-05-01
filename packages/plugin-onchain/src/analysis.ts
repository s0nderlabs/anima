/**
 * Tx + contract analysis helpers. Tries our local ABI library first, falls
 * back to the 4byte directory for unknown selectors with a canonical-first
 * filter (longest, lowercase, simplest signature wins; spam filtered out).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AbiFunction, decodeFunctionData, parseAbiItem, toFunctionSelector } from 'viem'
import { ALL_KNOWN_ABIS } from './abis'

const KNOWN_ABIS = ALL_KNOWN_ABIS as readonly AbiFunction[]

/**
 * Build a selector → abi item map from KNOWN_ABIS. Multiple ABIs can include
 * the same selector (e.g. `transfer` in both ERC-20 and W0G); we keep the
 * first hit since they share the same signature anyway.
 */
const KNOWN_SELECTORS = (() => {
  const map = new Map<string, AbiFunction>()
  for (const item of KNOWN_ABIS) {
    if ((item as AbiFunction).type !== 'function') continue
    const fn = item as AbiFunction
    try {
      const sel = toFunctionSelector(fn).toLowerCase()
      if (!map.has(sel)) map.set(sel, fn)
    } catch {
      // skip items that don't selector-encode (events, errors)
    }
  }
  return map
})()

interface FourByteCacheFile {
  version: 1
  hits: Record<string, string> // selector → canonical signature
}

function fourByteCachePath(agentDir: string): string {
  return join(agentDir, 'onchain', '4byte-cache.json')
}

function loadFourByteCache(agentDir: string): FourByteCacheFile {
  const path = fourByteCachePath(agentDir)
  if (!existsSync(path)) return { version: 1, hits: {} }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as FourByteCacheFile
    if (parsed?.version === 1 && parsed.hits) return parsed
    return { version: 1, hits: {} }
  } catch {
    return { version: 1, hits: {} }
  }
}

function saveFourByteCache(agentDir: string, cache: FourByteCacheFile): void {
  const path = fourByteCachePath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2))
}

interface FourByteResult {
  text_signature: string
  hex_signature: string
  bytes_signature: string
}

/**
 * Pick the most "canonical" signature out of 4byte's results. Spam bots
 * register PascalCase or all-caps names whose hashes collide with real
 * selectors; filter those out, then prefer fewer args + shorter names.
 */
function pickCanonical(results: FourByteResult[]): string | null {
  if (results.length === 0) return null
  const scored = results
    .map(r => {
      const sig = r.text_signature
      const fnName = sig.split('(')[0] ?? sig
      const argList = sig.slice(fnName.length + 1, -1)
      const argCount = argList.length === 0 ? 0 : argList.split(',').length
      const looksLikeSpam =
        /^[A-Z][a-zA-Z]*$/.test(fnName) || /[A-Z]{4,}/.test(fnName) || fnName.length > 32
      return { sig, fnName, argCount, looksLikeSpam }
    })
    .filter(s => !s.looksLikeSpam)
    .sort((a, b) => {
      if (a.argCount !== b.argCount) return a.argCount - b.argCount
      if (a.fnName.length !== b.fnName.length) return a.fnName.length - b.fnName.length
      return a.fnName.localeCompare(b.fnName)
    })
  return scored[0]?.sig ?? null
}

async function lookup4byte(selector: string): Promise<FourByteResult[]> {
  const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return []
    const json = (await res.json()) as { results?: FourByteResult[] }
    return json.results ?? []
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}

export interface DecodedFunction {
  name: string
  signature: string
  args: unknown[]
  source: 'local' | '4byte' | 'cache'
}

export async function decodeCalldata(opts: {
  data: `0x${string}`
  agentDir: string
}): Promise<DecodedFunction | { selector: `0x${string}`; source: 'unknown' }> {
  const { data, agentDir } = opts
  if (data.length < 10) {
    return { selector: '0x' as `0x${string}`, source: 'unknown' }
  }
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`
  // Local ABI hit
  const localHit = KNOWN_SELECTORS.get(selector)
  if (localHit) {
    try {
      const decoded = decodeFunctionData({
        abi: [localHit] as readonly [AbiFunction],
        data,
      })
      return {
        name: localHit.name,
        signature: formatAbiFunction(localHit),
        args: Array.isArray(decoded.args) ? [...decoded.args] : [],
        source: 'local',
      }
    } catch {
      // fall through to 4byte
    }
  }
  // Cache hit
  const cache = loadFourByteCache(agentDir)
  const cached = cache.hits[selector]
  if (cached) {
    const args = tryDecodeWithSignature(cached, data)?.args ?? []
    return {
      name: cached.split('(')[0] ?? cached,
      signature: cached,
      args,
      source: 'cache',
    }
  }
  // 4byte fallback
  const results = await lookup4byte(selector)
  const canonical = pickCanonical(results)
  if (!canonical) {
    return { selector, source: 'unknown' }
  }
  cache.hits[selector] = canonical
  saveFourByteCache(agentDir, cache)
  const out = tryDecodeWithSignature(canonical, data)
  return {
    name: canonical.split('(')[0] ?? canonical,
    signature: canonical,
    args: out?.args ?? [],
    source: '4byte',
  }
}

function tryDecodeWithSignature(
  sig: string,
  data: `0x${string}`,
): { decoded: boolean; args: unknown[] } | null {
  try {
    const fn = parseAbiItem(`function ${sig}`) as AbiFunction
    const decoded = decodeFunctionData({
      abi: [fn] as readonly [AbiFunction],
      data,
    })
    return {
      decoded: true,
      args: Array.isArray(decoded.args) ? [...decoded.args] : [],
    }
  } catch {
    return null
  }
}

function formatAbiFunction(fn: AbiFunction): string {
  const params = fn.inputs.map(p => p.type).join(',')
  return `${fn.name}(${params})`
}
