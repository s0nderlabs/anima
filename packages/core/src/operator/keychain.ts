import { spawnSync } from 'node:child_process'
import type { Hex } from 'viem'
import { PrivkeyOperatorSigner } from './privkey-base'

/** Safe subset of characters allowed in a keychain service name. Rejects
 *  shell metacharacters so user-supplied service names can never inject.
 */
const SERVICE_NAME_RE = /^[a-zA-Z0-9._-]{1,128}$/

/**
 * Loads the operator privkey from the macOS Keychain under a service name.
 *
 * First-class operator wallet source on macOS. Same trust model as a password
 * manager: the key is encrypted at rest by the OS, unlocked by the user's
 * login password, accessible to the process the user is running. Keychain
 * entries can optionally be gated by Touch ID via the biometric helper
 * (shipped as a separate Swift binary, see Phase 6.5b).
 *
 * Linux and Windows equivalents (libsecret, Credential Manager) are post-MVP.
 * For now non-macOS users pick one of the other OperatorSigner implementations
 * (WalletConnect, keystore file, raw privkey).
 *
 * Service name is user-chosen: we default to `anima.operator` but the caller
 * can pass any string. Existing dev setups may use `dev.deployer` etc.
 */
export class KeychainOperatorSigner extends PrivkeyOperatorSigner {
  readonly source: string

  constructor(private readonly keychainService: string = 'dev.deployer') {
    super()
    if (!SERVICE_NAME_RE.test(keychainService)) {
      throw new Error(
        `Invalid keychain service name. Allowed: alphanumerics, dot, underscore, hyphen (max 128). Got: ${keychainService}`,
      )
    }
    this.source = `keychain:${keychainService}`
  }

  protected async loadPrivkey(): Promise<Hex> {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', this.keychainService, '-w'],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(
        `security find-generic-password failed for service '${this.keychainService}': ${result.stderr?.trim() || `exit ${result.status}`}`,
      )
    }
    const raw = result.stdout.trim()
    return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  }
}
