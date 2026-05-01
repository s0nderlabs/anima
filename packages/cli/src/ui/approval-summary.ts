import type { PermissionRequest } from '@s0nderlabs/anima-core'
import { shortAddr } from '../util/format'

/**
 * Body line for the approval modal. Friendly text for value-moving onchain
 * kinds; falls back to command/path for shell.run / fs.write / code.execute.
 *
 * Why the `'→'` sniff in chain.send: chain.wrap and chain.unwrap reuse
 * `chain.send` as their permission kind but encode the operation in `token`
 * (`0G→W0G` / `W0G→0G`) and have no recipient to display.
 */
export function summarizeApprovalSubject(req: PermissionRequest): string {
  const amt = req.amount ?? ''
  const tok = req.token ?? ''
  switch (req.kind) {
    case 'chain.send': {
      if (tok.includes('→')) return `${amt} ${tok}`.trim()
      const tokenLabel = tok || '0G'
      return `send ${amt} ${tokenLabel} to ${shortAddr(req.recipient)}`
    }
    case 'chain.swap':
      if (!amt && !tok) return 'swap'
      return `swap ${amt} ${tok}`.trim()
    case 'chain.stake':
      if (!amt) return tok || 'stake operation'
      return `${amt} ${tok}`.trim()
    case 'chain.write': {
      const valuePart = amt ? ` (value: ${amt})` : ''
      return `${req.command ?? '?'}${valuePart} on ${shortAddr(req.recipient)}`
    }
    default:
      return req.command ?? req.path ?? '(unspecified)'
  }
}
