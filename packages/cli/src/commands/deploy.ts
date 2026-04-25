import { cancel, intro, isCancel, note, outro, select } from '@clack/prompts'
import type { Address } from 'viem'
import { findAndLoadConfig } from '../config/load'

/**
 * `anima deploy` — migrate a Local-mode agent to 0G Sandbox via Option 3
 * (project-anima.md / phase-6.6-operator-wallet-keystore-decision.md).
 *
 * Phase 6.6 lands the crypto + CLI scaffold; Phase 11 lands the actual
 * gateway endpoint and sandbox harness. Until then this command:
 *
 *   1. Confirms config has an iNFT
 *   2. Decrypts agent keystore via operator wallet (uses Phase 6.6 keystore-blob)
 *   3. Stubs the sandbox container handoff: prints what would happen and
 *      exits, so the user can see the migration plan without burning compute.
 *
 * When Phase 11 ships, this command will:
 *   - Call `sandbox.create` with operator pubkey + iNFT ref (no privkey)
 *   - Poll container's `GET /bootstrap/pubkey` for its ephemeral pubkey
 *     (and TEE attestation if sealed mode)
 *   - encryptToPubkey() the agent privkey to that bootstrap pubkey
 *   - POST the ciphertext to container's `/bootstrap/provision`
 *   - Wait for container's `/healthz`
 *   - Update iNFT subname's `agent:endpoint` text record
 *   - Local gateway shuts down after handoff
 */
export async function runDeploy(): Promise<void> {
  intro('anima deploy')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found. Run `anima init` first.')
    return
  }
  const { config } = loaded

  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address

  const target = (await select({
    message: 'Migrate to which target?',
    options: [
      {
        value: 'sandbox-testnet' as const,
        label: '0G Sandbox (testnet, Daytona TDX)',
        hint: 'Phase 11 — full handoff lands when sandbox harness ships',
      },
      {
        value: 'self-hosted' as const,
        label: 'Self-hosted gateway (Hetzner / VPS / home server)',
        hint: 'post-MVP',
      },
    ],
    initialValue: 'sandbox-testnet',
  })) as 'sandbox-testnet' | 'self-hosted' | symbol
  if (isCancel(target)) {
    cancel('Aborted.')
    return
  }

  if (target === 'self-hosted') {
    note(
      'Self-hosted target is post-MVP. The same Option 3 crypto applies but the destination endpoint is your own deployment.',
      'not implemented yet',
    )
    cancel('Aborted.')
    return
  }

  // Phase 11 lands the actual sandbox.create + bootstrap polling + provision
  // relay. The Option 3 crypto primitive (encryptToPubkey) is already in core.
  // Until the sandbox harness ships, this command prints the plan and exits
  // without unlocking the keystore — no operator signature wasted on a stub.
  note(
    [
      `Agent ${agentAddress} on iNFT #${tokenId.toString()} (${contractAddress}).`,
      'Phase 11 will:',
      '  1. POST /api/sandbox (operator pubkey + iNFT ref, NO privkey)',
      '  2. Poll container GET /bootstrap/pubkey for ephemeral keypair + TEE attestation',
      '  3. encryptToPubkey(agentPrivkey, containerBootstrapPubkey) — locally',
      '  4. POST envelope to container /bootstrap/provision',
      '  5. Wait for /healthz, update iNFT subname agent:endpoint',
      '  6. Shut down local gateway',
      '',
      'Crypto primitives shipped (Bundle 11 of Phase 6.6); HTTP endpoints land with Phase 11.',
    ].join('\n'),
    'sandbox handoff plan',
  )
  outro('Phase 11 will wire this command to a live sandbox. Skipping for now.')
}
