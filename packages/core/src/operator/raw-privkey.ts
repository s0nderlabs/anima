import type { Hex } from 'viem'
import { PrivkeyOperatorSigner } from './privkey-base'

/**
 * Operator source backed by a raw private key supplied as a hex string.
 *
 * CLI layer collects the hex (stdin prompt, `--privkey` flag, or
 * `ANIMA_OPERATOR_PRIVKEY` env var) and passes it in. The signer just wraps.
 * Intended for CI/scripting and for users who prefer no-on-disk secrets.
 *
 * The hex may be passed with or without the `0x` prefix; the signer normalizes.
 */
export class RawPrivkeyOperatorSigner extends PrivkeyOperatorSigner {
  readonly source: string
  private readonly privkeyHex: Hex

  constructor(opts: {
    /** Raw private key hex, with or without `0x` prefix. */
    privkey: string
    /**
     * Optional label for logs (e.g. `"env:ANIMA_OPERATOR_PRIVKEY"` or
     * `"stdin"`). Defaults to `"raw-privkey"` which tells the user nothing.
     */
    sourceLabel?: string
  }) {
    super()
    const raw = opts.privkey.trim()
    const withPrefix = raw.startsWith('0x') ? raw : `0x${raw}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
      throw new Error('RawPrivkeyOperatorSigner: privkey must be 32 bytes hex (with or without 0x)')
    }
    this.privkeyHex = withPrefix as Hex
    this.source = opts.sourceLabel ? `raw-privkey:${opts.sourceLabel}` : 'raw-privkey'
  }

  protected async loadPrivkey(): Promise<Hex> {
    return this.privkeyHex
  }
}
