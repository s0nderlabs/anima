import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cancel, intro, note, outro, spinner } from '@clack/prompts'
import {
  MemorySyncManager,
  OPERATOR_BLOB_SCOPES,
  agentPaths,
  deriveBlobKey,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

/**
 * `anima profile init` — v0.23.0 entry point for the user-partition profile
 * slot. Three things happen:
 *
 *   1. Seed `user/profile.md` on disk if missing (idempotent; never clobbers
 *      a non-empty existing file).
 *   2. Derive the operator-scoped PROFILE AES key via one EIP-712 sign.
 *   3a. SANDBOX mode: POST /admin/profile-key (EIP-191-signed) so the daemon
 *       picks up the key live + fires a one-shot restore for the slot.
 *   3b. LOCAL mode: trigger a /sync that encrypts profile.md + anchors the
 *       PROFILE slot on chain in the same batched updateSlots tx as the
 *       other slots.
 *
 * Idempotent: re-running after the first time only re-anchors if profile.md
 * content changed since the last flush.
 */
export async function runProfileInit(): Promise<void> {
  intro('anima profile init')

  note(
    [
      'Legacy command. v0.23.1+ folds profile-key derivation into anima init.',
      'Run this only if your agent was created before v0.23.1.',
    ].join('\n'),
    'profile init (legacy)',
  )

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima config found. Run `anima init` first.')
    return
  }
  const { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }

  const network = config.network
  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const finalAgentId = iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(finalAgentId)

  // 1. seed profile.md if missing
  const profilePath = `${paths.memoryDir}/user/profile.md`
  await mkdir(`${paths.memoryDir}/user`, { recursive: true })
  let seededNow = false
  try {
    const existing = await readFile(profilePath, 'utf8')
    if (existing.trim().length === 0) throw new Error('empty-file')
  } catch {
    const template =
      '---\nname: profile\ndescription: User profile (operator-scoped, never anchored with agent key).\ntype: user\n---\n# User profile\n\n(empty, fills as we chat)\n'
    await writeFile(profilePath, template, 'utf8')
    seededNow = true
  }
  if (seededNow) console.log(`seeded ${profilePath}`)

  // 2. derive PROFILE scope key + (sandbox) keystore-decrypt or (local) full sync
  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) {
    cancel('No operator wallet available.')
    return
  }

  const sUnlock = spinner()
  sUnlock.start('Deriving PROFILE scope key via operator')
  let profileKey: Buffer
  try {
    profileKey = await deriveBlobKey(operator, agentAddress, OPERATOR_BLOB_SCOPES.PROFILE)
    sUnlock.stop('PROFILE key derived')
  } catch (e) {
    sUnlock.stop(`derive failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }

  // 3a. SANDBOX path: POST /admin/profile-key
  if (config.deployTarget === 'sandbox' && config.sandbox?.endpoint && config.sandbox.id) {
    const { SandboxClient } = await import('../sandbox/client')
    const operatorAccount = await operator.account()
    const client = new SandboxClient({
      endpoint: config.sandbox.endpoint,
      sandboxId: config.sandbox.id,
      operator: operatorAccount,
    })
    const sShip = spinner()
    sShip.start('Shipping PROFILE key to sandbox /admin/profile-key')
    try {
      const profileScopeKeyHex = `0x${profileKey.toString('hex')}` as `0x${string}`
      const result = await client.setProfileKey(profileScopeKeyHex)
      if (result.ok) {
        sShip.stop('sandbox accepted PROFILE key')
        outro(
          [
            '',
            '  next flush will encrypt profile.md + anchor on chain',
            '  next boot will restore the slot from chain',
          ].join('\n'),
        )
      } else {
        sShip.stop(`sandbox rejected: ${result.reason ?? 'unknown'}`)
      }
    } catch (e) {
      sShip.stop(`shipment failed: ${(e as Error).message.slice(0, 200)}`)
    }
    await operator.close?.()
    return
  }

  // 3b. LOCAL path: full sync with profileKey injected
  const sUnlock2 = spinner()
  sUnlock2.start('Fetching keystore + decrypting via operator (for local /sync)')
  let agentPrivkey: Hex
  try {
    const decrypted = await withSilencedConsole(() =>
      fetchAndDecryptKeystore({
        network,
        contractAddress,
        tokenId,
        signer: operator,
        agentAddress,
        cachePath: paths.keystore,
      }),
    )
    agentPrivkey = decrypted.privkeyHex
    sUnlock2.stop(`unlocked (source: ${decrypted.source})`)
  } catch (e) {
    sUnlock2.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }
  await operator.close?.()

  const sFlush = spinner()
  sFlush.start('Encrypting profile.md + anchoring on chain')
  try {
    const res = await withSilencedConsole(async () => {
      const sync = new MemorySyncManager({
        network,
        agentId: finalAgentId,
        agentPrivkey,
        agentAddress,
        contractAddress,
        tokenId,
        profileKey,
      })
      await sync.init()
      return await sync.flushAll()
    })
    if (res.txHash) {
      sFlush.stop(`anchored ${res.changedSlots.length} slot(s)`)
      outro(
        [
          '',
          `  slots: ${res.changedSlots.join(', ')}`,
          `  tx: ${explorerTxUrl(network, res.txHash)}`,
        ].join('\n'),
      )
    } else {
      sFlush.stop('nothing to anchor (profile.md unchanged since last sync)')
    }
  } catch (e) {
    sFlush.stop(`flush failed: ${(e as Error).message.slice(0, 200)}`)
  }
}
