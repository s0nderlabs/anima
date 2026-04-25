/**
 * `<label>.anima.0g` subname validation.
 *
 * Rules locked Apr 23 2026 (project-anima.md section 33 + matches the
 * AnimaSubnameRegistrar contract's on-chain check):
 *   - 3-32 characters total
 *   - lowercase a-z, 0-9, hyphens
 *   - no leading or trailing hyphen
 *
 * Used by:
 *   - `anima init` wizard's subname prompt (cli/commands/init.ts)
 *   - any post-MVP CLI that lets the user reclaim or rename a subname
 */
export const SUBNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/

export interface SubnameValidation {
  ok: boolean
  reason?: string
}

export function validateSubnameLabel(label: string): SubnameValidation {
  if (label.length < 3) return { ok: false, reason: 'too short (min 3 chars)' }
  if (label.length > 32) return { ok: false, reason: 'too long (max 32 chars)' }
  if (label !== label.toLowerCase()) return { ok: false, reason: 'must be lowercase' }
  if (label.startsWith('-')) return { ok: false, reason: 'cannot start with hyphen' }
  if (label.endsWith('-')) return { ok: false, reason: 'cannot end with hyphen' }
  if (!SUBNAME_LABEL_RE.test(label)) {
    return { ok: false, reason: 'allowed chars: a-z, 0-9, hyphen' }
  }
  return { ok: true }
}
