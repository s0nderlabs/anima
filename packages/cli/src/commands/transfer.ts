import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { cancel, confirm, intro, isCancel, note, outro, password, spinner } from '@clack/prompts'
import {
  AGENT_NFT_ABI,
  AnimaAgentNFTReader,
  NETWORK_CHAIN_ID,
  type OperatorSigner,
  RawPrivkeyOperatorSigner,
  agentPaths,
  buildTransferHashes,
  explorerTokenUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  reEncryptKeystoreForRecipient,
  signTransferProof,
  slotIndex,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, isAddress, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type ParsedINFTRef, parseINFTRef } from './_inft-ref'
import { pickOperatorSigner } from './init/operator-picker'

export interface TransferOpts {
  /** iNFT ref string e.g. `eip155:16661:0x9e71...:7` */
  ref: string
  /** Recipient operator address (the new owner). */
  to: Address
  /** Recipient's privkey for re-encryption sig. Falls back to ANIMA_RECIPIENT_PRIVKEY env, then interactive picker. */
  recipientKey?: Hex
  /** Re-encrypt + round-trip verify locally; do not write to chain. */
  dryRun?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
  /** Keep profile slot unchanged (default: purge to bootstrap). */
  noPurge?: boolean
}

export type ParseTransferResult = TransferOpts | { error: string }

/**
 * `anima transfer <ref> --to <addr> [--recipient-key 0x...] [--dry-run] [--yes] [--no-purge]`
 *
 * Positional `<ref>` is the iNFT identifier (`eip155:<chainId>:<contract>:<tokenId>`
 * or shorthand). All other args are flags.
 */
export function parseTransferArgs(argv: readonly string[]): ParseTransferResult {
  const args = [...argv]
  const out: Partial<TransferOpts> = {}
  while (args.length > 0) {
    const head = args.shift()!
    if (head === '--to') {
      const v = args.shift()
      if (!v) return { error: '--to requires an address' }
      if (!isAddress(v)) return { error: `--to value '${v}' is not a valid address` }
      out.to = v as Address
    } else if (head === '--recipient-key') {
      const v = args.shift()
      if (!v) return { error: '--recipient-key requires a hex value' }
      const norm = v.startsWith('0x') ? v : `0x${v}`
      if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
        return { error: '--recipient-key must be a 32-byte hex string' }
      }
      out.recipientKey = norm as Hex
    } else if (head === '--dry-run') {
      out.dryRun = true
    } else if (head === '--yes' || head === '-y') {
      out.yes = true
    } else if (head === '--no-purge') {
      out.noPurge = true
    } else if (head.startsWith('-')) {
      return { error: `unknown flag: ${head}` }
    } else if (!out.ref) {
      out.ref = head
    } else {
      return { error: `unexpected positional argument: ${head}` }
    }
  }
  if (!out.ref) return { error: 'iNFT ref is required (positional)' }
  if (!out.to) return { error: '--to <recipient-address> is required' }
  return out as TransferOpts
}

export async function runTransfer(opts: TransferOpts): Promise<void> {
  intro(opts.dryRun ? 'anima transfer (dry run)' : 'anima transfer')

  let parsed: ParsedINFTRef
  try {
    parsed = parseINFTRef(opts.ref)
  } catch (e) {
    cancel((e as Error).message)
    return
  }
  if (parsed.contract.toLowerCase() === opts.to.toLowerCase()) {
    cancel('refusing transfer: --to address equals iNFT contract address')
    return
  }

  // -------------------------------------------------------------------------
  // Step 1: read current state (owner + slot hashes + oracle).
  // -------------------------------------------------------------------------
  const sFetch = spinner()
  sFetch.start(`Fetching iNFT #${parsed.tokenId} state on ${parsed.network}`)
  const reader = new AnimaAgentNFTReader({
    network: parsed.network,
    contractAddress: parsed.contract,
  })
  let currentOwner: Address
  let currentSlots: { dataHash: Hex }[]
  try {
    const [owner, slots] = await Promise.all([
      reader.ownerOf(parsed.tokenId),
      reader.getIntelligentData(parsed.tokenId),
    ])
    currentOwner = owner
    currentSlots = slots
    sFetch.stop(`owner=${owner} slots=${slots.length}`)
  } catch (e) {
    sFetch.stop(`fetch failed: ${(e as Error).message.slice(0, 200)}`)
    return
  }
  if (opts.to.toLowerCase() === currentOwner.toLowerCase()) {
    cancel('refusing transfer: --to address equals current owner')
    return
  }

  // -------------------------------------------------------------------------
  // Step 2: pick sender (operator A). Must equal current owner.
  // -------------------------------------------------------------------------
  const senderPicked = await pickOperatorSigner({ network: parsed.network })
  if (!senderPicked) {
    cancel('aborted: no sender wallet')
    return
  }
  const sender = senderPicked.signer
  const senderAddr = await sender.address()
  if (senderAddr.toLowerCase() !== currentOwner.toLowerCase()) {
    await sender.close?.()
    cancel(
      [
        'Sender wallet does not own this iNFT.',
        `  current owner: ${currentOwner}`,
        `  you connected: ${senderAddr}`,
      ].join('\n'),
    )
    return
  }

  // -------------------------------------------------------------------------
  // Step 3: prompt for agent EOA, decrypt keystore via sender wallet.
  // -------------------------------------------------------------------------
  const agentAddrInput = (await password({
    message: 'Agent EOA address (0x...) — find via your config or the iNFT subname',
    validate: v => {
      if (!v) return 'Required.'
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return 'Must be a 20-byte hex address.'
      return undefined
    },
  })) as string | symbol
  if (isCancel(agentAddrInput)) {
    cancel('aborted')
    await sender.close?.()
    return
  }
  const agentAddress = agentAddrInput as Address
  const agentId = iNFTAgentId({ contractAddress: parsed.contract, tokenId: parsed.tokenId })
  const paths = agentPaths.agent(agentId)

  const sUnlock = spinner()
  sUnlock.start('Decrypting agent keystore via sender wallet')
  let agentPrivkey: Hex
  try {
    const decrypted = await fetchAndDecryptKeystore({
      network: parsed.network,
      contractAddress: parsed.contract,
      tokenId: parsed.tokenId,
      signer: sender,
      agentAddress,
      cachePath: paths.keystore,
    })
    agentPrivkey = decrypted.privkeyHex
    const derived = privateKeyToAccount(agentPrivkey).address
    if (derived.toLowerCase() !== agentAddress.toLowerCase()) {
      sUnlock.stop('agent address mismatch')
      cancel(`Decrypted privkey points to ${derived} but you said ${agentAddress}.`)
      await sender.close?.()
      return
    }
    sUnlock.stop(`unlocked agent EOA ${agentAddress}`)
  } catch (e) {
    sUnlock.stop(`decrypt failed: ${(e as Error).message.slice(0, 200)}`)
    await sender.close?.()
    return
  }

  // -------------------------------------------------------------------------
  // Step 4: resolve recipient signer.
  //   precedence: --recipient-key > ANIMA_RECIPIENT_PRIVKEY env > picker.
  // -------------------------------------------------------------------------
  const recipientKey = opts.recipientKey ?? (process.env.ANIMA_RECIPIENT_PRIVKEY as Hex | undefined)
  let recipient: OperatorSigner
  if (recipientKey) {
    recipient = new RawPrivkeyOperatorSigner({
      privkey: recipientKey,
      sourceLabel: opts.recipientKey ? 'flag' : 'env:ANIMA_RECIPIENT_PRIVKEY',
    })
  } else {
    note('Recipient signer not provided via flag/env. Pick one interactively.', 'recipient')
    const picked = await pickOperatorSigner({ network: parsed.network })
    if (!picked) {
      cancel('aborted: no recipient signer')
      await sender.close?.()
      return
    }
    recipient = picked.signer
  }
  const recipientAddr = await recipient.address()
  if (recipientAddr.toLowerCase() !== opts.to.toLowerCase()) {
    await sender.close?.()
    await recipient.close?.()
    cancel(
      [
        'Recipient signer address does not match --to.',
        `  --to:        ${opts.to}`,
        `  signer addr: ${recipientAddr}`,
      ].join('\n'),
    )
    return
  }

  // -------------------------------------------------------------------------
  // Step 5: re-encrypt keystore with recipient's signer + upload to 0G Storage.
  // -------------------------------------------------------------------------
  const sReEnc = spinner()
  sReEnc.start('Re-encrypting keystore for recipient + uploading to 0G Storage')
  let newKeystoreHash: Hex
  try {
    const currentKeystoreHash = currentSlots[slotIndex('keystore')]?.dataHash
    if (!currentKeystoreHash) {
      throw new Error('keystore slot missing from current iNFT state')
    }
    newKeystoreHash = await reEncryptKeystoreForRecipient({
      oldOpSigner: sender,
      newOpSigner: recipient,
      agentAddress,
      currentRootHash: currentKeystoreHash,
      network: parsed.network,
      agentPrivkey,
    })
    sReEnc.stop(`uploaded new keystore blob: ${newKeystoreHash.slice(0, 18)}...`)
  } catch (e) {
    sReEnc.stop(`re-encrypt failed: ${(e as Error).message.slice(0, 200)}`)
    await sender.close?.()
    await recipient.close?.()
    return
  }

  // -------------------------------------------------------------------------
  // Step 6: build newHashes[6], sign oracle proof.
  // -------------------------------------------------------------------------
  const newHashes = buildTransferHashes({
    currentHashes: currentSlots.map(s => s.dataHash),
    newKeystoreHash,
    purgeProfile: !opts.noPurge,
  })
  const proofNonce = toHex(randomBytes(32))
  const chainId = NETWORK_CHAIN_ID[parsed.network]

  // Determine oracle. Read on-chain teeOracle and require sender to match.
  // In MVP the operator IS the oracle; in production this could be a TEE
  // service exposed via a separate signer interface.
  const oracleAddr = (await reader.publicClient.readContract({
    address: parsed.contract,
    abi: AGENT_NFT_ABI,
    functionName: 'teeOracle',
  })) as Address
  if (oracleAddr.toLowerCase() !== senderAddr.toLowerCase()) {
    await sender.close?.()
    await recipient.close?.()
    cancel(
      [
        'Oracle signer required but sender does not match teeOracle.',
        `  teeOracle: ${oracleAddr}`,
        `  sender:    ${senderAddr}`,
        '',
        'External oracle signer flow is not yet supported.',
      ].join('\n'),
    )
    return
  }
  const oracleSigner = sender

  const sOracle = spinner()
  sOracle.start('Signing transfer proof with oracle')
  let oracleSignature: Hex
  try {
    oracleSignature = await signTransferProof(
      {
        tokenId: parsed.tokenId,
        from: senderAddr,
        to: opts.to,
        newHashes,
        chainId,
        proofNonce,
        contractAddress: parsed.contract,
      },
      oracleSigner,
    )
    sOracle.stop('proof signed')
  } catch (e) {
    sOracle.stop(`oracle sign failed: ${(e as Error).message.slice(0, 200)}`)
    await sender.close?.()
    await recipient.close?.()
    return
  }

  // -------------------------------------------------------------------------
  // Step 7: dry-run gate or confirm + iTransferFrom.
  // -------------------------------------------------------------------------
  const purgeLabel = !opts.noPurge ? 'YES (slot 3 -> bootstrap)' : 'NO'
  const slotChanges = currentSlots
    .map((s, i) => {
      const before = s.dataHash
      const after = newHashes[i]
      return after === before
        ? null
        : `  slot ${i}: ${before.slice(0, 12)}... -> ${after?.slice(0, 12)}...`
    })
    .filter(Boolean)
  note(
    [
      `iNFT:      #${parsed.tokenId} at ${parsed.contract}`,
      `from:      ${senderAddr}`,
      `to:        ${opts.to}`,
      `agent EOA: ${agentAddress} (unchanged)`,
      `oracle:    ${oracleAddr}`,
      `purge profile: ${purgeLabel}`,
      `nonce:     ${proofNonce}`,
      '',
      'slot changes:',
      ...(slotChanges as string[]),
    ].join('\n'),
    'transfer plan',
  )

  if (opts.dryRun) {
    await sender.close?.()
    await recipient.close?.()
    outro(
      [
        '',
        '  dry-run complete.',
        `  new keystore root: ${newKeystoreHash}`,
        '  re-encryption round-trip succeeded; chain unchanged.',
        '  re-run without --dry-run to commit.',
        '',
      ].join('\n'),
    )
    return
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: `Commit iTransferFrom on ${parsed.network}? Sender wallet pays gas.`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) {
      cancel('aborted')
      await sender.close?.()
      await recipient.close?.()
      return
    }
  }

  // Submit iTransferFrom via the operator's WalletClient directly. Avoids
  // needing to extract the privkey from privkey-based signers, and keeps the
  // door open for WalletConnect senders later (their walletClient signs via
  // the WC relay).
  const senderWallet = await sender.walletClient(parsed.network)
  const senderAccount = await sender.account()
  const sTx = spinner()
  sTx.start('Submitting iTransferFrom on chain')
  let txHash: Hex
  try {
    txHash = (await senderWallet.writeContract({
      address: parsed.contract,
      abi: AGENT_NFT_ABI,
      functionName: 'iTransferFrom',
      args: [
        senderAddr,
        opts.to,
        parsed.tokenId,
        [...newHashes] as Hex[],
        proofNonce,
        oracleSignature,
      ],
      chain: sender.chain(parsed.network),
      account: senderAccount,
      gas: BigInt(newHashes.length) * 60_000n + 200_000n,
    })) as Hex
    // Wait for receipt via the reader's publicClient.
    const receipt = await reader.publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      throw new Error(`iTransferFrom reverted in tx ${txHash}`)
    }
    sTx.stop(`tx confirmed: ${txHash}`)
  } catch (e) {
    sTx.stop(`iTransferFrom failed: ${(e as Error).message.slice(0, 240)}`)
    await sender.close?.()
    await recipient.close?.()
    return
  }

  // -------------------------------------------------------------------------
  // Step 8: cleanup + outro.
  // -------------------------------------------------------------------------
  await sender.close?.()
  await recipient.close?.()
  await rm(paths.dir, { recursive: true, force: true }).catch(() => {})

  outro(
    [
      '',
      `  iNFT          #${parsed.tokenId} at ${parsed.contract}`,
      `  new owner     ${opts.to}`,
      `  tx            ${txHash}`,
      `  explorer      ${explorerTokenUrl(parsed.network, parsed.contract, parsed.tokenId)}`,
      '',
      'Recipient: run `anima restore` from your environment with the recipient',
      'wallet to unlock the agent locally.',
      '',
    ].join('\n'),
  )
}
