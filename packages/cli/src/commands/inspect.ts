import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cancel, intro, note, outro, spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  type AnimaNetwork,
  INTELLIGENT_DATA_SLOTS,
  type InspectAgentResult,
  type IntelligentDataSlot,
  type SlotDiff,
  type SlotInspection,
  type TxInspection,
  agentPaths,
  bootstrapHashFor,
  deriveMemoryKey,
  diffAgent,
  explorerTokenUrl,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  inspectAgent,
  inspectTx,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { parseINFTRef } from './_inft-ref'
import { loadOrPickOperatorSigner } from './init/operator-picker'

/**
 * `anima inspect` — read what's anchored on chain for an iNFT.
 *
 * Modes (each compose with `--full`/`--json`/`--out <dir>`):
 *   default               own agent: decrypt + render every slot
 *   --slot <name>         own agent: only that slot
 *   --tx <hash>           inspect what an `update()` tx anchored
 *   --raw                 own agent: no operator-wallet decrypt, just bytes
 *   --diff                own agent: compare local files vs chain plaintext
 *   <ref> [+flags]        foreign iNFT: ref is `0g-mainnet:0xCONTRACT:tokenId`
 *                         or `eip155:16661:0xCONTRACT:tokenId`. Foreign always
 *                         skips decrypt (you don't have the operator).
 */

export interface InspectFlags {
  /** Foreign iNFT ref. When set, command treats inspection as raw / no-decrypt. */
  ref?: string
  /** Single slot filter. Names match `INTELLIGENT_DATA_SLOTS`. */
  slot?: IntelligentDataSlot
  /** Inspect an `update` tx instead of current state. */
  tx?: Hex
  /** Skip operator decrypt entirely; just dump root hashes + ciphertext sizes. */
  raw?: boolean
  /** Compare local memory files vs chain plaintext. */
  diff?: boolean
  /** Emit structured JSON instead of human format. */
  json?: boolean
  /** Print full plaintext (default truncates to 40 lines per slot). */
  full?: boolean
  /** Dump each decrypted slot to `<out>/<slot>.md`. */
  out?: string
}

const PREVIEW_LINES = 40

export async function runInspect(flags: InspectFlags): Promise<void> {
  if (flags.json) return runJson(flags)

  intro('anima inspect')

  if (flags.tx) {
    await renderTxMode(flags)
    return
  }

  // Resolve which iNFT we're looking at.
  const target = await resolveTarget(flags)
  if (!target) return
  const { network, contractAddress, tokenId, isForeign, config } = target

  if (flags.diff) {
    if (isForeign) {
      cancel('--diff is only meaningful on your own agent (needs the memory key to decrypt).')
      return
    }
    await renderDiffMode({ network, contractAddress, tokenId, config, full: flags.full ?? false })
    return
  }

  const wantDecrypt = !isForeign && !flags.raw
  let memoryKey: Buffer | undefined
  if (wantDecrypt) {
    const key = await unlockMemoryKey({ network, contractAddress, tokenId, config })
    if (!key) return
    memoryKey = key
  }

  const fetchSpin = spinner()
  fetchSpin.start(
    `Reading ${flags.slot ? `slot '${flags.slot}'` : 'all slots'} for iNFT #${tokenId} on ${network}`,
  )
  let result: InspectAgentResult
  try {
    result = await inspectAgent({
      network,
      contractAddress,
      tokenId,
      memoryKey,
      slots: flags.slot ? [flags.slot] : undefined,
    })
    fetchSpin.stop(`fetched ${result.slots.length} slot(s)`)
  } catch (e) {
    fetchSpin.stop(`fetch failed: ${(e as Error).message.slice(0, 200)}`)
    return
  }

  printAgentHeader({ network, contractAddress, tokenId, owner: result.owner, isForeign })
  for (const inspection of result.slots) {
    printSlot(inspection, { full: flags.full ?? false, raw: flags.raw ?? !wantDecrypt })
  }

  if (flags.out) {
    await dumpToDir(flags.out, result)
  }

  outro(
    `Inspected ${result.slots.length} slot(s).${flags.out ? ` Decrypted plaintext written to ${flags.out}/` : ''}`,
  )
}

interface ResolvedTarget {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  isForeign: boolean
  /** Active config when target was resolved from it; null when target came from a foreign ref. */
  config: AnimaConfig | null
}

async function resolveTarget(flags: InspectFlags): Promise<ResolvedTarget | null> {
  if (flags.ref) {
    try {
      const parsed = parseINFTRef(flags.ref)
      return { ...parsed, contractAddress: parsed.contract, isForeign: true, config: null }
    } catch (e) {
      cancel((e as Error).message)
      return null
    }
  }
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel(
      'No anima config. Run `anima init` first or pass an iNFT ref like `0g-mainnet:0xCONTRACT:tokenId`.',
    )
    return null
  }
  const { config } = loaded
  if (!config.identity.iNFT) {
    cancel('Active config has no iNFT. Run `anima init` first or pass a ref.')
    return null
  }
  return {
    network: config.network,
    contractAddress: config.identity.iNFT.contract as Address,
    tokenId: BigInt(config.identity.iNFT.tokenId),
    isForeign: false,
    config,
  }
}

async function unlockMemoryKey(target: {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  config: AnimaConfig | null
}): Promise<Buffer | null> {
  const config = target.config
  if (!config?.identity.agent) {
    cancel(
      'Active config has no agent address; cannot derive memory key. Pass `--raw` to skip decrypt.',
    )
    return null
  }
  const agentAddress = config.identity.agent as Address
  const agentId = iNFTAgentId({ contractAddress: target.contractAddress, tokenId: target.tokenId })
  const paths = agentPaths.agent(agentId)

  const operator = await loadOrPickOperatorSigner({
    network: target.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt keystore. Pass `--raw` to skip.')
    return null
  }
  const sUnlock = spinner()
  sUnlock.start('Fetching keystore + decrypting via operator wallet')
  try {
    const decrypted = await fetchAndDecryptKeystore({
      network: target.network,
      contractAddress: target.contractAddress,
      tokenId: target.tokenId,
      signer: operator,
      agentAddress,
      cachePath: paths.keystore,
    })
    sUnlock.stop(`unlocked (source: ${decrypted.source})`)
    return deriveMemoryKey(decrypted.privkeyHex)
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    return null
  } finally {
    await operator.close?.()
  }
}

function printAgentHeader(opts: {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  owner: Address
  isForeign: boolean
}): void {
  const { network, contractAddress, tokenId, owner, isForeign } = opts
  console.log('')
  console.log(`  iNFT       #${tokenId} at ${contractAddress} (${network})`)
  console.log(`             ${explorerTokenUrl(network, contractAddress, tokenId)}`)
  console.log(`  owner      ${owner}${isForeign ? '  (foreign — raw view only)' : ''}`)
  console.log('')
}

function printSlot(s: SlotInspection, opts: { full: boolean; raw: boolean }): void {
  const idx = INTELLIGENT_DATA_SLOTS.indexOf(s.slot)
  const idxLabel = idx >= 0 ? ` (slot ${idx})` : ''
  console.log('')
  console.log(`────  ${s.slot}${idxLabel}`)
  console.log(`      rootHash    ${s.rootHash}`)

  if (s.empty) {
    console.log('      status      empty (still bootstrap placeholder; never anchored)')
    return
  }

  if (s.decryptStatus === 'fetch-failed') {
    console.log(`      status      fetch failed: ${s.fetchError ?? 'unknown'}`)
    return
  }

  console.log(`      ciphertext  ${s.ciphertext?.byteLength ?? 0} bytes`)

  if (opts.raw || s.decryptStatus === 'no-key' || s.decryptStatus === 'keystore-skipped') {
    if (s.slot === 'keystore') {
      console.log('      decrypt     skipped (keystore is operator-encrypted, not memory-key)')
      const head = previewBytesAsHex(s.ciphertext, 64)
      if (head) console.log(`      hex (head)  ${head}`)
      return
    }
    console.log(`      decrypt     ${opts.raw ? 'skipped (--raw)' : 'skipped (no memory key)'}`)
    const head = previewBytesAsHex(s.ciphertext, 64)
    if (head) console.log(`      hex (head)  ${head}`)
    return
  }

  if (s.decryptStatus === 'decrypt-failed') {
    console.log(`      decrypt     FAILED: ${s.decryptError ?? 'unknown'}`)
    return
  }

  if (!s.plaintext) {
    console.log(`      decrypt     unexpected null plaintext (status=${s.decryptStatus})`)
    return
  }

  console.log(`      plaintext   ${s.plaintext.byteLength} bytes`)
  console.log(`      hash        ${s.plaintextHash}`)
  console.log('      content:')
  const text = new TextDecoder().decode(s.plaintext)
  const lines = text.split('\n')
  const cap = opts.full ? lines.length : PREVIEW_LINES
  for (const line of lines.slice(0, cap)) console.log(`        │ ${line}`)
  if (lines.length > cap) {
    console.log(`        │ … (${lines.length - cap} more lines — pass --full to see them)`)
  }
}

function previewBytesAsHex(bytes: Uint8Array | null, n: number): string | null {
  if (!bytes) return null
  return Buffer.from(bytes.subarray(0, n)).toString('hex')
}

async function renderTxMode(flags: InspectFlags): Promise<void> {
  if (!flags.tx) {
    cancel('--tx requires a tx hash')
    return
  }
  const target = await resolveTarget(flags)
  if (!target) return
  const { network, contractAddress, isForeign } = target

  const sFetch = spinner()
  sFetch.start(`Decoding tx ${flags.tx}`)
  let txInfo: TxInspection
  try {
    txInfo = await inspectTx({ network, contractAddress, txHash: flags.tx })
    sFetch.stop(`block ${txInfo.blockNumber} — ${txInfo.slots.length} slot(s) updated`)
  } catch (e) {
    sFetch.stop(`tx decode failed: ${(e as Error).message.slice(0, 200)}`)
    return
  }

  console.log('')
  console.log(`  tx         ${txInfo.txHash}`)
  console.log(`             ${explorerTxUrl(network, txInfo.txHash)}`)
  console.log(`  block      ${txInfo.blockNumber}`)
  console.log(`  iNFT       #${txInfo.tokenId} at ${contractAddress} (${network})`)
  console.log('')
  console.log('  slots anchored at this tx:')
  for (let i = 0; i < txInfo.slots.length; i++) {
    const slot = txInfo.slots[i]!
    const at = txInfo.hashesAtTx[i]!
    const cur = txInfo.current.get(slot) ?? bootstrapHashFor(slot)
    const same = at.toLowerCase() === cur.toLowerCase()
    console.log(`    • ${slot}`)
    console.log(`        anchored at tx:  ${at}`)
    console.log(`        current on chain: ${cur}${same ? '' : '  ⚠ superseded by a later tx'}`)
  }

  if (flags.raw || isForeign) {
    outro('Pass without --raw / on your own iNFT to see decrypted content.')
    return
  }

  const memoryKey = await unlockMemoryKey({
    network,
    contractAddress,
    tokenId: txInfo.tokenId,
    config: target.config,
  })
  if (!memoryKey) return

  console.log('')
  console.log('  current decrypted content for those slots:')
  const result = await inspectAgent({
    network,
    contractAddress,
    tokenId: txInfo.tokenId,
    memoryKey,
    slots: txInfo.slots,
  })
  for (const inspection of result.slots) {
    printSlot(inspection, { full: flags.full ?? false, raw: false })
  }

  outro(`Decoded tx + ${result.slots.length} current slot(s).`)
}

async function renderDiffMode(opts: {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  config: AnimaConfig | null
  full: boolean
}): Promise<void> {
  const memoryKey = await unlockMemoryKey({
    network: opts.network,
    contractAddress: opts.contractAddress,
    tokenId: opts.tokenId,
    config: opts.config,
  })
  if (!memoryKey) return

  const agentId = iNFTAgentId({
    contractAddress: opts.contractAddress,
    tokenId: opts.tokenId,
  })
  const paths = agentPaths.agent(agentId)
  const localPaths: Partial<Record<IntelligentDataSlot, string>> = {
    'memory-index': paths.memoryIndex,
    identity: join(paths.agentMemoryDir, 'identity.md'),
    persona: join(paths.agentMemoryDir, 'persona.md'),
    'activity-log': paths.activityLog,
  }

  const sDiff = spinner()
  sDiff.start('Comparing local memory files vs chain plaintext')
  let diffs: SlotDiff[]
  try {
    diffs = await diffAgent({
      network: opts.network,
      contractAddress: opts.contractAddress,
      tokenId: opts.tokenId,
      memoryKey,
      localPaths,
    })
    sDiff.stop(`compared ${diffs.length} slot(s)`)
  } catch (e) {
    sDiff.stop(`diff failed: ${(e as Error).message.slice(0, 200)}`)
    return
  }

  console.log('')
  for (const d of diffs) {
    console.log(`────  ${d.slot}`)
    console.log(`      status      ${d.status}`)
    console.log(`      chain root  ${d.chainRootHash}`)
    if (d.localHash)
      console.log(`      local hash  ${d.localHash}  (${d.local?.byteLength ?? 0} bytes)`)
    else console.log('      local       (missing)')
    if (d.chainHash)
      console.log(`      chain hash  ${d.chainHash}  (${d.chain?.byteLength ?? 0} bytes)`)
    else console.log('      chain       (empty / cannot decrypt)')
    if (d.chainError) console.log(`      chain error ${d.chainError}`)

    if (d.status === 'differ' && opts.full && d.local && d.chain) {
      const localText = new TextDecoder().decode(d.local).split('\n')
      const chainText = new TextDecoder().decode(d.chain).split('\n')
      console.log('      diff (first 20 lines each):')
      console.log('        local:')
      for (const line of localText.slice(0, 20)) console.log(`          + ${line}`)
      console.log('        chain:')
      for (const line of chainText.slice(0, 20)) console.log(`          - ${line}`)
    }
    console.log('')
  }

  const drift = diffs.filter(d => d.status !== 'in-sync' && d.status !== 'both-missing')
  if (drift.length === 0) {
    outro('All synced slots match chain plaintext exactly.')
  } else {
    note(
      `${drift.length} slot(s) drifted: ${drift.map(d => `${d.slot}:${d.status}`).join(', ')}`,
      'drift detected',
    )
    outro('Run `anima sync` to push local → chain, or pull chain via `anima inspect --out <dir>`.')
  }
}

async function dumpToDir(out: string, result: InspectAgentResult): Promise<void> {
  await mkdir(out, { recursive: true })
  const sumLines: string[] = [
    '# anima inspect dump',
    '',
    `iNFT:    ${result.contractAddress} #${result.tokenId} (${result.network})`,
    `owner:   ${result.owner}`,
    '',
    '## slots',
    '',
  ]
  for (const s of result.slots) {
    sumLines.push(`- **${s.slot}** — ${s.rootHash} — ${s.decryptStatus}`)
    if (s.plaintext) {
      const path = join(out, `${s.slot}.md`)
      await writeFile(path, s.plaintext)
    }
    if (s.ciphertext && s.decryptStatus !== 'ok') {
      const path = join(out, `${s.slot}.bin`)
      await writeFile(path, s.ciphertext)
    }
  }
  await writeFile(join(out, 'README.md'), sumLines.join('\n'))
}

async function runJson(flags: InspectFlags): Promise<void> {
  const target = await resolveTarget(flags)
  if (!target) return
  try {
    if (flags.tx) {
      const txInfo = await inspectTx({
        network: target.network,
        contractAddress: target.contractAddress,
        txHash: flags.tx,
      })
      process.stdout.write(`${JSON.stringify(serializeTx(txInfo), null, 2)}\n`)
      return
    }
    let memoryKey: Buffer | undefined
    if (!flags.raw && !target.isForeign) {
      const key = await unlockMemoryKey(target)
      if (!key) return
      memoryKey = key
    }
    const result = await inspectAgent({
      network: target.network,
      contractAddress: target.contractAddress,
      tokenId: target.tokenId,
      memoryKey,
      slots: flags.slot ? [flags.slot] : undefined,
    })
    process.stdout.write(`${JSON.stringify(serializeResult(result), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`)
    process.exit(1)
  }
}

function serializeResult(r: InspectAgentResult): unknown {
  return {
    network: r.network,
    contractAddress: r.contractAddress,
    tokenId: r.tokenId.toString(),
    owner: r.owner,
    slots: r.slots.map(s => ({
      slot: s.slot,
      rootHash: s.rootHash,
      empty: s.empty,
      decryptStatus: s.decryptStatus,
      decryptError: s.decryptError,
      fetchError: s.fetchError,
      ciphertextSize: s.ciphertext?.byteLength ?? null,
      plaintextSize: s.plaintext?.byteLength ?? null,
      plaintextHash: s.plaintextHash,
      plaintext: s.plaintext ? new TextDecoder().decode(s.plaintext) : null,
    })),
  }
}

function serializeTx(t: TxInspection): unknown {
  return {
    txHash: t.txHash,
    blockNumber: t.blockNumber.toString(),
    blockHash: t.blockHash,
    tokenId: t.tokenId.toString(),
    slots: t.slots,
    hashesAtTx: t.hashesAtTx,
    current: Array.from(t.current.entries()).map(([slot, hash]) => ({ slot, hash })),
  }
}

export function isValidSlot(name: string): name is IntelligentDataSlot {
  return (INTELLIGENT_DATA_SLOTS as readonly string[]).includes(name)
}
