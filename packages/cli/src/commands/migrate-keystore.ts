import { readFile } from 'node:fs/promises'
import { cancel, confirm, intro, isCancel, note, outro, password, spinner } from '@clack/prompts'
import {
  type EncryptedKeystore,
  agentPaths,
  decryptKey,
  defineConfig,
  iNFTAgentId,
  uploadKeystore,
} from '@s0nderlabs/anima-core'
import { type Address, bytesToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { pickOperatorSigner } from './init/operator-picker'

/**
 * One-shot upgrade for v0.5.0 users: read the legacy passphrase-encrypted
 * keystore, decrypt it, re-encrypt under the operator wallet (Phase 6.6),
 * upload the new ciphertext to 0G Storage, anchor the new root hash into
 * the iNFT keystore slot, and remove the local passphrase keystore file.
 *
 * After running, the agent is on the v2 (sign-derived-key) path; chat /
 * topup --compute / restore / resume all work without a passphrase.
 */
export async function runMigrateKeystore(): Promise<void> {
  intro('anima migrate-keystore')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima config found. Run `anima init` (or `anima restore`) first.')
    return
  }
  const { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Nothing to migrate.')
    return
  }

  const network = config.network
  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const finalAgentId = iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(finalAgentId)

  let v1: EncryptedKeystore
  try {
    const raw = await readFile(paths.keystore, 'utf8')
    v1 = JSON.parse(raw) as EncryptedKeystore
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      cancel(
        `No local keystore at ${paths.keystore}. Migration only works when v0.5.0 left a passphrase keystore on disk. If you only have the iNFT, use \`anima restore\` (it handles v1 directly).`,
      )
      return
    }
    cancel(`Failed to read existing keystore: ${(e as Error).message}`)
    return
  }
  if (v1.version !== 1) {
    cancel(
      `Local keystore is already version ${v1.version}. Nothing to migrate. (Phase 6.6 keystores are version 2.)`,
    )
    return
  }

  const pass = await password({
    message: 'Current passphrase for the agent keystore',
    validate: v => (v && v.length >= 1 ? undefined : 'Required.'),
  })
  if (isCancel(pass)) {
    cancel('Aborted.')
    return
  }

  let agentPrivkey: `0x${string}`
  try {
    const bytes = decryptKey(v1, pass as string)
    agentPrivkey = bytesToHex(bytes)
    const derived = privateKeyToAccount(agentPrivkey).address
    if (derived.toLowerCase() !== agentAddress.toLowerCase()) {
      cancel(
        `Decrypted keystore points to ${derived} but config says ${agentAddress}. Refusing to overwrite.`,
      )
      return
    }
  } catch (e) {
    cancel(`Decrypt failed: ${(e as Error).message}. Wrong passphrase?`)
    return
  }

  const proceed = await confirm({
    message:
      'About to re-encrypt to operator wallet, upload to 0G Storage, update iNFT slot, and delete the local passphrase keystore. Continue?',
    initialValue: true,
  })
  if (isCancel(proceed) || !proceed) {
    cancel('Aborted.')
    return
  }

  const picked = await pickOperatorSigner({ network })
  if (!picked) return
  const { signer: operator, hint: operatorHint } = picked

  const sUpload = spinner()
  sUpload.start('Encrypting to operator wallet + uploading to 0G Storage')
  let rootHash: string
  try {
    const result = await uploadKeystore({
      network,
      signer: operator,
      agentAddress,
      agentPrivkey,
      tokenId,
      contractAddress,
      cachePath: paths.keystore,
    })
    rootHash = result.rootHash
    sUpload.stop(`re-anchored at root ${rootHash.slice(0, 12)}…`)
  } catch (e) {
    sUpload.stop(`upload failed: ${(e as Error).message.slice(0, 160)}`)
    note(
      'Local v1 keystore is unchanged. Re-run `anima migrate-keystore` after fixing the issue.',
      'no changes made',
    )
    await operator.close?.()
    return
  }

  // Update config to record the operator hint so subsequent commands skip the picker.
  const cfg = defineConfig({
    ...config,
    operator: operatorHint,
  })
  await writeConfigTs(loaded.path, cfg, {
    header: '// Updated by `anima migrate-keystore`. Edit freely; type-safe.',
  })

  await operator.close?.()

  outro(
    [
      '',
      'Migration complete.',
      `  agent     ${agentAddress}`,
      `  iNFT slot updated → ${rootHash.slice(0, 12)}…`,
      `  keystore  ${paths.keystore} (now v2 cache)`,
      `  config    operator source persisted: ${operatorHint.source}`,
      '',
      'You can now use `anima` (chat) / `anima topup --compute` without a passphrase.',
    ].join('\n'),
  )
}
