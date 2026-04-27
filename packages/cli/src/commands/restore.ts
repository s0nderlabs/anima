import { mkdir, writeFile } from 'node:fs/promises'
import { cancel, intro, isCancel, note, outro, password, spinner } from '@clack/prompts'
import {
  type EncryptedKeystore,
  agentPaths,
  decryptKey,
  defineConfig,
  explorerTokenUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  restoreKeystoreFromStorage,
  sniffKeystoreVersion,
} from '@s0nderlabs/anima-core'
import { type Address, bytesToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { writeConfigTs } from '../config/render'
import { type ParsedINFTRef, parseINFTRef } from './_inft-ref'
import { pickOperatorSigner } from './init/operator-picker'

export async function runRestore(opts: { ref: string; cwd?: string }): Promise<void> {
  const configPath = agentPaths.config

  intro('anima restore')

  let parsed: ParsedINFTRef
  try {
    parsed = parseINFTRef(opts.ref)
  } catch (e) {
    cancel((e as Error).message)
    return
  }

  const s1 = spinner()
  s1.start(`Fetching iNFT #${parsed.tokenId} on ${parsed.network}`)

  let encryptedBytes: Uint8Array
  let operatorAddressOnChain: Address
  try {
    const downloaded = await restoreKeystoreFromStorage({
      network: parsed.network,
      contractAddress: parsed.contract,
      tokenId: parsed.tokenId,
    })
    if (!downloaded) {
      s1.stop('keystore slot is unset or predates storage-backed recovery')
      note(
        [
          'This iNFT does not have an encrypted keystore uploaded to 0G Storage.',
          'Either the slot still holds a bootstrap placeholder, or the agent was',
          'minted before the recovery path was live. If you have a local keystore,',
          'copy it to ~/.anima/agents/<id>/keystore.json manually.',
        ].join('\n'),
        'cannot restore',
      )
      return
    }
    encryptedBytes = downloaded.encryptedBytes
    operatorAddressOnChain = downloaded.owner
    s1.stop(`fetched ${encryptedBytes.byteLength} bytes from 0G Storage`)
  } catch (e) {
    s1.stop(`fetch failed: ${(e as Error).message}`)
    return
  }

  const version = sniffKeystoreVersion(encryptedBytes)

  const agentId = iNFTAgentId({ contractAddress: parsed.contract, tokenId: parsed.tokenId })
  const paths = agentPaths.agent(agentId)
  let privkeyHex: `0x${string}`
  let agentAddress: Address

  if (version === 1) {
    note(
      'Detected legacy v1 (passphrase) keystore. After restore, run `anima migrate-keystore` to upgrade to v2 (operator-wallet-encrypted).',
      'legacy keystore',
    )
    const pass = await password({
      message: 'Passphrase for the agent keystore',
      validate: v => (v && v.length >= 1 ? undefined : 'Required.'),
    })
    if (isCancel(pass)) {
      cancel('Aborted.')
      return
    }
    try {
      const ks = JSON.parse(new TextDecoder().decode(encryptedBytes)) as EncryptedKeystore
      const privkey = decryptKey(ks, pass)
      privkeyHex = bytesToHex(privkey)
      agentAddress = privateKeyToAccount(privkeyHex).address
    } catch (e) {
      cancel(`decrypt failed: ${(e as Error).message}. Wrong passphrase or corrupted keystore.`)
      return
    }
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.keystore, new TextDecoder().decode(encryptedBytes), 'utf8')
  } else if (version === 2) {
    const picked = await pickOperatorSigner({ network: parsed.network })
    if (!picked) return
    const operator = picked.signer
    const pickedAddr = await operator.address()
    if (pickedAddr.toLowerCase() !== operatorAddressOnChain.toLowerCase()) {
      // Hard abort: decrypt is provably impossible from a different wallet,
      // and keeping the WC session open while we ask the user to retype the
      // agent address gives the WC event bus time to fire `chainChanged` /
      // `accountsChanged`, which crashes universal-provider with an uncaught
      // TypeError when the chain isn't in our config. Cancel + disconnect now.
      await operator.close?.()
      cancel(
        [
          'Operator wallet mismatch.',
          `  iNFT owner:  ${operatorAddressOnChain}`,
          `  you connected: ${pickedAddr}`,
          '',
          'You must connect the same wallet that owns this iNFT, then retry.',
          'If the iNFT-owning key only exists in your local keystore (e.g.',
          'macOS Keychain), import it into your mobile wallet first, or pick',
          'a different operator source on the next run.',
        ].join('\n'),
      )
      return
    }

    const sUnlock = spinner()
    sUnlock.start('Decrypting keystore via operator wallet signature')
    try {
      // We don't know the agent address yet (it's encoded into the typed data).
      // Best path: read the agent address from the iNFT's text records or
      // attempt decrypt by trying the address derived from a successful
      // decrypt. For MVP we ask the user since restoring on a fresh machine
      // means they can't easily derive it.
      sUnlock.stop('need agent address')
      const agentAddrInput = (await password({
        message: 'Agent EOA address (0x…) — find it on the iNFT subname or your records',
        validate: v => {
          if (!v) return 'Required.'
          if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return 'Must be a 20-byte hex address.'
          return undefined
        },
      })) as string | symbol
      if (isCancel(agentAddrInput)) {
        cancel('Aborted.')
        await operator.close?.()
        return
      }
      agentAddress = agentAddrInput as Address

      const sDecrypt = spinner()
      sDecrypt.start('Sign typed data + decrypt')
      const decrypted = await fetchAndDecryptKeystore({
        network: parsed.network,
        contractAddress: parsed.contract,
        tokenId: parsed.tokenId,
        signer: operator,
        agentAddress,
        cachePath: paths.keystore,
      })
      privkeyHex = decrypted.privkeyHex
      const derived = privateKeyToAccount(privkeyHex).address
      if (derived.toLowerCase() !== agentAddress.toLowerCase()) {
        sDecrypt.stop('decrypt produced unexpected agent address')
        cancel(
          `Decrypted privkey points to ${derived} but you said ${agentAddress}. Aborting to prevent stale config.`,
        )
        await operator.close?.()
        return
      }
      sDecrypt.stop(`decrypted (source: ${decrypted.source})`)
    } catch (e) {
      cancel(`decrypt failed: ${(e as Error).message}`)
      await operator.close?.()
      return
    }
    await operator.close?.()
  } else {
    cancel(`Unknown keystore version: ${version}. This blob may be corrupted.`)
    return
  }

  const cfg = defineConfig({
    identity: {
      iNFT: {
        contract: parsed.contract,
        tokenId: parsed.tokenId.toString(),
        network: parsed.network,
      },
      operator: operatorAddressOnChain,
      agent: agentAddress,
    },
    network: parsed.network,
    storage: { network: parsed.network },
    brain: { provider: null, model: null },
    plugins: ['onchain', 'comms', 'system'],
    tools: {},
    imports: { claudeCode: true },
    operator: null,
  })
  await writeConfigTs(configPath, cfg, {
    header: '// Regenerated by `anima restore`. Edit freely; type-safe.',
    subname: null,
  })

  outro(
    [
      '',
      `  agent id   ${agentId}`,
      `  agent EOA  ${agentAddress}`,
      `  operator   ${operatorAddressOnChain}`,
      `  iNFT       #${parsed.tokenId.toString()} at ${parsed.contract}`,
      `             ${explorerTokenUrl(parsed.network, parsed.contract, parsed.tokenId)}`,
      `  config     ${configPath}`,
      `  keystore   ${paths.keystore}`,
      '',
      'Next: `anima` to chat, or `anima topup --compute 5` if ledger is dry.',
      version === 1
        ? 'Then: `anima migrate-keystore` to upgrade to v2 (drops the passphrase).'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}
