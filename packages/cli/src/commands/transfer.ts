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
  waitForReceiptResilient,
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
  /** Oracle privkey for signing the transfer proof when sender does not equal teeOracle. Falls back to ANIMA_ORACLE_PRIVKEY env. */
  oracleKey?: Hex
  /** Re-encrypt + round-trip verify locally; do not write to chain. */
  dryRun?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
  /** Keep profile slot unchanged (default: purge to bootstrap). */
  noPurge?: boolean
}

export type ParseTransferResult = TransferOpts | { error: string }

function parsePrivkeyFlag(name: string, args: string[]): { value: Hex } | { error: string } {
  const v = args.shift()
  if (!v) return { error: `${name} requires a hex value` }
  const norm = v.startsWith('0x') ? v : `0x${v}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
    return { error: `${name} must be a 32-byte hex string` }
  }
  return { value: norm as Hex }
}

/**
 * `anima transfer <ref> --to <addr> [--recipient-key 0x...] [--oracle-key 0x...] [--dry-run] [--yes] [--no-purge]`
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
      const r = parsePrivkeyFlag('--recipient-key', args)
      if ('error' in r) return r
      out.recipientKey = r.value
    } else if (head === '--oracle-key') {
      const r = parsePrivkeyFlag('--oracle-key', args)
      if ('error' in r) return r
      out.oracleKey = r.value
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

  // Determine oracle. Read on-chain teeOracle. If sender == oracle (MVP path
  // where operator is also the oracle), reuse the sender signer. Otherwise
  // resolve a separate oracle signer from --oracle-key flag or
  // ANIMA_ORACLE_PRIVKEY env. This unblocks back-transfers and any flow where
  // the iNFT owner differs from the contract's TEE oracle.
  const oracleAddr = (await reader.publicClient.readContract({
    address: parsed.contract,
    abi: AGENT_NFT_ABI,
    functionName: 'teeOracle',
  })) as Address
  let oracleSigner: OperatorSigner = sender
  if (oracleAddr.toLowerCase() !== senderAddr.toLowerCase()) {
    const oracleKey = opts.oracleKey ?? (process.env.ANIMA_ORACLE_PRIVKEY as Hex | undefined)
    if (!oracleKey) {
      await sender.close?.()
      await recipient.close?.()
      cancel(
        [
          'Oracle signer required (sender does not match teeOracle).',
          `  teeOracle: ${oracleAddr}`,
          `  sender:    ${senderAddr}`,
          '',
          'Provide an oracle privkey via:',
          '  --oracle-key 0x<hex>',
          '  ANIMA_ORACLE_PRIVKEY=0x<hex>',
        ].join('\n'),
      )
      return
    }
    const candidate: OperatorSigner = new RawPrivkeyOperatorSigner({
      privkey: oracleKey,
      sourceLabel: opts.oracleKey ? 'flag' : 'env:ANIMA_ORACLE_PRIVKEY',
    })
    const candidateAddr = await candidate.address()
    if (candidateAddr.toLowerCase() !== oracleAddr.toLowerCase()) {
      await candidate.close?.()
      await sender.close?.()
      await recipient.close?.()
      cancel(
        [
          'Oracle signer address does not match teeOracle.',
          `  teeOracle:   ${oracleAddr}`,
          `  signer addr: ${candidateAddr}`,
        ].join('\n'),
      )
      return
    }
    oracleSigner = candidate
  }

  const closeSigners = async (): Promise<void> => {
    if (oracleSigner !== sender) await oracleSigner.close?.()
    await recipient.close?.()
    await sender.close?.()
  }

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
    await closeSigners()
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
    await closeSigners()
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
      await closeSigners()
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
  } catch (e) {
    sTx.stop(`submit failed: ${(e as Error).message.slice(0, 240)}`)
    await closeSigners()
    return
  }

  // 0G mainnet block time is variable; viem's default receipt timeout is too
  // short and false-fails on transactions that actually succeed. Use the core
  // resilient poll helper (75 tries x 4s = 5 min budget) so we don't bail on
  // a slow block.
  let receiptStatus: 'success' | 'reverted' | 'unknown' = 'unknown'
  try {
    const receipt = await waitForReceiptResilient(reader.publicClient, txHash, {
      tries: 75,
      delayMs: 4000,
    })
    receiptStatus = receipt.status
  } catch {
    receiptStatus = 'unknown'
  }

  if (receiptStatus === 'reverted') {
    sTx.stop(`tx reverted: ${txHash}`)
    await closeSigners()
    return
  }
  if (receiptStatus === 'unknown') {
    sTx.stop('tx submitted; receipt poll timed out after ~5 min')
    await closeSigners()
    note(
      [
        'Tx submitted but receipt has not surfaced yet.',
        `  tx hash: ${txHash}`,
        `  verify:  cast tx ${txHash} --rpc-url <0g-rpc>`,
        '',
        'If status=success, you can clean up local state with:',
        `  rm -rf ${paths.dir}`,
      ].join('\n'),
      'verify manually',
    )
    return
  }

  sTx.stop(`tx confirmed: ${txHash}`)

  // -------------------------------------------------------------------------
  // Step 8: cleanup + outro. Only fires on confirmed-success receipt.
  // -------------------------------------------------------------------------
  const senderSource = sender.source
  await closeSigners()
  await rm(paths.dir, { recursive: true, force: true }).catch(() => {})

  if (senderSource.startsWith('raw-privkey:')) {
    note(
      [
        `Sender ${senderAddr} was provided via raw privkey.`,
        'It may hold residual gas; sweep with cast:',
        `  cast balance --rpc-url <0g-rpc> ${senderAddr}`,
        '  cast send --rpc-url <0g-rpc> --private-key 0x... <main-wallet-addr> --value <wei>',
      ].join('\n'),
      'sweep tip',
    )
  }

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
