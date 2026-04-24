import { existsSync } from 'node:fs'
import { cancel, isCancel, note, password, select, text } from '@clack/prompts'
import {
  type AnimaNetwork,
  KeychainOperatorSigner,
  KeystoreFileOperatorSigner,
  type OperatorSigner,
  RawPrivkeyOperatorSigner,
  WalletConnectOperatorSigner,
} from '@s0nderlabs/anima-core'

export type OperatorSource = 'walletconnect' | 'keychain' | 'keystore-file' | 'raw-privkey'

interface PickerOptions {
  network: AnimaNetwork
}

/**
 * Prompt the user for their operator wallet source and return a connected
 * `OperatorSigner`. This is the single chokepoint used by `anima init` and
 * `anima topup --agent` (both need operator gas).
 *
 * Platform-aware: on macOS, all four sources are offered. On Linux/Windows,
 * the OS keychain option is hidden because we don't have a Touch-ID-equivalent
 * biometric helper for those platforms yet (post-MVP).
 */
export async function pickOperatorSigner(opts: PickerOptions): Promise<OperatorSigner | null> {
  const isMac = process.platform === 'darwin'
  const choices: { value: OperatorSource; label: string; hint?: string }[] = [
    {
      value: 'walletconnect',
      label: 'WalletConnect',
      hint: 'scan QR with any WC-compatible mobile wallet',
    },
    ...(isMac
      ? ([
          {
            value: 'keychain',
            label: 'macOS Keychain',
            hint: 'stored in login keychain',
          },
        ] as const)
      : []),
    {
      value: 'keystore-file',
      label: 'Keystore file',
      hint: 'encrypted JSON, geth format',
    },
    {
      value: 'raw-privkey',
      label: 'Raw private key',
      hint: 'stdin prompt, for CI/scripting',
    },
  ]
  const source = (await select({
    message: 'Connect your operator wallet (owns the iNFT)',
    options: choices,
    initialValue: choices[0]!.value,
  })) as OperatorSource | symbol
  if (isCancel(source)) {
    cancel('Aborted.')
    return null
  }

  switch (source) {
    case 'walletconnect':
      return new WalletConnectOperatorSigner({ networks: [opts.network] })
    case 'keychain': {
      const service = await text({
        message: 'Keychain service name',
        placeholder: 'anima.operator',
        initialValue: 'anima.operator',
        validate: v => {
          if (!v || v.length === 0) return 'Required.'
          if (!/^[a-zA-Z0-9._-]{1,128}$/.test(v))
            return 'Allowed characters: a-z, A-Z, 0-9, dot, underscore, hyphen (max 128).'
          return undefined
        },
      })
      if (isCancel(service)) {
        cancel('Aborted.')
        return null
      }
      return new KeychainOperatorSigner(service as string)
    }
    case 'keystore-file': {
      const path = await text({
        message: 'Path to encrypted JSON keystore',
        placeholder: '~/wallets/operator.json',
        validate: v => {
          if (!v) return 'Required.'
          const expanded = v.replace(/^~/, process.env.HOME ?? '~')
          if (!existsSync(expanded)) return `File not found: ${expanded}`
          return undefined
        },
      })
      if (isCancel(path)) {
        cancel('Aborted.')
        return null
      }
      const expanded = (path as string).replace(/^~/, process.env.HOME ?? '~')
      const pass = await password({
        message: 'Passphrase for the keystore',
        validate: v => (v && v.length > 0 ? undefined : 'Required.'),
      })
      if (isCancel(pass)) {
        cancel('Aborted.')
        return null
      }
      return new KeystoreFileOperatorSigner({ path: expanded, passphrase: pass as string })
    }
    case 'raw-privkey': {
      if (process.env.ANIMA_OPERATOR_PRIVKEY) {
        note('Using ANIMA_OPERATOR_PRIVKEY from env.', 'raw-privkey')
        return new RawPrivkeyOperatorSigner({
          privkey: process.env.ANIMA_OPERATOR_PRIVKEY,
          sourceLabel: 'env:ANIMA_OPERATOR_PRIVKEY',
        })
      }
      const pk = await password({
        message: 'Operator private key (hex, 0x prefix optional)',
        validate: v => {
          if (!v) return 'Required.'
          const clean = v.trim().replace(/^0x/, '')
          if (!/^[0-9a-fA-F]{64}$/.test(clean)) return 'Must be 32 bytes hex.'
          return undefined
        },
      })
      if (isCancel(pk)) {
        cancel('Aborted.')
        return null
      }
      return new RawPrivkeyOperatorSigner({ privkey: pk as string, sourceLabel: 'stdin' })
    }
  }
}
